export type EditReason =
  | "filler"
  | "false_start"
  | "self_correction"
  | "repetition"
  | "grammar";

/** Compact edit emitted by the LLM: only the changed spans, no echoed keeps. */
export interface CorrectionEdit {
  raw: string;          // exact substring of the raw transcript to change
  replacement: string;  // "" = delete
  reason: EditReason;
}

/** Rebuilt op timeline for the UI (keep/remove/replace), derived locally. */
export interface Op {
  type: "keep" | "remove" | "replace";
  text: string;
  replacement?: string;
  reason?: EditReason;
}

export interface CorrectionResult {
  cleanText: string;
  edits: CorrectionEdit[];
  ops: Op[];
  latencyMs: number;
  valid: boolean; // did edits reconstruct cleanText? (else fall back to local diff)
}

export interface CorrectionContext {
  /** Recently committed clean text, for cross-segment coherence. */
  priorContext?: string;
  /** BCP-47 / ISO-639-1 tag of the transcript's language (default "en"). */
  language?: string;
}

export interface CorrectionProvider {
  readonly id: string;
  readonly requiredKeys: string[];
  /** Incremental cleanup of one chunk -> compact edits + clean text (drives the live diff). */
  correct(rawSegment: string, ctx?: CorrectionContext): Promise<CorrectionResult>;
  /**
   * Whole-text formatting pass (grammar, punctuation, capitalization, and
   * structure like lists/paragraphs). This is a rewrite, not a diff, and runs
   * once on finalize to produce the polished output that gets inserted.
   * `language` (BCP-47) tells non-English transcripts to stay untranslated.
   */
  format?(text: string, language?: string): Promise<{ text: string }>;
}
