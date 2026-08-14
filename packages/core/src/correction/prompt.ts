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
If the user glossary maps a spoken phrase to a symbol (e.g. "at the rate" → @), keep the symbol — do NOT expand symbols back into words.
Return ONLY the formatted text as plain text with real newlines (no markdown code fences, no commentary).`;

// 5.3 — Punctuation / formatting modes. One size doesn't fit chat, prose, and code.
// `prose` is today's behaviour; `message` is a light casual touch; `code` preserves
// casing/symbols; `raw` skips the format pass entirely (handled by the caller, which
// simply doesn't call format() — so there is no `raw` prompt here).
export type FormatMode = "prose" | "message" | "code" | "raw";

// The `message` variant: keep it casual, minimal restructuring, no lists.
const FORMAT_PROMPT_MESSAGE = `You lightly clean up a cleaned dictation transcript for a casual message (chat, DM, email). Fix obvious punctuation and capitalization and remove any leftover disfluency, but keep it casual and conversational — do NOT formalize the wording, restructure sentences, or turn anything into lists. Keep it short and natural, as if the speaker had typed it themselves. Do NOT add new information, opinions, or content the speaker didn't say, and do not change meaning. Return ONLY the text as plain text with real newlines (no markdown code fences, no commentary).`;

// The `code` variant: preserve casing/symbols/identifiers; no auto-capitalization or
// sentence punctuation; convert only unambiguous spoken tokens.
const FORMAT_PROMPT_CODE = `You format a cleaned dictation transcript that is meant as code, an identifier, or technical input. Preserve casing, symbols, operators, and identifiers EXACTLY (e.g. myVar, snake_case, foo(), ===). Do NOT auto-capitalize words, do NOT add sentence punctuation, and do NOT rephrase or restructure. Convert obvious spoken tokens ONLY when unambiguous (e.g. "open paren"/"close paren" -> "()", "dot" -> ".", "equals equals" -> "=="); otherwise leave words as-is. Do NOT add new information or change meaning. Return ONLY the resulting text as plain text (no markdown code fences, no commentary).`;

/**
 * The system prompt for the formatting pass, per mode. `prose` is the existing
 * FORMAT_PROMPT (byte-identical, so prompt.test.ts stays green); an unknown/undefined
 * mode falls back to prose. `raw` is never routed here — the caller skips format().
 */
export const FORMAT_PROMPTS: Record<Exclude<FormatMode, "raw">, string> = {
  prose: FORMAT_PROMPT,
  message: FORMAT_PROMPT_MESSAGE,
  code: FORMAT_PROMPT_CODE,
};

export function formatPromptFor(mode?: FormatMode): string {
  return mode && mode !== "raw" && FORMAT_PROMPTS[mode] ? FORMAT_PROMPTS[mode] : FORMAT_PROMPTS.prose;
}

/** True for "en" and any English region tag ("en-US", "en-GB", …), or unset. */
function isEnglish(language?: string): boolean {
  const l = (language || "en").toLowerCase();
  return l === "en" || l.startsWith("en-") || l.startsWith("en_");
}

/**
 * Appended to the user message for a non-English transcript (multilingual.md):
 * the compact-edits/format prompts above are tuned on English disfluencies, so
 * rather than localizing the filler vocabulary per language, we just tell the
 * model to preserve whatever language the transcript is already in.
 */
function languageNote(language?: string): string {
  return isEnglish(language) ? "" : `\n\nThe transcript is in language "${language}" — keep your output in that same language. Do not translate it to English.`;
}

/**
 * 3.4 — a "Known terms" line appended when a custom-vocabulary list is present.
 * Additive and behind a truthy/non-empty check, so existing calls (and prompt.test.ts)
 * are byte-identical when no vocabulary is supplied. Deliberately avoids the word
 * "language" so it never trips the language-note assertions.
 */
function vocabularyNote(vocabulary?: string[]): string {
  const terms = (vocabulary ?? []).map((t) => t.trim()).filter(Boolean);
  return terms.length ? `\n\nKnown terms (preserve and spell exactly): ${terms.join(", ")}.` : "";
}

