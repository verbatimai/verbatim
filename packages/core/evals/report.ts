import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaseScore, EvalSummary } from "./types.js";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));

function indentBlock(label: string, value: string | undefined, prefix = "      "): string[] {
  if (value == null || value === "") return [];
  return [`${prefix}${label}:`, ...value.split("\n").map((line) => `${prefix}  ${line}`)];
}

/** Human-readable per-case detail for terminal or markdown reports. */
export function formatCaseDetail(c: CaseScore): string[] {
  const lines: string[] = [];
  if (c.model) lines.push(`      model: ${c.model}`);
  lines.push(...indentBlock("input", c.input));
  lines.push(...indentBlock("expected", c.expected));
  lines.push(...indentBlock("actual", c.actual));
  lines.push(...indentBlock("model response", c.modelResponse));
  if (c.edits?.length) {
    lines.push(`      edits: ${JSON.stringify(c.edits)}`);
  }
  for (const e of c.errors) lines.push(`      - ${e}`);
  for (const w of c.warnings) lines.push(`      ! ${w}`);
  return lines;
}

function formatCaseList(cases: CaseScore[]): string {
  if (!cases.length) return "  (none)";
  return cases.map((c) => `  ✓ ${c.id}${c.latencyMs != null ? ` (${c.latencyMs}ms)` : ""}`).join("\n");
}

function formatFailedCaseList(cases: CaseScore[]): string {
  if (!cases.length) return "  (none)";
  return cases
    .map((c) => {
      const err = c.errors[0] ? ` — ${c.errors[0]}` : "";
      return `  ✗ ${c.id}${err}`;
    })
    .join("\n");
}

export function formatHumanReport(summary: EvalSummary): string {
  const bar = "=".repeat(72);
  const passed = summary.cases.filter((c) => c.pass);
  const failed = summary.cases.filter((c) => !c.pass);

  const lines: string[] = [
    "",
    bar,
    `${summary.kind.toUpperCase()} eval  provider=${summary.provider}${summary.model ? `  model=${summary.model}` : ""}  ${summary.ranAt}`,
    bar,
    `Pass: ${summary.passed}/${summary.total} (${(summary.passRate * 100).toFixed(0)}%)` +
      `  latency p50=${summary.latencyMs.p50}ms p95=${summary.latencyMs.p95}ms max=${summary.latencyMs.max}ms`,
    "",
    `PASSED (${passed.length}):`,
    formatCaseList(passed),
    "",
    `FAILED (${failed.length}):`,
    formatFailedCaseList(failed),
  ];

  if (passed.length) {
    lines.push("", "-".repeat(72), `PASSED — detail (${passed.length})`, "-".repeat(72));
    for (const c of passed) {
      lines.push("");
      lines.push(`  ✓ ${c.id}${c.latencyMs != null ? ` (${c.latencyMs}ms)` : ""}`);
      lines.push(...formatCaseDetail(c));
    }
  }

  if (failed.length) {
    lines.push("", "-".repeat(72), `FAILED — detail (${failed.length})`, "-".repeat(72));
    for (const c of failed) {
      lines.push("");
      lines.push(`  ✗ ${c.id}${c.latencyMs != null ? ` (${c.latencyMs}ms)` : ""}`);
      lines.push(...formatCaseDetail(c));
    }
  }

  if (summary.byCategory && Object.keys(summary.byCategory).length) {
    lines.push("", "By category:");
    for (const [cat, stats] of Object.entries(summary.byCategory).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${cat}: ${stats.passed}/${stats.total}`);
    }
  }

  return lines.join("\n");
}

/** Write JSON + markdown reports under packages/core/evals/. */
export function writeEvalReports(summaries: EvalSummary[], dir = EVAL_DIR): { jsonPath: string; mdPath: string } {
  const jsonPath = join(dir, "last-run.json");
  const mdPath = join(dir, "report.md");
  writeFileSync(jsonPath, JSON.stringify({
    summaries: summaries.map((s) => ({
      ...s,
      passedCaseIds: s.cases.filter((c) => c.pass).map((c) => c.id),
      failedCaseIds: s.cases.filter((c) => !c.pass).map((c) => c.id),
    })),
    writtenAt: new Date().toISOString(),
  }, null, 2));

  const mdLines: string[] = [
    "# Eval Report",
    "",
    `**Written:** ${new Date().toISOString()}`,
    "",
  ];
  for (const s of summaries) {
    mdLines.push(formatHumanReport(s));
    mdLines.push("");
  }
  writeFileSync(mdPath, mdLines.join("\n"));

  return { jsonPath, mdPath };
}
