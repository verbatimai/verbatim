import type { CorrectionEdit, Op } from "./types";

// Shared across every correction adapter — the vendor only maps this to its own
// chat wire format. This is the "compact edits-only" format (plan §4) that keeps
// output tokens (and therefore latency) low.
export const SYSTEM_PROMPT = `You remove speech disfluencies from a dictation transcript. This is a MINIMAL cleanup, not a rewrite.

ONLY remove or fix:
- filler words (um, uh, ahh, er, like);
- false starts and stutters/repetitions ("the the" -> "the");
- self-corrections — keep only the final intended value ("8pm no no make it 9pm" -> "9pm").

DO NOT add or change punctuation, capitalization, spacing, or wording. DO NOT rephrase, reorder, or "improve" grammar. Those happen in a separate formatting step. If the transcript has no disfluencies, return an EMPTY edits array.

Return ONLY the edits you make — never echo unchanged text.
Output ONLY JSON: {"clean_text":"<transcript with only the above removals applied>","edits":[{"raw":"<exact contiguous substring of the transcript>","replacement":"<usually empty to delete; a short value only for a self-correction>","reason":"filler|false_start|self_correction|repetition"}]}
Each "raw" MUST be an exact substring of the transcript, and edits listed in order of appearance.`;

// Whole-text formatting pass (runs once on finalize). Turns cleaned dictation
// into polished written text WITH structure the speaker implied.
export const FORMAT_PROMPT = `You format a cleaned dictation transcript into polished written text. You may:
- fix grammar, punctuation, and capitalization;
- turn spoken enumerations into lists — e.g. "two things to do one shopping and two swimming" becomes a short lead-in ("I have two things to do:") followed by a numbered list ("1. Shopping" / "2. Swimming");
- use "-" bullets for unordered lists, and paragraph breaks where the speaker clearly changes topic;
- capitalize list items and sentence starts.
Do NOT add new information, opinions, or content the speaker didn't say, and do not change meaning. Preserve the speaker's words.
Return ONLY the formatted text as plain text with real newlines (no markdown code fences, no commentary).`;

export function formatMessage(text: string): string {
  return `Cleaned transcript to format:\n${text}`;
}

export function userMessage(raw: string, priorContext?: string): string {
  const ctx = priorContext ? `Prior context (already cleaned): ${priorContext}\n\n` : "";
  return `${ctx}Raw transcript:\n${raw}`;
}

/** Extract the first JSON object from an LLM text response. */
export function parseJson(text: string): { clean_text?: string; edits?: CorrectionEdit[] } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Apply compact edits left-to-right by locating each literal substring, and
 * return both the rebuilt clean text and the keep/remove/replace op timeline
 * the UI animates. Mirrors test_correction_compact.py's apply_compact().
 */
export function reconstruct(raw: string, edits: CorrectionEdit[]): { cleanText: string; ops: Op[] } {
  const ops: Op[] = [];
  const out: string[] = [];
  let cur = 0;
  for (const e of edits) {
    if (!e.raw) continue;
    const idx = raw.indexOf(e.raw, cur);
    if (idx < 0) continue; // model drift — skip; validation will catch it
    if (idx > cur) {
      const keep = raw.slice(cur, idx);
      ops.push({ type: "keep", text: keep });
      out.push(keep);
    }
    const rep = e.replacement ?? "";
    ops.push({
      type: rep ? "replace" : "remove",
      text: e.raw,
      replacement: rep || undefined,
      reason: e.reason,
    });
    out.push(rep);
    cur = idx + e.raw.length;
  }
  if (cur < raw.length) {
    const keep = raw.slice(cur);
    ops.push({ type: "keep", text: keep });
    out.push(keep);
  }
  return { cleanText: out.join(""), ops };
}

/** True if the edits reconstruct the model's own clean_text. */
export function validate(rebuilt: string, cleanText: string): boolean {
  return norm(rebuilt) === norm(cleanText);
}
