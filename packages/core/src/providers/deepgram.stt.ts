import WebSocket from "ws";
import type {
  STTProvider,
  STTSession,
  STTSessionConfig,
  TranscriptEvent,
} from "./types";
import { pcmToWav } from "../audio/wav";

// Deepgram streaming adapter.
//
// Deepgram sends interim + is_final results but NOT a stable/active split, so we
// derive it: everything from finalized (`is_final`) results is `stableText`; the
// current interim tail is `activeText`. A segment closes on EITHER an endpointing
// `speech_final` (a Results message once `endpointing` ms of silence pass) OR the
// gap-based `UtteranceEnd` message (`utterance_end_ms`). We emit exactly one `final`
// per segment (de-duplicated), matching how any interim/final-only vendor maps onto
// our TranscriptEvent contract (same approach as the OpenAI adapter).
//
// Transport: per docs/architecture/vendor-transport.md, the STT socket runs in the
// app-managed Node sidecar (a "secure backend"), so a raw key over the WS header is
// fine — no webview/subprotocol token needed. DEEPGRAM_WS_URL / DEEPGRAM_STT_MODEL /
// DEEPGRAM_BASE override endpoint/model (tests, self-host, the 4.7 model dropdown).
const DEFAULT_WS_URL = "wss://api.deepgram.com/v1/listen";
const DEFAULT_MODEL = "nova-2"; // vendor-apis.md; env-overridable

export class DeepgramSTT implements STTProvider {
  readonly id = "deepgram";
  readonly requiredKeys = ["DEEPGRAM_API_KEY"];
  readonly audio = { sampleRate: 16000, encoding: "pcm_s16le", channels: 1 } as const;

  async startSession(cfg: STTSessionConfig): Promise<STTSession> {
    const base = process.env.DEEPGRAM_WS_URL ?? DEFAULT_WS_URL; // read at call time (testable)
    const model = process.env.DEEPGRAM_STT_MODEL ?? DEFAULT_MODEL;
    const q = new URLSearchParams({
      model,
      encoding: "linear16",
      sample_rate: String(this.audio.sampleRate),
      channels: "1",
      interim_results: "true", // required for utterance_end_ms to work
      vad_events: "true",
      smart_format: "true",
      punctuate: "true",
      endpointing: "300", // ms of silence → speech_final on the Results message
      utterance_end_ms: "1000", // gap → a separate UtteranceEnd message
    });
    if (cfg.language) q.set("language", cfg.language);
    const ws = new WebSocket(`${base}?${q.toString()}`, {
      headers: { Authorization: `Token ${cfg.apiKey}` },
    });
    return new DeepgramSession(ws);
  }

  // Batch transcription of a full clip → one clean transcript (the authoritative
  // finalize path, parity with PyAI/OpenAI). Deepgram prerecorded: POST /v1/listen
  // with the WAV body. DEEPGRAM_BASE / DEEPGRAM_STT_MODEL override endpoint/model.
  async transcribeBatch(pcm: Uint8Array, cfg: { apiKey: string; sampleRate?: number }): Promise<string> {
    const base = process.env.DEEPGRAM_BASE ?? "https://api.deepgram.com/v1";
    const model = process.env.DEEPGRAM_STT_MODEL ?? DEFAULT_MODEL;
    const wav = pcmToWav(pcm, cfg.sampleRate ?? this.audio.sampleRate, 1);
    const q = new URLSearchParams({ model, smart_format: "true", punctuate: "true" });
    const res = await fetch(`${base}/listen?${q.toString()}`, {
      method: "POST",
      headers: { Authorization: `Token ${cfg.apiKey}`, "Content-Type": "audio/wav" },
      body: wav,
    });
    if (!res.ok) throw new Error(`Deepgram transcribe ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as any;
    return String(
      body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "",
    ).trim();
  }
}

class DeepgramSession implements STTSession {
  private tcb?: (e: TranscriptEvent) => void;
  private ecb?: (e: Error) => void;
  private ccb?: () => void;
  private stable = ""; // accumulated finalized text (current utterance)
  private utteranceId = "u0";
  private uCounter = 0;
  private finalizedThisSegment = false; // dedup guard for speech_final + UtteranceEnd

  constructor(private ws: WebSocket) {
    ws.on("message", (d) => this.onMessage(d.toString()));
    ws.on("error", (e) => this.ecb?.(e as Error));
    ws.on("close", () => this.ccb?.());
  }

  // Close the current segment once: emit a single `final` with endpoint:true, then
  // reset. Whichever of speech_final / UtteranceEnd arrives second is a no-op.
  private closeSegment() {
    if (this.finalizedThisSegment) return;
    const text = this.stable.trim();
    if (!text) return; // nothing captured yet — don't emit an empty final
    this.tcb?.({
      type: "final",
      utteranceId: this.utteranceId,
      text,
      stableText: text,
      activeText: "",
      endpoint: true,
    });
    this.stable = "";
    this.finalizedThisSegment = true;
    this.utteranceId = `u${++this.uCounter}`;
  }

  private onMessage(raw: string) {
    if (process.env.DEEPGRAM_STT_DEBUG) console.error("[deepgram-stt] " + raw);
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }

    if (m.type === "UtteranceEnd") {
      this.closeSegment();
      return;
    }
    if (m.type && m.type !== "Results") return; // ignore Metadata/SpeechStarted/etc.

    const alt = m.channel?.alternatives?.[0];
    if (!alt) return;
    const piece = alt.transcript ?? "";

    if (m.is_final) {
      if (piece) {
        this.stable = (this.stable + " " + piece).trim();
        this.finalizedThisSegment = false; // new content since any prior close
      }
      this.emitPartial(""); // lock the interim into stable (active cleared)
      if (m.speech_final) this.closeSegment(); // endpointing boundary
    } else {
      if (piece) this.finalizedThisSegment = false;
      this.emitPartial(piece); // interim tail = active
    }
  }

  private emitPartial(active: string) {
    const stable = this.stable;
    this.tcb?.({
      type: "partial",
      utteranceId: this.utteranceId,
      text: (stable + " " + active).trim(),
      stableText: stable,
      activeText: active,
    });
  }

  sendAudio(frame: ArrayBufferView | ArrayBuffer) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame as Buffer);
  }

  async finalize() {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "Finalize" })); // flush pending audio → last final
    }
    await new Promise((r) => setTimeout(r, 200));
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "CloseStream" })); // then close the stream
    }
  }

  close() {
    if (
      this.ws.readyState === WebSocket.OPEN ||
      this.ws.readyState === WebSocket.CONNECTING
    ) {
      this.ws.close();
    }
  }
  onTranscript(cb: (e: TranscriptEvent) => void) { this.tcb = cb; }
  onError(cb: (e: Error) => void) { this.ecb = cb; }
  onClose(cb: () => void) { this.ccb = cb; }
}
