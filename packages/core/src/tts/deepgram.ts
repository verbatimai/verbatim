import type { TtsProvider, TtsResult } from "./types";
import { fetchWithRetry } from "../net/retry";

// Deepgram Aura text-to-speech adapter — Deepgram's "Speak" REST API.
// POST /v1/speak?model=<voice>, header Authorization: Token <key>, body {text}. The
// response body IS the audio (default mp3/audio-mpeg unless different encoding/
// container query params are requested) — we keep the default since the widget just
// plays it back via an <audio> element (see apps/widget/src/main.ts's playWakeGreeting).
// DEEPGRAM_BASE / DEEPGRAM_TTS_MODEL override the endpoint/voice (tests, self-host).
export class DeepgramTts implements TtsProvider {
  readonly id = "deepgram";
  readonly requiredKeys = ["DEEPGRAM_API_KEY"];

  constructor(private apiKey = process.env.DEEPGRAM_API_KEY ?? "") {}

  async synthesize(text: string, opts?: { voice?: string; model?: string }): Promise<TtsResult> {
    const base = process.env.DEEPGRAM_BASE ?? "https://api.deepgram.com/v1"; // read at call time (testable)
    const voice =
      (opts?.model && opts.model.trim()) ||
      (opts?.voice && opts.voice.trim()) ||
      (process.env.DEEPGRAM_TTS_MODEL ?? "aura-2-thalia-en");
    const res = await fetchWithRetry(
      `${base}/speak?model=${encodeURIComponent(voice)}`,
      {
        method: "POST",
        headers: { Authorization: `Token ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      },
      { label: "Deepgram speak" },
    );
    const audio = new Uint8Array(await res.arrayBuffer());
    const mime = res.headers.get("content-type") || "audio/mpeg";
    return { audio, mime };
  }
}
