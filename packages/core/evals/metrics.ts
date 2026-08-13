import type { CorrectionResult } from "../src/correction/types";
import type { CaseScore, CorrectionCase, FormatCase, FormatExpectation, MatchMode } from "./types";

/** Collapse whitespace for stable transcript comparisons. */
export function normalize(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function compare(actual: string, expected: string, mode: MatchMode = "normalized_exact"): boolean {
  const a = normalize(actual);
  const e = normalize(expected);
  return mode === "normalized_contains" ? a.includes(e) : a === e;
}

function checkMust(actual: string, must?: string[], label = "must_contain"): string[] {
  if (!must?.length) return [];
  const n = normalize(actual);
  return must.filter((s) => !n.includes(s)).map((s) => `${label}: missing "${s}"`);
}

function checkMustNot(actual: string, mustNot?: string[]): string[] {
  if (!mustNot?.length) return [];
  const n = normalize(actual);
  return mustNot.filter((s) => n.includes(s)).map((s) => `must_not_contain: found "${s}"`);
}

export function scoreCorrectionCase(c: CorrectionCase, result: CorrectionResult): CaseScore {
  const errors: string[] = [];
  const warnings: string[] = [];
  const actual = result.cleanText;

  if (!result.valid) {
    warnings.push("valid_reconstruct: edits did not rebuild model clean_text");
  }

  if (!compare(actual, c.expected)) {
    errors.push("clean_text mismatch (expected normalized_exact)");
  }

  if (!result.edits.length && normalize(c.raw) !== normalize(actual)) {
    warnings.push("no edits returned but raw != clean");
  }

  return {
    id: c.id,
    pass: errors.length === 0,
    errors,
    warnings,
    latencyMs: result.latencyMs,
    input: c.raw,
    actual,
    expected: c.expected,
    valid: result.valid,
    model: result.model,
    modelResponse: result.modelResponse,
    edits: result.edits.map((e) => ({ raw: e.raw, replacement: e.replacement, reason: e.reason })),
  };
}

export function scoreFormatCase(c: FormatCase, actual: string): CaseScore {
  const errors: string[] = [];
  const exp = c.expected;

  if (exp.text) {
    const mode = exp.match ?? "normalized_exact";
    if (!compare(actual, exp.text, mode)) {
      errors.push(`text mismatch (expected ${mode})`);
    }
  }

  errors.push(...checkMust(actual, exp.must_contain));
  errors.push(...checkMustNot(actual, exp.must_not_contain));

  return {
    id: c.id,
    pass: errors.length === 0,
    errors,
    warnings: [],
    input: c.input,
    actual,
    expected: exp.text,
    cat: c.tags?.join(", "),
  };
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

export function latencyStats(latencies: number[]) {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

export function categoryBreakdown(scores: CaseScore[]): Record<string, { passed: number; total: number }> {
  const out: Record<string, { passed: number; total: number }> = {};
  for (const s of scores) {
    const cat = s.cat ?? "unknown";
    out[cat] ??= { passed: 0, total: 0 };
    out[cat].total++;
    if (s.pass) out[cat].passed++;
  }
  return out;
}
