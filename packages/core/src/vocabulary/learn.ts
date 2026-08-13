import type { GlossaryEntry, UserGlossary } from "./types";

export interface LearnPair {
  heard: string;
  preferred: string;
  confidence: number;
}

const MIN_TERM_LEN = 3;
const MAX_EDIT_DIST = 3;

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Levenshtein distance (for short tokens). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function isProperNoun(s: string): boolean {
  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*$/.test(s)) return true;
  if (/^[A-Z][a-zA-Z0-9]*$/.test(s) && s.length >= MIN_TERM_LEN) return true;
  return false;
}

function isEmailOrDomain(s: string): boolean {
  return /@/.test(s) || /\.(io|com|co|dev|ai|org|net)\b/i.test(s);
}

function tokenize(s: string): string[] {
  return norm(s).split(/\s+/).filter(Boolean);
}

/**
 * Align two token sequences with a simple greedy diff; return replace pairs where
 * tokens differ meaningfully (not whitespace-only).
 */
function diffTokens(before: string[], after: string[]): LearnPair[] {
  const pairs: LearnPair[] = [];
  const maxLen = Math.max(before.length, after.length);
  let bi = 0;
  let ai = 0;

  while (bi < before.length && ai < after.length) {
    const b = before[bi];
    const a = after[ai];
    if (b.toLowerCase() === a.toLowerCase()) {
      if (b !== a) pairs.push({ heard: b, preferred: a, confidence: 0.55 });
      bi++;
      ai++;
      continue;
    }
    // Lookahead: insertion/deletion vs replace
    if (bi + 1 < before.length && before[bi + 1].toLowerCase() === a.toLowerCase()) {
      bi++;
      continue;
    }
    if (ai + 1 < after.length && b.toLowerCase() === after[ai + 1].toLowerCase()) {
      ai++;
      continue;
    }
    if (b !== a) {
      pairs.push({ heard: b, preferred: a, confidence: scorePair(b, a) });
    }
    bi++;
    ai++;
  }
  return pairs.filter((p) => p.confidence >= 0.4);
}

function scorePair(heard: string, preferred: string): number {
  if (!heard || !preferred) return 0;
  if (heard === preferred) return 0;
  if (heard.toLowerCase() === preferred.toLowerCase()) return 0.55; // casing fix
  const dist = editDistance(heard.toLowerCase(), preferred.toLowerCase());
  if (dist > MAX_EDIT_DIST) return 0;
  if (isEmailOrDomain(preferred) || isEmailOrDomain(heard)) return 0.85;
  if (isProperNoun(preferred)) return 0.75;
  if (heard.length >= MIN_TERM_LEN && preferred.length >= MIN_TERM_LEN && dist <= 2) return 0.65;
  return 0.45;
}

/** Extract suggested glossary entries from injected vs user-edited text. */
export function learnFromDiff(injected: string, edited: string): LearnPair[] {
  const b = norm(injected);
  const a = norm(edited);
  if (!b || !a || b === a) return [];
  return diffTokens(tokenize(b), tokenize(a)).filter(
    (p) => p.heard.length >= MIN_TERM_LEN || p.preferred.length >= MIN_TERM_LEN,
  );
}

function newId(): string {
  return `g_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Upsert a suggestion into the glossary (dedupe by term/alias). */
export function mergeSuggestion(
  glossary: UserGlossary,
  pair: LearnPair,
  category: GlossaryEntry["category"] = "other",
): UserGlossary {
  const term = pair.preferred.trim();
  const heard = pair.heard.trim();
  if (!term) return glossary;

  const existing = glossary.entries.find(
    (e) =>
      e.term.toLowerCase() === term.toLowerCase() ||
      (e.aliases ?? []).some((a) => a.toLowerCase() === heard.toLowerCase()),
  );
  if (existing && existing.source !== "suggested") return glossary;

  if (existing?.source === "suggested") {
    const aliases = new Set([...(existing.aliases ?? []), heard].filter(Boolean));
    return {
      ...glossary,
      entries: glossary.entries.map((e) =>
        e.id === existing.id
          ? {
              ...e,
              term,
              aliases: [...aliases],
              confidence: Math.max(e.confidence ?? 0, pair.confidence),
            }
          : e,
      ),
    };
  }

  const entry: GlossaryEntry = {
    id: newId(),
    term,
    aliases: heard && heard.toLowerCase() !== term.toLowerCase() ? [heard] : undefined,
    category,
    source: "suggested",
    confidence: pair.confidence,
    createdAt: Date.now(),
  };
  return { ...glossary, entries: [...glossary.entries, entry] };
}

export function acceptSuggestion(glossary: UserGlossary, id: string): UserGlossary {
  return {
    ...glossary,
    entries: glossary.entries.map((e) =>
      e.id === id ? { ...e, source: "learned" as const, confidence: 1 } : e,
    ),
  };
}

export function dismissSuggestion(glossary: UserGlossary, id: string): UserGlossary {
  return { ...glossary, entries: glossary.entries.filter((e) => e.id !== id) };
}

export function activeGlossaryEntries(glossary?: UserGlossary): GlossaryEntry[] {
  if (!glossary?.entries?.length) return [];
  return glossary.entries.filter((e) => e.source === "manual" || e.source === "learned");
}
