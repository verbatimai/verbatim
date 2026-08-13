import WebSocket from "ws";
import type {
  STTProvider,
  STTSession,
  STTSessionConfig,
  TranscriptEvent,
} from "./types";
import { pcmToWav } from "../audio/wav";

// OpenAI Realtime transcription adapter.
//
// Unlike PyAI Hear (which emits stable_text/active_text natively), OpenAI streams
// incremental `...transcription.delta` chunks for the in-progress utterance and a
// single `...transcription.completed` with the full transcript. So we DERIVE the
// contract: accumulated deltas → `activeText` (volatile tail), and on `.completed`
// we emit a `final` carrying the whole utterance (`endpoint:true`). This is the
// same "interim/final-only vendor → our TranscriptEvent" mapping used for Deepgram.
//
// Transport: per docs/architecture/vendor-transport.md, the STT socket runs in the
// app-managed Node sidecar (a "secure backend"), so a raw Bearer key over the WS
// header is allowed — no ephemeral/WebRTC token needed here. OPENAI_REALTIME_WS_URL
// / OPENAI_STT_MODEL override the endpoint/model (tests, self-host, 4.7 dropdown).
//
// Audio: OpenAI Realtime wants 24 kHz mono pcm16 (vendor-apis.md §2), so this
// adapter DECLARES sampleRate 24000; the capture side feeds frames at the
// provider's declared rate. Frames are base64-framed into `input_audio_buffer.append`.
const DEFAULT_WS_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const DEFAULT_MODEL = "gpt-live-transcribe"; // streaming model (vendor-apis.md §2); post-turn is "gpt-transcribe"

export class OpenAiSTT implements STTProvider {
  readonly id = "openai";
  readonly requiredKeys = ["OPENAI_API_KEY"];
  readonly audio = { sampleRate: 24000, encoding: "pcm_s16le", channels: 1 } as const;

  async startSession(cfg: STTSessionConfig): Promise<STTSession> {
    const wsUrl = process.env.OPENAI_REALTIME_WS_URL ?? DEFAULT_WS_URL; // read at call time (testable)
    const model = process.env.OPENAI_STT_MODEL ?? DEFAULT_MODEL;
    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });
    return new OpenAiSession(ws, model, cfg.language);
  }

  // Batch transcription of a full clip -> one clean transcript (the authoritative
  // finalize path). POST /v1/audio/transcriptions (multipart), model gpt-transcribe
  // (Whisper-family). OPENAI_BASE / OPENAI_BATCH_MODEL override endpoint/model.
  async transcribeBatch(pcm: Uint8Array, cfg: { apiKey: string; sampleRate?: number }): Promise<string> {
    const base = process.env.OPENAI_BASE ?? "https://api.openai.com/v1";
    const model = process.env.OPENAI_BATCH_MODEL ?? "gpt-transcribe";
    const wav = pcmToWav(pcm, cfg.sampleRate ?? this.audio.sampleRate, 1);
    const form = new FormData();
    form.append("model", model);
    form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`OpenAI transcribe ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as any;
    return String(body.text ?? "").trim();
  }
}

class OpenAiSession implements STTSession {
  private tcb?: (e: TranscriptEvent) => void;
  private ecb?: (e: Error) => void;
  private ccb?: () => void;
  private active = ""; // accumulated deltas for the current utterance
  private uCounter = 0;
  private utteranceId = "u0";

  constructor(ws: WebSocket, model: string, language?: string) {
    this.ws = ws;
    ws.on("open", () => {
      // Configure the transcription session: pcm16 input + the chosen model +
      // server-side VAD so the server segments utterances for us.
      this.send({
        type: "transcription_session.update",
        session: {
          input_audio_format: "pcm16",
          input_audio_transcription: { model, ...(language ? { language } : {}) },
          turn_detection: { type: "server_vad" },
        },
      });
    });
    ws.on("message", (d) => this.onMessage(d.toString()));
    ws.on("error", (e) => this.ecb?.(e as Error));
    ws.on("close", () => this.ccb?.());
  }
  private ws: WebSocket;

  private send(obj: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private onMessage(raw: string) {
    if (process.env.OPENAI_STT_DEBUG) console.error("[openai-stt] " + raw);
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const t: string = m.type ?? "";
    if (t.endsWith("input_audio_transcription.delta")) {
      // Incremental chunk of the in-progress utterance → grows the active tail.
      this.active = (this.active + (m.delta ?? "")).replace(/\s+/g, " ");
      if (m.item_id) this.utteranceId = String(m.item_id);
      this.tcb?.({
        type: "partial",
        utteranceId: this.utteranceId,
        text: this.active.trim(),
        stableText: "",
        activeText: this.active.trim(),
      });
    } else if (t.endsWith("input_audio_transcription.completed")) {
      // The server finalized this utterance → one clean transcript.
      const text = String(m.transcript ?? this.active).trim();
      this.tcb?.({
        type: "final",
        utteranceId: m.item_id ? String(m.item_id) : this.utteranceId,
        text,
        stableText: text,
        activeText: "",
        endpoint: true,
      });
      this.active = "";
      this.utteranceId = `u${++this.uCounter}`;
    } else if (t === "error") {
      this.ecb?.(new Error(m.error?.message ?? "openai realtime error"));
    }
    // session.created / *.session.updated / speech_started|stopped / etc. are
    // control noise for the transcript and intentionally ignored.
  }

  sendAudio(frame: ArrayBufferView | ArrayBuffer) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    // OpenAI Realtime takes base64 pcm16 in an input_audio_buffer.append event.
    const buf =
      frame instanceof ArrayBuffer
        ? Buffer.from(frame)
        : Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    this.send({ type: "input_audio_buffer.append", audio: buf.toString("base64") });
  }

  async finalize() {
    // With server_vad the buffer auto-commits on silence; committing explicitly
    // flushes any trailing audio so the last utterance finalizes promptly.
    this.send({ type: "input_audio_buffer.commit" });
    await new Promise((r) => setTimeout(r, 300));
    this.close();
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
  onTranscript(cb: (e: TranscriptEvent) => void) { this.tcb = cb; }
  onError(cb: (e: Error) => void) { this.ecb = cb; }
  onClose(cb: () => void) { this.ccb = cb; }
}
