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
  transcribeBatch?(pcm: Uint8Array, cfg: { apiKey: string; sampleRate?: number }): Promise<string>;
}
