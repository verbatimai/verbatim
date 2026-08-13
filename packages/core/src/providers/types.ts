// Vendor-neutral streaming speech-to-text contract.
// Every vendor (PyAI, Deepgram, OpenAI, ...) is an adapter behind these types.
// Nothing above this file may reference a vendor-specific detail.

export interface AudioFormat {
  sampleRate: number; // e.g. 16000
  encoding: "pcm_s16le";
  channels: 1;
}

/** A normalized transcript update. The stable/active split is the UI contract. */
export interface TranscriptEvent {
  type: "partial" | "final";
  utteranceId: string;
  /** Full best hypothesis for the current utterance. */
  text: string;
  /** Locked prefix that will not change — render solid. */
  stableText: string;
  /** Volatile tail still being revised — render dim. */
  activeText: string;
  /** Provider signalled end-of-utterance (VAD), if available. */
  endpoint?: boolean;
  /** Milliseconds since session start, if the provider reports it. */
  tMs?: number;
}

export interface STTSession {
  /** Push one audio frame (PCM matching the provider's AudioFormat). */
  sendAudio(frame: ArrayBufferView | ArrayBuffer): void;
  /** Flush the current utterance and ask for a final transcript. */
  finalize(): Promise<void>;
  close(): void;
  onTranscript(cb: (e: TranscriptEvent) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: () => void): void;
}

export interface STTSessionConfig {
  apiKey: string;
  language?: string;
  /**
   * 3.2 — ask the STT vendor to auto-detect the spoken language instead of using a
   * fixed `language`. Vendor-specific and PATH-specific: Deepgram cannot detect on
   * the STREAMING socket (detect_language is prerecorded-only and 400s on streaming),
   * so streaming uses the multilingual `language=multi` model; the BATCH finalize
   * path uses `detect_language=true`. OpenAI omits the `language` field on both paths
   * (Whisper auto-detects). PyAI Hear ignores it (English-only). Default = fixed lang.
   */
  detectLanguage?: boolean;
  /**
   * 3.4 — custom vocabulary terms for STT-side keyword boost. Deepgram-only consumer
   * (`keywords` on nova-2 / `keyterm` on nova-3); OpenAI Realtime and PyAI Hear have
   * no equivalent param, so this is ignored by those adapters.
   */
  keywords?: string[];
  /**
   * Phase 7 — per-session STT model override from the Settings "Models" pane. Empty
   * string / whitespace / undefined ⇒ use the adapter's env var then its hardcoded
   * default (never let an empty value override). Deepgram uses it on streaming AND
   * batch; OpenAI uses it on STREAMING only (batch keeps OPENAI_BATCH_MODEL — a
   * streaming-only model name would 400 the batch endpoint); PyAI Hear ignores it
   * (single model, pyai-hear).
   */
  model?: string;
}

export interface STTProvider {
  readonly id: string; // 'pyai' | 'deepgram' | 'openai'
  /** Env/keychain names this provider needs (BYOK). */
  readonly requiredKeys: string[];
  readonly audio: AudioFormat;
  startSession(cfg: STTSessionConfig): Promise<STTSession>;
  /**
   * Batch-transcribe a full PCM clip → one clean transcript. Used on finalize so
   * the authoritative result doesn't depend on reconstructing the live stream.
   */
  transcribeBatch?(pcm: Uint8Array, cfg: { apiKey: string; sampleRate?: number; language?: string; detectLanguage?: boolean; model?: string; keywords?: string[] }): Promise<string>;
}
