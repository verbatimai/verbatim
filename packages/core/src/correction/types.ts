import type { FormatMode } from "./prompt";

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
  /**
   * 3.4 — custom vocabulary terms (proper nouns, jargon, spellings) to preserve.
   * Injected primarily into the FORMAT prompt (where re-spelling is permitted); the
   * correction pass forbids wording changes, so it's a harmless extra there.
   */
  vocabulary?: string[];
  /**
   * Phase 7 — per-request correction model override from the Settings "Models" pane.
   * Empty string / whitespace / undefined ⇒ use the adapter's env var then its default
   * (empty never overrides). OpenAI + Anthropic honour it; PyAI SENDS it on the wire for
   * uniform threading, but its server ignores the field (findings F4) — the answer is
   * always gpt-5.6-sol, a documented no-op.
   */
  model?: string;
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
   * `vocabulary` (3.4) is the custom-term list to preserve/spell exactly — this is
   * the effective prompt-side lever for OpenAI/PyAI (the correction pass can't re-spell).
   */
  format?(text: string, language?: string, vocabulary?: string[], model?: string, mode?: FormatMode): Promise<{ text: string }>;
  /**
   * Platform P1c — apply a free-form spoken INSTRUCTION to a piece of text (the field's
   * current selection, read via command mode), e.g. "make this more formal" / "make that
   * shorter". Unlike correct()/format(), the transformation itself is open-ended — there is
   * no fixed prompt, no compact-edits reconstruction, and no validate() step; the model's
   * output text is trusted directly, same trust level as format()'s whole-text rewrite.
   * `model` mirrors the other passes' per-request override (empty/undefined -> adapter default).
   */
  rewrite?(text: string, instruction: string, model?: string): Promise<{ text: string }>;
}
