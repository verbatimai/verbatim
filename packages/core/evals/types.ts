export type MatchMode = "normalized_exact" | "normalized_contains";

/** Correction golden case — id, raw transcript, expected clean text. */
export interface CorrectionCase {
  id: string;
  raw: string;
  expected: string;
  /** Optional user glossary for this case. */
  glossary?: Array<{ term: string; aliases?: string[] }>;
}

export interface FormatExpectation {
  /** Full expected output; compared with normalized_exact when set. */
  text?: string;
  match?: MatchMode;
  must_contain?: string[];
  must_not_contain?: string[];
}

export interface FormatCase {
  id: string;
  tags?: string[];
  /** Cleaned transcript input to the formatting pass. */
  input: string;
  expected: FormatExpectation;
}

export interface CorrectionFixture {
  cases: CorrectionCase[];
}

export interface FormatFixture {
  version: number;
  cases: FormatCase[];
}

export interface CaseScore {
  id: string;
  pass: boolean;
  errors: string[];
  warnings: string[];
  latencyMs?: number;
  /** Fixture input (raw transcript for correction). */
  input?: string;
  expected?: string;
  /** Parsed clean text from the model. */
  actual?: string;
  valid?: boolean;
  cat?: string;
  /** Model id that produced the response. */
  model?: string;
  /** Raw LLM output before parsing. */
  modelResponse?: string;
  /** Parsed edits returned by the model. */
  edits?: Array<{ raw: string; replacement: string; reason: string }>;
}

export interface EvalSummary {
  kind: "correction" | "format";
  provider: string;
  model?: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  latencyMs: { p50: number; p95: number; max: number };
  byCategory?: Record<string, { passed: number; total: number }>;
  cases: CaseScore[];
  ranAt: string;
}

export interface EvalOptions {
  provider?: string;
  correctionOnly?: boolean;
  formatOnly?: boolean;
  caseIds?: Set<string>;
  /** 1-based batch index (use with batchSize). */
  batch?: number;
  /** Cases per batch (default 5). */
  batchSize?: number;
  minPassRate?: number;
  maxLatencyMs?: number;
  json?: boolean;
}

export interface BatchSlice {
  batch: number;
  batchSize: number;
  totalBatches: number;
  totalCases: number;
  cases: CorrectionCase[];
  fromId: string;
  toId: string;
}
