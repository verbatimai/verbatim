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
  async transcribeBatch(pcm: Uint8Array, cfg: { apiKey: string; sampleRate?: number }): Promise<string> {
    const base = process.env.PYAI_BASE ?? "https://api.pyai.com/v1";
    const wav = pcmToWav(pcm, cfg.sampleRate ?? this.audio.sampleRate, 1);
    const form = new FormData();
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
      this.tcb?.({
        type: m.type === "transcript.final" ? "final" : "partial",
        utteranceId: m.utterance_id,
        text: m.text ?? "",
        stableText: m.stable_text ?? "",
        activeText: m.active_text ?? "",
        tMs: m.t_ms,
      });
    } else if (m.type === "error") {
      this.ecb?.(new Error(m.error?.message ?? "pyai stream error"));
    }
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