export function formatMessage(text: string, language?: string, vocabulary?: string[]): string {
  return `Cleaned transcript to format:\n${text}${languageNote(language)}${vocabularyNote(vocabulary)}`;
}

// Platform P1c — free-form rewrite of a selected span, driven by a spoken instruction
// (command mode's "rewrite" intent — e.g. "make this more formal", "make that shorter").
// Unlike SYSTEM_PROMPT/FORMAT_PROMPT above, there is no fixed transformation: the
// INSTRUCTION supplies it, so there's no reconstruction/validation step afterward — the
// model's output text is trusted directly, exactly like format()'s whole-text rewrite.
export const REWRITE_SYSTEM_PROMPT = `You rewrite a piece of text exactly as instructed. Apply ONLY the requested change (tone, style, length, wording, grammar, etc.) to the given text. Do not add new information, opinions, or content that wasn't in the original, and do not change its meaning beyond what the instruction asks. Preserve the language the text is already written in. Return ONLY the rewritten text — no commentary, no quotes around it, no markdown code fences.`;

export function rewriteMessage(text: string, instruction: string): string {
  return `Instruction: ${instruction}\n\nText to rewrite:\n${text}`;
}

/**
 * Deterministic, offline formatting used as a FALLBACK when the LLM formatter is
 * unavailable (e.g. PyAI /v1/messages is failing under load). It is intentionally
 * conservative — it never invents structure it isn't sure about — so the final
 * output is always at least readable (capitalized, punctuated) instead of the raw
 * transcript. The LLM formatter remains the primary, higher-quality path.
 *
 * What it does: normalizes whitespace (preserving intentional newlines), fixes a
 * standalone "i" -> "I", capitalizes sentence starts, converts an EXPLICITLY
 * numbered spoken enumeration ("... 1 ... 2 ...") into a numbered list, and
 * ensures terminal punctuation.
 */
export function localFormat(text: string): string {
  let t = (text ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  if (!t) return t;
  t = t.replace(/\bi\b/g, "I");

  // Only restructure when the speaker explicitly numbered items ("1 ... 2 ... 3 ...").
  const list = extractNumberedList(t);
  if (list) {
    const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
    const lead = list.lead ? cap(punctFree(list.lead)) + ":" : "Here's the list:";
    return `${lead}\n\n` + list.items.map((it, i) => `${i + 1}. ${cap(punctFree(it))}`).join("\n");
  }

  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (_m, p, c) => p + c.toUpperCase());
  if (!/[.!?]$/.test(t)) t += ".";
  return t;
}

const punctFree = (s: string) => s.replace(/[.,;:\s]+$/, "").trim();

/**
 * Detect a spoken enumeration that used explicit numbers: "<lead> 1 <a> 2 <b> ...".
 * Returns null unless there are at least two ascending numbered markers, so free
 * prose is never mangled into a list.
 */
function extractNumberedList(t: string): { lead: string; items: string[] } | null {
  const re = /(?:^|\s)(\d+)[.)]?\s+/g;
  const marks: Array<{ n: number; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) marks.push({ n: Number(m[1]), start: m.index, end: re.lastIndex });
  if (marks.length < 2) return null;
  // Require the first two markers to be 1 then 2 (a real enumeration, not stray digits).
  if (marks[0].n !== 1 || marks[1].n !== 2) return null;
  const lead = t.slice(0, marks[0].start).trim();
  const items: string[] = [];
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].end;
    const to = i + 1 < marks.length ? marks[i + 1].start : t.length;
    const item = t.slice(from, to).trim();
    if (item) items.push(item);
  }
  return items.length >= 2 ? { lead, items } : null;
}

export function userMessage(raw: string, priorContext?: string, language?: string, vocabulary?: string[]): string {
  const ctx = priorContext ? `Prior context (already cleaned): ${priorContext}\n\n` : "";
  return `${ctx}Raw transcript:\n${raw}${languageNote(language)}${vocabularyNote(vocabulary)}`;
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
