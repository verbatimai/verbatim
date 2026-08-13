/** Browser-safe auto-learn (mirrors packages/core/src/vocabulary/learn.ts). */

import { newGlossaryId, type UserGlossary } from "./glossary";

export interface LearnPair {
  heard: string;
  preferred: string;
  confidence: number;
}

const MIN_TERM_LEN = 3;
const MAX_EDIT_DIST = 3;

const COMMON_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "in", "on", "at", "to", "for", "of", "with", "by", "from", "as",
  "is", "are", "was", "were", "be", "been", "being", "am", "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might", "must", "shall", "can", "need", "that", "this",
  "these", "those", "it", "its", "i", "me", "my", "you", "your", "he", "she", "we", "they", "them", "their",
  "his", "her", "our", "us", "who", "what", "which", "when", "where", "why", "how", "all", "any", "each",
  "every", "both", "few", "more", "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "so", "than", "too", "very", "just", "also", "then", "there", "here", "now", "about", "into", "over",
  "after", "before", "between", "under", "again", "once", "hi", "hello", "hey", "thanks", "thank", "please",
  "yes", "yeah", "ok", "okay", "sir", "madam", "ma'am", "dear", "name", "email", "send", "call", "meeting",
  "today", "tomorrow", "good", "morning", "evening", "night", "well", "like", "know", "think", "want", "get",
  "go", "going", "make", "made", "say", "said", "tell", "told", "ask", "asked", "give", "given", "take",
  "see", "look", "come", "came", "work", "working", "help", "need", "new", "old", "first", "last", "next",
]);

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function stripToken(s: string): string {
  return s.replace(/^[^\w@]+|[^\w@.]+$/g, "");
}

function isCommonWord(s: string): boolean {
  const t = stripToken(s).toLowerCase();
  if (!t) return true;
  if (t.length <= 2) return true;
  return COMMON_WORDS.has(t);
}

function isNoisyToken(s: string): boolean {
  if (s.length > 40) return true;
  if ((s.match(/,/g) ?? []).length >= 2) return true;
  return false;
}

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
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function isProperNoun(s: string): boolean {
  const t = stripToken(s);
  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*$/.test(t)) return true;
  if (/^[A-Z][a-zA-Z0-9]*$/.test(t) && t.length >= MIN_TERM_LEN) return true;
  return false;
}

function isBrandLike(s: string): boolean {
  const t = stripToken(s);
  if (/[a-z][A-Z]/.test(t)) return true;
  if (/^[A-Z]{2,}$/.test(t)) return true;
  return false;
}

function isEmailOrDomain(s: string): boolean {
  return /@/.test(s) || /\.(io|com|co|dev|ai|org|net)\b/i.test(s);
}

function tokenize(s: string): string[] {
  return norm(s).split(/\s+/).filter(Boolean);
}

