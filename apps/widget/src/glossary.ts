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
  // Common-word filtering lives in @verbatim/core — settings UI uses manual entry only.

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

// Auto-learn filtering is in @verbatim/core (learnFromDiff). Widget main.ts imports it there.
