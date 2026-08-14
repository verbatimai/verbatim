import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCorrectionProvider } from "../src/correction/registry";
import type { CorrectionProvider } from "../src/correction/types";
import { categoryBreakdown, latencyStats, scoreCorrectionCase, scoreFormatCase } from "./metrics";
import type {
  CaseScore,
  CorrectionCase,
  CorrectionFixture,
  EvalOptions,
  EvalSummary,
  FormatCase,
  FormatFixture,
} from "./types";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));

/** Model id used for live eval calls (provider-specific env var). */
export function resolveEvalModel(providerId: string): string | undefined {
  if (providerId === "openai") return process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  if (providerId === "pyai") return process.env.PYAI_MODEL ?? "gpt-5.6-sol";
  return undefined;
}

export function loadCorrectionFixture(path = join(EVAL_DIR, "fixtures/correction.json")): CorrectionFixture {
  const data = JSON.parse(readFileSync(path, "utf8")) as CorrectionFixture;
  if (!data.cases?.length) throw new Error(`No correction cases in ${path}`);
  for (const c of data.cases) {
    if (!c.id || !c.raw?.trim() || !c.expected?.trim()) {
      throw new Error(`Invalid correction case: ${c.id ?? "(missing id)"}`);
    }
  }
  return data;
}

export function loadFormatFixture(path = join(EVAL_DIR, "fixtures/format.json")): FormatFixture {
  const data = JSON.parse(readFileSync(path, "utf8")) as FormatFixture;
  if (!data.cases?.length) throw new Error(`No format cases in ${path}`);
  return data;
}

function filterByIds<T extends { id: string }>(cases: T[], ids?: Set<string>): T[] {
  if (!ids?.size) return cases;
  const filtered = cases.filter((c) => ids.has(c.id));
  if (!filtered.length) throw new Error(`No cases matched ids: ${[...ids].join(", ")}`);
  return filtered;
}

/** Slice a 1-based batch from an ordered case list. */
export function sliceBatch<T extends { id: string }>(
  cases: T[],
  batch: number,
  batchSize = 5,
): { slice: T[]; totalBatches: number } {
  if (batch < 1) throw new Error(`batch must be >= 1 (got ${batch})`);
  if (batchSize < 1) throw new Error(`batchSize must be >= 1 (got ${batchSize})`);
  const totalBatches = Math.max(1, Math.ceil(cases.length / batchSize));
  if (batch > totalBatches) {
    throw new Error(`batch ${batch} out of range (1..${totalBatches})`);
  }
  const start = (batch - 1) * batchSize;
  return { slice: cases.slice(start, start + batchSize), totalBatches };
}

export function listBatchPlan(cases: { id: string }[], batchSize = 5): string[] {
  const { totalBatches } = sliceBatch(cases, 1, batchSize);
  const lines: string[] = [];
  for (let b = 1; b <= totalBatches; b++) {
    const { slice } = sliceBatch(cases, b, batchSize);
    lines.push(`  batch ${b}: ${slice.map((c) => c.id).join(", ")}`);
  }
  return lines;
}

/** Optional pause between eval cases (set EVAL_DELAY_MS to throttle live API calls). */
function evalCaseDelayMs(): number {
  if (process.env.EVAL_DELAY_MS != null) return Math.max(0, Number(process.env.EVAL_DELAY_MS));
  return 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runCorrectionEval(
  provider: CorrectionProvider,
  cases: CorrectionCase[],
): Promise<EvalSummary> {
  const scores: CaseScore[] = [];
  const delayMs = evalCaseDelayMs();
  const total = cases.length;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    if (process.env.EVAL_PROGRESS !== "0") {
      process.stderr.write(`[eval] ${i + 1}/${total} ${c.id}…\n`);
    }
    try {
      const glossary = c.glossary?.map((g, i) => ({
        id: `eval_${c.id}_${i}`,
        term: g.term,
        aliases: g.aliases,
        source: "manual" as const,
        createdAt: 0,
      }));
      const result = await provider.correct(c.raw, { glossary });
      scores.push(scoreCorrectionCase(c, result));
    } catch (e: any) {
      scores.push({
        id: c.id,
        pass: false,
        errors: [`provider error: ${e?.message ?? String(e)}`],
        warnings: [],
        input: c.raw,
        expected: c.expected,
      });
    }
  }
  const passed = scores.filter((s) => s.pass).length;
  const latencies = scores.map((s) => s.latencyMs ?? 0).filter((n) => n > 0);
  return {
    kind: "correction",
    provider: provider.id,
    model: resolveEvalModel(provider.id),
    total: scores.length,
    passed,
    failed: scores.length - passed,
    passRate: scores.length ? passed / scores.length : 0,
    latencyMs: latencyStats(latencies),
    cases: scores,
    ranAt: new Date().toISOString(),
  };
}