function tokenOverlap(a: string[], b: string[]): number {
  const A = new Set(a.map((t) => t.toLowerCase()));
  const B = new Set(b.map((t) => t.toLowerCase()));
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function isGlossaryCandidate(pair: LearnPair): boolean {
  const heard = stripToken(pair.heard);
  const preferred = stripToken(pair.preferred);
  if (!heard || !preferred) return false;
  if (isNoisyToken(pair.heard) || isNoisyToken(pair.preferred)) return false;
  if (preferred === "@" || preferred === "#") return heard.length >= MIN_TERM_LEN && !isCommonWord(heard);
  if (isEmailOrDomain(preferred) || isEmailOrDomain(heard)) return true;
  if (isBrandLike(preferred)) return !isCommonWord(preferred);
  if (isProperNoun(preferred)) return !isCommonWord(preferred);
  if (heard.toLowerCase() === preferred.toLowerCase()) return false;
  if (isCommonWord(preferred) || isCommonWord(heard)) return false;
  const dist = editDistance(heard.toLowerCase(), preferred.toLowerCase());
  if (preferred.length >= MIN_TERM_LEN && dist <= 2 && dist > 0) return true;
  return false;
}

function scorePair(heard: string, preferred: string): number {
  if (!heard || !preferred) return 0;
  if (heard === preferred) return 0;
  if (heard.toLowerCase() === preferred.toLowerCase()) return 0.55;
  const dist = editDistance(heard.toLowerCase(), preferred.toLowerCase());
  if (dist > MAX_EDIT_DIST) return 0;
  if (isEmailOrDomain(preferred) || isEmailOrDomain(heard)) return 0.85;
  if (isProperNoun(preferred) || isBrandLike(preferred)) return 0.75;
  if (heard.length >= MIN_TERM_LEN && preferred.length >= MIN_TERM_LEN && dist <= 2) return 0.65;
  return 0;
}

function diffTokens(before: string[], after: string[]): LearnPair[] {
  const pairs: LearnPair[] = [];
  let bi = 0;
  let ai = 0;
  while (bi < before.length && ai < after.length) {
    const b = before[bi];
    const a = after[ai];
    if (b.toLowerCase() === a.toLowerCase()) {
      if (b !== a) {
        const p = { heard: b, preferred: a, confidence: 0.55 };
        if (isGlossaryCandidate(p)) pairs.push(p);
      }
      bi++;
      ai++;
      continue;
    }
    if (bi + 1 < before.length && before[bi + 1].toLowerCase() === a.toLowerCase()) {
      bi++;
      continue;
    }
    if (ai + 1 < after.length && b.toLowerCase() === after[ai + 1].toLowerCase()) {
      ai++;
      continue;
    }
    if (b !== a) {
      const p = { heard: b, preferred: a, confidence: scorePair(b, a) };
      if (p.confidence >= 0.55 && isGlossaryCandidate(p)) pairs.push(p);
    }
    bi++;
    ai++;
  }
  return pairs;
}

function conservativeLearn(before: string[], after: string[]): LearnPair[] {
  const pairs: LearnPair[] = [];
  for (const aTok of after) {
    const preferred = stripToken(aTok);
    if (!preferred || isCommonWord(preferred) || isNoisyToken(aTok)) continue;
    if (!isProperNoun(aTok) && !isBrandLike(aTok) && !isEmailOrDomain(aTok)) continue;
    let best: { heard: string; dist: number } | null = null;
    for (const bTok of before) {
      const heard = stripToken(bTok);
      if (!heard) continue;
      if (heard.toLowerCase() === preferred.toLowerCase()) {
        if (heard !== aTok && (isBrandLike(aTok) || isProperNoun(aTok))) {
          const p = { heard: bTok, preferred: aTok, confidence: 0.55 };
          if (isGlossaryCandidate(p)) pairs.push(p);
        }
        continue;
      }
      const dist = editDistance(heard.toLowerCase(), preferred.toLowerCase());
      if (dist > 0 && dist <= MAX_EDIT_DIST && (!best || dist < best.dist)) best = { heard: bTok, dist };
    }
    if (!best) continue;
    const p = { heard: best.heard, preferred: aTok, confidence: scorePair(best.heard, aTok) };
    if (p.confidence >= 0.55 && isGlossaryCandidate(p)) pairs.push(p);
  }
  return pairs;
}

export function learnFromDiff(injected: string, edited: string): LearnPair[] {
  const b = norm(injected);
  const a = norm(edited);
  if (!b || !a || b === a) return [];
  const before = tokenize(b);
  const after = tokenize(a);
  const pairs = tokenOverlap(before, after) < 0.45 ? conservativeLearn(before, after) : diffTokens(before, after);
  return pairs.filter(
    (p) => (p.heard.length >= MIN_TERM_LEN || p.preferred.length >= MIN_TERM_LEN) && isGlossaryCandidate(p),
  );
}

export function mergeSuggestion(glossary: UserGlossary, pair: LearnPair): UserGlossary {
  if (!isGlossaryCandidate(pair)) return glossary;
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
          ? { ...e, term, aliases: [...aliases], confidence: Math.max(e.confidence ?? 0, pair.confidence) }
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
        aliases: heard && heard.toLowerCase() !== term.toLowerCase() ? [heard] : undefined,
        source: "suggested" as const,
        confidence: pair.confidence,
        createdAt: Date.now(),
      },
    ],
  };
}
