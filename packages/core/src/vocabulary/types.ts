export type GlossarySource = "manual" | "suggested" | "learned";

export type GlossaryCategory = "name" | "jargon" | "product" | "email" | "other";

export interface GlossaryEntry {
  id: string;
  /** Canonical spelling, e.g. "SaaSLabs", "Priya Sharma". */
  term: string;
  /** Common mishearings, e.g. ["sass labs", "saas labs"]. */
  aliases?: string[];
  category?: GlossaryCategory;
  source: GlossarySource;
  /** 0–1 for auto-suggested entries. */
  confidence?: number;
  createdAt: number;
  lastUsedAt?: number;
}

export interface UserGlossary {
  version: 1;
  entries: GlossaryEntry[];
}

export const EMPTY_GLOSSARY: UserGlossary = { version: 1, entries: [] };