export async function runFormatEval(
  provider: CorrectionProvider,
  cases: FormatCase[],
): Promise<EvalSummary> {
  if (!provider.format) {
    throw new Error(`Provider '${provider.id}' has no format() — cannot run format eval`);
  }
  const scores: CaseScore[] = [];
  for (const c of cases) {
    const t0 = Date.now();
    try {
      const { text } = await provider.format(c.input);
      const score = scoreFormatCase(c, text);
      score.latencyMs = Date.now() - t0;
      scores.push(score);
    } catch (e: any) {
      scores.push({
        id: c.id,
        pass: false,
        errors: [`provider error: ${e?.message ?? String(e)}`],
        warnings: [],
        latencyMs: Date.now() - t0,
        cat: c.tags?.join(", "),
      });
    }
  }
  const passed = scores.filter((s) => s.pass).length;
  const latencies = scores.map((s) => s.latencyMs ?? 0).filter((n) => n > 0);
  return {
    kind: "format",
    provider: provider.id,
    model: resolveEvalModel(provider.id),
    total: scores.length,
    passed,
    failed: scores.length - passed,
    passRate: scores.length ? passed / scores.length : 0,
    latencyMs: latencyStats(latencies),
    byCategory: categoryBreakdown(scores),
    cases: scores,
    ranAt: new Date().toISOString(),
  };
}

export async function runEval(options: EvalOptions = {}): Promise<EvalSummary[]> {
  const providerId = options.provider ?? process.env.CORRECTION_PROVIDER ?? "openai";
  const provider = getCorrectionProvider(providerId);
  const summaries: EvalSummary[] = [];

  if (!options.formatOnly) {
    let cases = filterByIds(loadCorrectionFixture().cases, options.caseIds);
    if (options.batch != null) {
      const batchSize = options.batchSize ?? 5;
      const { slice, totalBatches } = sliceBatch(cases, options.batch, batchSize);
      if (process.env.EVAL_PROGRESS !== "0") {
        process.stderr.write(
          `[eval] batch ${options.batch}/${totalBatches} (${slice.length} cases: ${slice[0]?.id} … ${slice.at(-1)?.id})\n`,
        );
      }
      cases = slice;
    }
    summaries.push(await runCorrectionEval(provider, cases));
  }
  if (!options.correctionOnly) {
    let cases = filterByIds(loadFormatFixture().cases, options.caseIds);
    if (options.batch != null) {
      const batchSize = options.batchSize ?? 5;
      cases = sliceBatch(cases, options.batch, batchSize).slice;
    }
    summaries.push(await runFormatEval(provider, cases));
  }
  return summaries;
}

export function assertPassThresholds(summaries: EvalSummary[], options: EvalOptions): string[] {
  const failures: string[] = [];
  const minRate = options.minPassRate ?? 1;
  const maxLatency = options.maxLatencyMs;

  for (const s of summaries) {
    if (s.passRate < minRate) {
      failures.push(
        `${s.kind}: pass rate ${(s.passRate * 100).toFixed(0)}% < required ${(minRate * 100).toFixed(0)}%`,
      );
    }
    if (maxLatency != null && s.latencyMs.p95 > maxLatency) {
      failures.push(`${s.kind}: p95 latency ${s.latencyMs.p95}ms > max ${maxLatency}ms`);
    }
  }
  return failures;
}
