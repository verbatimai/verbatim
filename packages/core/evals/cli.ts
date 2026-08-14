#!/usr/bin/env node
/**
 * Prompt evaluation CLI — runs golden correction + format fixtures against a live provider.
 *
 * Usage:
 *   # PYAI_API_KEY / OPENAI_API_KEY read from repo-root .env automatically
 *   npm run eval:prompts               # from repo root
 *   npm run eval:prompts -- --provider mock --correction-only
 *   npm run eval:prompts -- --case sc_001 --json
 *   npm run eval:prompts -- --batch 1 --batch-size 5 --min-pass-rate 0
 */
import { loadEnv } from "./loadEnv.js";
import { formatHumanReport, writeEvalReports } from "./report.js";
import { assertPassThresholds, listBatchPlan, loadCorrectionFixture, resolveEvalModel, runEval } from "./runner.js";

const envPath = loadEnv();

function parseArgs(argv: string[]) {
  const opts: {
    provider?: string;
    correctionOnly?: boolean;
    formatOnly?: boolean;
    caseIds?: Set<string>;
    minPassRate?: number;
    maxLatencyMs?: number;
    json?: boolean;
    help?: boolean;
    batch?: number;
    batchSize?: number;
    listBatches?: boolean;
    noReport?: boolean;
  } = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--correction-only") opts.correctionOnly = true;
    else if (a === "--format-only") opts.formatOnly = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--no-report") opts.noReport = true;
    else if (a === "--provider") opts.provider = argv[++i];
    else if (a === "--case") {
      opts.caseIds ??= new Set();
      opts.caseIds.add(argv[++i]);
    } else if (a === "--batch") opts.batch = Number(argv[++i]);
    else if (a === "--batch-size") opts.batchSize = Number(argv[++i]);
    else if (a === "--list-batches") opts.listBatches = true;
    else if (a === "--min-pass-rate") opts.minPassRate = Number(argv[++i]);
    else if (a === "--max-latency-ms") opts.maxLatencyMs = Number(argv[++i]);
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (opts.correctionOnly && opts.formatOnly) {
    throw new Error("Use at most one of --correction-only / --format-only");
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage: npm run eval:prompts -- [options]

Options:
  --provider <id>         Correction provider (default: CORRECTION_PROVIDER or openai)
  --correction-only       Run only correction fixtures
  --format-only           Run only format fixtures
  --case <id>             Run a single case (repeatable)
  --batch <n>             Run batch n only (1-based, 5 cases per batch by default)
  --batch-size <n>        Cases per batch (default: 5)
  --list-batches          Print batch plan for correction fixtures and exit
  --min-pass-rate <0-1>   Fail exit if below (default: 1.0)
  --max-latency-ms <n>    Fail exit if p95 latency exceeds
  --json                  Print machine-readable report to stdout
  --no-report             Skip writing evals/last-run.json and evals/report.md
  -h, --help              Show help`);
    process.exit(0);
  }

  if (opts.listBatches) {
    const size = opts.batchSize ?? 5;
    console.log(`Correction batches (batch-size=${size}, ${loadCorrectionFixture().cases.length} cases):\n`);
    listBatchPlan(loadCorrectionFixture().cases, size).forEach((l) => console.log(l));
    process.exit(0);
  }

  const provider = opts.provider ?? process.env.CORRECTION_PROVIDER ?? "openai";
  const model = resolveEvalModel(provider);

  if (envPath && !opts.json) {
    const keyLine =
      provider === "openai"
        ? `OPENAI_API_KEY=${process.env.OPENAI_API_KEY ? "set" : "MISSING"}`
        : provider === "pyai"
          ? `PYAI_API_KEY=${process.env.PYAI_API_KEY ? "set" : "MISSING"}`
          : "no API key required";
    const delay = process.env.EVAL_DELAY_MS != null ? `${process.env.EVAL_DELAY_MS}ms/case` : "none";
    console.log(
      `[eval] loaded env from ${envPath}  provider=${provider}  ${keyLine}  model=${model ?? "—"}  pacing=${delay}`,
    );
  }
  if (provider === "pyai" && !process.env.PYAI_API_KEY) {
    console.error("[eval] Set PYAI_API_KEY in .env (repo root).");
    process.exit(1);
  }
  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    console.error("[eval] Set OPENAI_API_KEY in .env (repo root).");
    process.exit(1);
  }

  const summaries = await runEval(opts);

  if (!opts.noReport) {
    const { jsonPath, mdPath } = writeEvalReports(summaries);
    if (!opts.json) {
      console.error(`[eval] report written to ${jsonPath} and ${mdPath}`);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ summaries }, null, 2));
  } else {
    for (const s of summaries) console.log(formatHumanReport(s));
  }

  const thresholdFailures = assertPassThresholds(summaries, opts);
  if (thresholdFailures.length) {
    console.error("\nThreshold failures:");
    thresholdFailures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  const anyCaseFailed = summaries.some((s) => s.failed > 0);
  process.exit(anyCaseFailed ? 1 : 0);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
