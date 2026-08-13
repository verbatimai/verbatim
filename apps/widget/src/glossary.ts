/** Client-side glossary helpers (mirrors packages/core/src/vocabulary). */

export type GlossarySource = "manual" | "suggested" | "learned";

export interface GlossaryEntry {
  id: string;
  term: string;
  aliases?: string[];
  category?: string;
  source: GlossarySource;
  confidence?: number;
  createdAt: number;
  lastUsedAt?: number;
}

export interface UserGlossary {
  version: 1;
  entries: GlossaryEntry[];
}

export const EMPTY_GLOSSARY: UserGlossary = { version: 1, entries: [] };

export function activeGlossaryEntries(glossary: UserGlossary): GlossaryEntry[] {
  return glossary.entries.filter((e) => e.source === "manual" || e.source === "learned");
}

export function newGlossaryId(): string {
  return `g_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
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

export function mergeSuggestion(
  glossary: UserGlossary,
  heard: string,
  preferred: string,
  confidence = 0.75,
): UserGlossary {
  const term = preferred.trim();
  const alias = heard.trim();
  if (!term) return glossary;

  const existing = glossary.entries.find(
    (e) =>
      e.term.toLowerCase() === term.toLowerCase() ||
      (alias && (e.aliases ?? []).some((a) => a.toLowerCase() === alias.toLowerCase())),
  );
  if (existing && existing.source !== "suggested") return glossary;

  if (existing?.source === "suggested") {
    const aliases = new Set([...(existing.aliases ?? []), alias].filter(Boolean));
    return {
      ...glossary,
      entries: glossary.entries.map((e) =>
        e.id === existing.id
          ? { ...e, term, aliases: [...aliases], confidence: Math.max(e.confidence ?? 0, confidence) }
          : e,
      ),
    };
  }

  return {
    ...glossary,
    entries: [
      ...glossary.entries,
      {
        id: newGlossaryId(),
        term,
        aliases: alias && alias.toLowerCase() !== term.toLowerCase() ? [alias] : undefined,
        source: "suggested",
        confidence,
        createdAt: Date.now(),
      },
    ],
  };
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

export function learnFromDiff(injected: string, edited: string): Array<{ heard: string; preferred: string; confidence: number }> {
  const b = norm(injected).split(/\s+/);
  const a = norm(edited).split(/\s+/);
  if (!b.length || !a.length || injected === edited) return [];
  const pairs: Array<{ heard: string; preferred: string; confidence: number }> = [];
  let bi = 0;
  let ai = 0;
  while (bi < b.length && ai < a.length) {
    if (b[bi].toLowerCase() === a[ai].toLowerCase()) {
      if (b[bi] !== a[ai]) pairs.push({ heard: b[bi], preferred: a[ai], confidence: 0.55 });
      bi++;
      ai++;
      continue;
    }
    if (b[bi] === a[ai]) {
      bi++;
      ai++;
      continue;
    }
    const dist = editDistance(b[bi].toLowerCase(), a[ai].toLowerCase());
    let confidence = 0.45;
    if (b[bi].toLowerCase() === a[ai].toLowerCase()) confidence = 0.55;
    else if (dist <= 2 && a[ai].length >= 3) confidence = 0.65;
    else if (/^[A-Z]/.test(a[ai])) confidence = 0.75;
    if (confidence >= 0.4) pairs.push({ heard: b[bi], preferred: a[ai], confidence });
    bi++;
    ai++;
  }
  return pairs;
}
