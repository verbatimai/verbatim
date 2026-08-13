import WebSocket from "ws";
import type {
  STTProvider,
  STTSession,
  STTSessionConfig,
  TranscriptEvent,
} from "./types";
import { pcmToWav } from "../audio/wav";

// PyAI Hear streaming adapter.
// Endpoint (decoded from the live API): GET /v1/audio/transcriptions/stream.
// PyAI emits stable_text / active_text natively, so normalization is a direct map.
// PYAI_STT_WS_URL overrides the endpoint (used by integration tests / self-host).
const DEFAULT_WS_URL = "wss://api.pyai.com/v1/audio/transcriptions/stream";

export class PyAiSTT implements STTProvider {
  readonly id = "pyai";
  readonly requiredKeys = ["PYAI_API_KEY"];
  readonly audio = { sampleRate: 16000, encoding: "pcm_s16le", channels: 1 } as const;

  async startSession(cfg: STTSessionConfig): Promise<STTSession> {
    // 3.2/3.4 — Hear is English-only and has no keyword-boost param, so `cfg.language`,
    // `cfg.detectLanguage`, and `cfg.keywords` are intentionally ignored here (the URL
    // below is identical with or without them). Auto-detect stays guarded at the
    // capability layer (PyAI-English-only warning still fires).
    // Phase 7 — `cfg.model` is likewise IGNORED: Hear is single-model, so the URL below
    // always hardcodes model=pyai-hear regardless of any Settings model override.
    const wsUrl = process.env.PYAI_STT_WS_URL ?? DEFAULT_WS_URL; // read at call time (testable)
    const sep = wsUrl.includes("?") ? "&" : "?";
    const url =
      `${wsUrl}${sep}model=pyai-hear&sample_rate=${this.audio.sampleRate}` +
      `&encoding=pcm_s16le&channels=1`;
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    return new PyAiSession(ws);
  }

  // Batch transcription of a full clip -> one clean transcript (the authoritative
  // final result; avoids reconstructing the live stream). POST /v1/audio/transcriptions.
  async transcribeBatch(pcm: Uint8Array, cfg: { apiKey: string; sampleRate?: number; language?: string; detectLanguage?: boolean; model?: string; keywords?: string[] }): Promise<string> {
    const base = process.env.PYAI_BASE ?? "https://api.pyai.com/v1";
    const wav = pcmToWav(pcm, cfg.sampleRate ?? this.audio.sampleRate, 1);
    const form = new FormData();
    // Phase 7 — single-model: `cfg.model` is a documented no-op here (always pyai-hear).
    form.append("model", "pyai-hear");
    form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`PyAI transcribe ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as any;
    return String(body.text ?? "").trim();
  }
}

class PyAiSession implements STTSession {
  private tcb?: (e: TranscriptEvent) => void;
  private ecb?: (e: Error) => void;
  private ccb?: () => void;

  constructor(private ws: WebSocket) {
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("error", (e) => this.ecb?.(e as Error));
    ws.on("close", () => this.ccb?.());
  }

  private onMessage(raw: string) {
    if (process.env.PYAI_STT_DEBUG) console.error("[hear] " + raw); // capture the real stream for test fixtures
    const m = JSON.parse(raw);
    if (m.type === "transcript.partial" || m.type === "transcript.final") {
      const isFinal = m.type === "transcript.final";
      this.tcb?.({
        type: isFinal ? "final" : "partial",
        utteranceId: m.utterance_id,
        // `text` is the full per-utterance hypothesis. On finals Hear also sends
        // `raw_text`; fall back to it so a final is never dropped as empty.
        text: m.text ?? m.raw_text ?? "",
        stableText: m.stable_text ?? "",
        activeText: m.active_text ?? "",
        endpoint: isFinal || Boolean(m.endpoint_reason) || undefined,
        tMs: m.t_ms,
      });
    } else if (m.type === "error") {
      this.ecb?.(new Error(m.error?.message ?? "pyai stream error"));
    }
    // Everything else (session.created, usage.delta, keep-alives, ...) is noise
    // for the transcript and is intentionally ignored.
  }

  sendAudio(frame: ArrayBufferView | ArrayBuffer) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame as Buffer);
  }

  async finalize() {
    // Finding F10: PyAI Hear rejects invented control frames (`stop`, `finalize`
    // both return "unknown type"). It appears to have NO client control message —
    // you stop sending audio and close the socket. So by default we send nothing.
    // If a real flush message is ever confirmed, set PYAI_STT_END_MESSAGE to the
    // exact JSON (e.g. '{"type":"input_audio.end"}') and it will be sent here.
    const endMsg = process.env.PYAI_STT_END_MESSAGE;
    if (endMsg && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(endMsg);
    }
    // Give the server a beat to emit any trailing final, then close so the
    // pipeline can flush the last segment promptly (instead of waiting out a timeout).
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
