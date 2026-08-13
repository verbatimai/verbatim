import type { GlossaryEntry } from "./types";

const MAX_PROMPT_TERMS = 30;
const MAX_STT_KEYWORDS = 50;

function activeEntries(entries: GlossaryEntry[]): GlossaryEntry[] {
  return entries.filter((e) => e.source !== "suggested" || (e.confidence ?? 0) >= 0.5);
}

/** Rank by recency; cap for prompt size. */
function rankForPrompt(entries: GlossaryEntry[]): GlossaryEntry[] {
  return [...activeEntries(entries)]
    .sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt))
    .slice(0, MAX_PROMPT_TERMS);
}

/**
 * Compact block for LLM correction/format prompts. Spelling/casing only — no semantic rewrites.
 */
export function toPromptBlock(entries?: GlossaryEntry[]): string {
  if (!entries?.length) return "";
  const ranked = rankForPrompt(entries);
  if (!ranked.length) return "";

  const lines = ranked.map((e) => {
    const aliases = (e.aliases ?? []).filter((a) => a && a.toLowerCase() !== e.term.toLowerCase());
    const aliasPart = aliases.length ? ` (heard as: ${aliases.join(", ")})` : "";
    return `- ${e.term}${aliasPart}`;
  });

  return (
    "\n\nUser glossary (preferred spellings — apply ONLY when the transcript clearly refers to these; " +
    "do NOT invent mentions; do NOT override intentional self-corrections):\n" +
    lines.join("\n")
  );
}

/**
 * Flat keyword list for STT vendors (Deepgram keywords, OpenAI Whisper prompt).
 * Includes canonical terms and aliases, deduped case-insensitively.
 */
export function toSttKeywords(entries?: GlossaryEntry[]): string[] {
  if (!entries?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const e of activeEntries(entries)) {
    for (const word of [e.term, ...(e.aliases ?? [])]) {
      const w = word.trim();
      if (!w) continue;
      const key = w.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(w);
      if (out.length >= MAX_STT_KEYWORDS) return out;
    }
  }
  return out;
}

/** Whisper/OpenAI prompt field — space-separated keywords, truncated. */
export function toSttPrompt(entries?: GlossaryEntry[]): string {
  return toSttKeywords(entries).join(", ");
}
