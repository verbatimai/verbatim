import type { TtsProvider, TtsResult } from "./types";
import { fetchWithRetry } from "../net/retry";

// PyAI text-to-speech adapter.
//
// ⚠ [verify] UNCONFIRMED ENDPOINT. PyAI's STT (`/v1/audio/transcriptions*`, decoded from
// the live API — see providers/pyai.stt.ts) and correction (`/v1/messages`) endpoints
// were confirmed by probing the live API (docs/architecture/vendor-apis.md). PyAI's TTS
// surface has NOT been probed yet. This adapter assumes the same OpenAI-mirroring shape
// PyAI's other confirmed endpoints follow: `POST /v1/audio/speech` with
// `{model, input, voice, response_format}`, same Bearer auth as correction/STT-batch.
// `pyai-speak` is a PLACEHOLDER model id, not a confirmed one. VERIFY on the Mac (a probe
// script, same pattern as `experiments/scripts/probe_hear_caps.py`) before relying on
// this in production — if the real shape differs, only this file changes (the
// TtsProvider interface + registry are unaffected). PYAI_BASE / PYAI_TTS_MODEL /
// PYAI_TTS_VOICE override the endpoint/model/voice (tests, self-host).
export class PyAiTts implements TtsProvider {
  readonly id = "pyai";
  readonly requiredKeys = ["PYAI_API_KEY"];

  constructor(private apiKey = process.env.PYAI_API_KEY ?? "") {}

  async synthesize(text: string, opts?: { voice?: string; model?: string }): Promise<TtsResult> {
    const base = process.env.PYAI_BASE ?? "https://api.pyai.com/v1"; // read at call time (testable)
    const model = (opts?.model && opts.model.trim()) ? opts.model : (process.env.PYAI_TTS_MODEL ?? "pyai-speak");
    const voice = (opts?.voice && opts.voice.trim()) ? opts.voice : (process.env.PYAI_TTS_VOICE ?? "alloy");
    const res = await fetchWithRetry(
      `${base}/audio/speech`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: text, voice, response_format: "mp3" }),
      },
      { label: "PyAI speak" },
    );
    const audio = new Uint8Array(await res.arrayBuffer());
    return { audio, mime: "audio/mpeg" };
  }
}
