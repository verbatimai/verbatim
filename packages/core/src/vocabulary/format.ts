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

  const lines = ranked.flatMap((e) => {
    const pairs = replacementPairs([e]);
    if (!pairs.length) return [`- ${e.term}`];
    return pairs.map(({ alias, term }) => {
      if (isSymbol(term)) {
        return `- Use "${term}" (heard as: ${alias}) — keep the symbol; do NOT spell out as words`;
      }
      return `- ${term} (heard as: ${alias})`;
    });
  });

  return (
    "\n\nUser glossary (preferred forms — apply ONLY when the transcript clearly refers to these; " +
    "keep symbol substitutions like @; do NOT invent mentions; do NOT override intentional self-corrections):\n" +
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

function isSymbol(s: string): boolean {
  return /^[^\w\s]{1,3}$/.test(s.trim());
}

/** Spoken/heard form → preferred written form (handles @ entries stored either way). */
function replacementPairs(entries: GlossaryEntry[]): { alias: string; term: string }[] {
  const pairs: { alias: string; term: string }[] = [];
  for (const e of activeEntries(entries)) {
    const term = e.term.trim();
    const aliases = (e.aliases ?? []).map((a) => a.trim()).filter(Boolean);
    if (!term) continue;

    if (isSymbol(term)) {
      // Preferred @ — aliases are spoken forms ("at the rate").
      for (const alias of aliases) {
        if (alias.toLowerCase() !== term.toLowerCase()) pairs.push({ alias, term });
      }
      continue;
    }

    const symbolAliases = aliases.filter(isSymbol);
    const spokenAliases = aliases.filter((a) => !isSymbol(a));

    for (const alias of spokenAliases) {
      if (alias.toLowerCase() !== term.toLowerCase()) pairs.push({ alias, term });
    }

    // Backwards entry: term="at the rate", aliases=["@"] — still map spoken → symbol.
    for (const sym of symbolAliases) {
      pairs.push({ alias: term, term: sym });
    }
  }
  return pairs;
}

/**
 * Deterministic alias → term replacements from the user glossary. Runs after
 * LLM format so spoken forms like "at the rate" stay as "@" in the final text.
 */
export function applyGlossaryReplacements(text: string, entries?: GlossaryEntry[]): string {
  if (!text || !entries?.length) return text;
  let out = text;
  const pairs = replacementPairs(entries);
  pairs.sort((a, b) => b.alias.length - a.alias.length);
  for (const { alias, term } of pairs) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = /\w/.test(alias)
      ? new RegExp(`(?<![\\w@])${escaped}(?![\\w])`, "gi")
      : new RegExp(escaped, "gi");
    out = out.replace(re, term);
  }
  return out;
}
