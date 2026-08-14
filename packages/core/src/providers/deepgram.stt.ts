import WebSocket from "ws";
import type {
  STTProvider,
  STTSession,
  STTSessionConfig,
  TranscriptEvent,
} from "./types";
import { pcmToWav } from "../audio/wav";
import { fetchWithRetry } from "../net/retry";

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
    // Phase 7 — per-session model override wins; empty/whitespace never overrides
    // (falls through to env then the default). Deepgram uses this on streaming AND batch.
    const model = (cfg.model && cfg.model.trim()) ? cfg.model : (process.env.DEEPGRAM_STT_MODEL ?? DEFAULT_MODEL);
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
    // 3.2 — language on the STREAMING socket. Deepgram does NOT support
    // `detect_language` on streaming — it 400s the handshake (docs: "Language
    // Detection is not currently supported for streaming"). For multilingual live
    // audio Deepgram's guidance is the multilingual models via `language=multi`
    // (best on nova-3; nova-2 multi is es/en only). The AUTHORITATIVE final comes
    // from transcribeBatch() below, which uses real detect_language, so an imperfect
    // multi live-preview is acceptable. Off = today's fixed language.
    if (cfg.detectLanguage) {
      q.set("language", "multi");
    } else if (cfg.language) {
      q.set("language", cfg.language);
    }
    // 3.4 — STT-side keyword boost. The param name depends on the RESOLVED model:
    // nova-2 uses `keywords` (repeatable `keywords=term:intensity`), nova-3 uses
    // `keyterm`. Getting this wrong is a silent no-op, so we branch on `model`.
    if (cfg.keywords && cfg.keywords.length) {
      const param = /nova-3/i.test(model) ? "keyterm" : "keywords";
      for (const term of cfg.keywords) {
        const t = term.trim();
        if (t) q.append(param, t);
      }
    }
    const ws = new WebSocket(`${base}?${q.toString()}`, {
      headers: { Authorization: `Token ${cfg.apiKey}` },
    });
    return new DeepgramSession(ws);
  }

  // Batch transcription of a full clip → one clean transcript (the authoritative
  // finalize path, parity with PyAI/OpenAI). Deepgram prerecorded: POST /v1/listen
  // with the WAV body. DEEPGRAM_BASE / DEEPGRAM_STT_MODEL override endpoint/model.
  async transcribeBatch(pcm: Uint8Array, cfg: { apiKey: string; sampleRate?: number; language?: string; detectLanguage?: boolean; model?: string; keywords?: string[] }): Promise<string> {
    const base = process.env.DEEPGRAM_BASE ?? "https://api.deepgram.com/v1";
    // Phase 7 — same prefer-cfg model resolution as streaming (empty never overrides).
    const model = (cfg.model && cfg.model.trim()) ? cfg.model : (process.env.DEEPGRAM_STT_MODEL ?? DEFAULT_MODEL);
    const wav = pcmToWav(pcm, cfg.sampleRate ?? this.audio.sampleRate, 1);
    const q = new URLSearchParams({ model, smart_format: "true", punctuate: "true" });
    // 3.2 — this is the AUTHORITATIVE final path, so language MUST apply here or
    // non-English dictation silently returns English. Pre-recorded DOES support
    // detect_language (unlike streaming): auto-detect -> detect_language=true;
    // otherwise pin the chosen language (default "en").
    if (cfg.detectLanguage) {
      q.set("detect_language", "true");
    } else if (cfg.language) {
      q.set("language", cfg.language);
    }
    // Fix 2 (Phase 7) — apply the SAME STT-side keyword boost as streaming on the
    // AUTHORITATIVE batch path (the inserted text = batch output). Deepgram's
    // prerecorded /v1/listen supports both `keywords` (nova-2) and `keyterm` (nova-3);
    // branch on the resolved model exactly like the streaming socket does.
    if (cfg.keywords && cfg.keywords.length) {
      const param = /nova-3/i.test(model) ? "keyterm" : "keywords";
      for (const term of cfg.keywords) {
        const t = term.trim();
        if (t) q.append(param, t);
      }
    }
    // 5.1 — retry transient 5xx/429/network on the AUTHORITATIVE batch path.
    const res = await fetchWithRetry(`${base}/listen?${q.toString()}`, {
      method: "POST",
      headers: { Authorization: `Token ${cfg.apiKey}`, "Content-Type": "audio/wav" },
      body: wav,
    }, { label: "Deepgram transcribe" });
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
  // 5.1 — Deepgram closes an idle socket after ~10s of no audio (m4.4-deepgram-plan.md).
  // A periodic KeepAlive during silence keeps the live preview socket open across pauses.
  private keepAlive?: ReturnType<typeof setInterval>;
  // Set the instant close()/finalize() asks the underlying ws to close while it may
  // still be CONNECTING (e.g. an instant start→stop, or a slow vendor handshake).
  // The `ws` library's own close() aborts the handshake in that case and emits this
  // EXACT benign message as an 'error' — it's a side effect of a close WE requested,
  // not a real stream failure, so don't let it reach onError() as a terminal STT error.
  private closingBeforeOpen = false;

  constructor(private ws: WebSocket) {
    ws.on("message", (d) => this.onMessage(d.toString()));
    ws.on("error", (e) => {
      if (this.closingBeforeOpen && /closed before the connection was established/i.test((e as Error).message)) return;
      this.ecb?.(e as Error);
    });
    ws.on("close", () => { this.stopKeepAlive(); this.ccb?.(); });
    this.keepAlive = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "KeepAlive" }));
    }, 5000);
    if (typeof this.keepAlive?.unref === "function") this.keepAlive.unref(); // never hold the event loop open
  }

  private stopKeepAlive() {
    if (this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = undefined; }
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
    this.stopKeepAlive();
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "Finalize" })); // flush pending audio → last final
    }
    await new Promise((r) => setTimeout(r, 200));
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "CloseStream" })); // then close the stream
    }
  }

  close() {
    this.stopKeepAlive();
    if (this.ws.readyState === WebSocket.CONNECTING) this.closingBeforeOpen = true;
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
