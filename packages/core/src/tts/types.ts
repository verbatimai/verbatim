// Verbatim — TTS (text-to-speech) provider interface.
//
// A DISTINCT capability from STT (audio -> text, providers/types.ts) and correction
// (text -> text, correction/types.ts): TTS converts text -> audio. It gets its OWN
// vendor-agnostic role/registry (mirrors STTProvider/CorrectionProvider) rather than
// being folded into the correction provider — "which vendor cleans up your transcript"
// and "which vendor can speak back to you" are independent choices, even though today's
// default (PyAI) happens to offer STT + TTS both.
//
// First consumer: the P3 wake-word listener's spoken greeting (hardcoded phrase for
// now) — see apps/backend/src/server.ts's "speak" WS message and
// apps/widget/src/main.ts's playWakeGreeting(). Nothing here is greeting-specific; any
// text can be synthesized.
export interface TtsResult {
  /** Raw audio bytes (NOT base64 — callers encode for wire transport as needed). */
  audio: Uint8Array;
  /** MIME type of `audio`, e.g. "audio/mpeg" (mp3) or "audio/wav". */
  mime: string;
}

export interface TtsProvider {
  readonly id: string;
  /** Env var name(s) this provider needs (mirrors STTProvider/CorrectionProvider). */
  readonly requiredKeys: string[];
  /**
   * Synthesize speech for `text`. `voice`/`model` are optional per-vendor overrides;
   * omitted → adapter default.
   */
  synthesize(text: string, opts?: { voice?: string; model?: string }): Promise<TtsResult>;
}
