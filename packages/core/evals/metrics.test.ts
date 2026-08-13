import { describe, it, expect } from "vitest";
import { normalize, scoreCorrectionCase, scoreFormatCase, latencyStats, categoryBreakdown } from "./metrics";
import { loadCorrectionFixture, loadFormatFixture, sliceBatch } from "./runner";
import type { CorrectionResult } from "../src/correction/types";

describe("eval metrics", () => {
  it("normalize collapses whitespace", () => {
    expect(normalize("  hello   world \n")).toBe("hello world");
  });

  it("scores a passing correction case", () => {
    const score = scoreCorrectionCase(
      { id: "fil_001", raw: "um hello", expected: "hello" },
      {
        cleanText: "hello",
        edits: [{ raw: "um ", replacement: "", reason: "filler" }],
        ops: [],
        latencyMs: 100,
        valid: true,
      } satisfies CorrectionResult,
    );
    expect(score.pass).toBe(true);
    expect(score.errors).toHaveLength(0);
  });

  it("flags reconstruct invalidity as warning only", () => {
    const score = scoreCorrectionCase(
      { id: "nop_001", raw: "hello", expected: "hello" },
      { cleanText: "hello", edits: [], ops: [], latencyMs: 1, valid: false },
    );
    expect(score.pass).toBe(true);
    expect(score.warnings[0]).toContain("valid_reconstruct");
  });

  it("fails on clean_text mismatch", () => {
    const score = scoreCorrectionCase(
      { id: "sc_001", raw: "x", expected: "y" },
      {
        cleanText: "x",
        edits: [{ raw: "x", replacement: "y", reason: "self_correction" }],
        ops: [],
        latencyMs: 1,
        valid: true,
      },
    );
    expect(score.pass).toBe(false);
    expect(score.errors[0]).toContain("clean_text mismatch");
  });

  it("scores format must_contain / must_not_contain", () => {
    const pass = scoreFormatCase(
      { id: "list", input: "x", expected: { must_contain: ["1.", "Shop"], must_not_contain: ["```"] } },
      "Things:\n\n1. Shopping",
    );
    expect(pass.pass).toBe(true);

    const fail = scoreFormatCase(
      { id: "list", input: "x", expected: { must_not_contain: ["Sarah"] } },
      "Send to Sarah please.",
    );
    expect(fail.pass).toBe(false);
  });

  it("computes latency percentiles and category breakdown", () => {
    expect(latencyStats([100, 200, 300, 400, 500])).toEqual({ p50: 300, p95: 500, max: 500 });
    expect(categoryBreakdown([
      { id: "a", pass: true, errors: [], warnings: [], cat: "filler" },
      { id: "b", pass: false, errors: ["x"], warnings: [], cat: "filler" },
      { id: "c", pass: true, errors: [], warnings: [], cat: "no_op" },
    ])).toEqual({ filler: { passed: 1, total: 2 }, no_op: { passed: 1, total: 1 } });
  });
});

describe("eval fixtures", () => {
  it("loads correction golden set with unique ids", () => {
    const fx = loadCorrectionFixture();
    expect(fx.cases).toHaveLength(52);
    const ids = fx.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of fx.cases) {
      expect(c.raw.trim()).toBeTruthy();
      expect(c.expected.trim()).toBeTruthy();
    }
  });

  it("loads format golden set", () => {
    const fx = loadFormatFixture();
    expect(fx.cases.length).toBeGreaterThanOrEqual(2);
  });

  it("slices batches of 5", () => {
    const cases = loadCorrectionFixture().cases;
    const b1 = sliceBatch(cases, 1, 5);
    expect(b1.slice).toHaveLength(5);
    expect(b1.slice[0].id).toBe("sc_001");
    expect(b1.totalBatches).toBe(11);
    const b11 = sliceBatch(cases, 11, 5);
    expect(b11.slice).toHaveLength(2);
    expect(b11.slice[1].id).toBe("long_002");
  });
});
