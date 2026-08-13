import { describe, it, expect } from "vitest";
import { MockCorrection } from "./mock";
import { Pipeline } from "../pipeline";
import { FixtureSTT } from "../providers/fixture.stt";

describe("MockCorrection.format (offline formatting pass)", () => {
  it("turns a spoken enumeration into a titled numbered list", async () => {
    const { text } = await new MockCorrection().format("I have two things to do 1 shopping and 2 swimming");
    expect(text).toContain("1. Shopping");
    expect(text).toContain("2. Swimming");
    expect(text.split("\n").length).toBeGreaterThanOrEqual(3); // lead-in + two items
  });

  it("does light polish (capitalization, trailing period) otherwise", async () => {
    const { text } = await new MockCorrection().format("let's schedule a meeting at 9 pm i think that works");
    expect(text.startsWith("Let's")).toBe(true);
    expect(text).toMatch(/\bI think\b/);
    expect(text.endsWith(".")).toBe(true);
  });
});

describe("Pipeline emits a formatted final output", () => {
  it("fires onFormatted after corrections", async () => {
    let formatted: string | null = null;
    const pipeline = new Pipeline(new FixtureSTT(), new MockCorrection(), {
      onFormatted: (u) => (formatted = u.text),
    });
    await pipeline.run();
    expect(formatted).not.toBeNull();
    expect((formatted as unknown as string).length).toBeGreaterThan(0);
  });

  it("accumulates ALL utterances into one clean transcript (long-paragraph fix)", async () => {
    const events = [
      { type: "partial" as const, utteranceId: "u1", stableText: "i have two things", activeText: "on my list", text: "i have two things on my list" },
      { type: "final" as const, utteranceId: "u1", stableText: "i have two things on my list", activeText: "", text: "i have two things on my list", endpoint: true },
      { type: "partial" as const, utteranceId: "u2", stableText: "one shopping", activeText: "", text: "one shopping" },
      { type: "final" as const, utteranceId: "u2", stableText: "one shopping second swimming", activeText: "", text: "one shopping second swimming", endpoint: true },
    ];
    let formatted = "";
    const pipeline = new Pipeline(new FixtureSTT(events, 10), new MockCorrection(), {
      onFormatted: (u) => (formatted = u.text),
    });
    await pipeline.run();
    expect(formatted.toLowerCase()).toContain("two things"); // first utterance survives
    expect(formatted.toLowerCase()).toContain("swimming"); // ...and the last
  });

  it("overlap-merges Hear's re-emitted rolling windows into one transcript", async () => {
    // Two windows whose content OVERLAPS ("speak and watch").
    const events = [
      { type: "partial" as const, utteranceId: "u1", stableText: "testing this again this is now for a long transcription speak and watch", activeText: "", text: "" },
      { type: "partial" as const, utteranceId: "u1", stableText: "speak and watch a transcribe live correct itself", activeText: "", text: "" },
      { type: "final" as const, utteranceId: "u1", stableText: "speak and watch a transcribe live correct itself", activeText: "", text: "", endpoint: true },
    ];
    let raw = "";
    const pipeline = new Pipeline(new FixtureSTT(events, 10), new MockCorrection(), {
      onCorrection: (u) => (raw = u.raw),
    });
    await pipeline.run();
    const occurrences = raw.split("speak and watch").length - 1;
    expect(occurrences).toBe(1); // merged once, not stacked
    expect(raw).toContain("testing this again");
    expect(raw).toContain("a transcribe live correct itself");
  });
});

// 2.2 / 2.3 — the correction (`correct`) and formatting (`format`) toggles. Driven through
// the real Pipeline with FixtureSTT + MockCorrection, asserted via onCorrection/onFormatted.
describe("Pipeline correction/format toggles (2.2 / 2.3)", () => {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();

  // A single utterance whose raw transcript has a repeated word ("world world") that
  // MockCorrection.correct strips as a repetition — observable when correction runs.
  const repeatEvents = () => [
    { type: "partial" as const, utteranceId: "u1", stableText: "hello", activeText: "world world", text: "hello world world" },
    { type: "final" as const, utteranceId: "u1", stableText: "hello world world", activeText: "", text: "hello world world", endpoint: true },
  ];

  // A spoken enumeration that MockCorrection.format restructures into a numbered list —
  // observable ("1. Shopping") when the format pass runs.
  const enumEvents = () => [
    { type: "partial" as const, utteranceId: "u1", stableText: "i have two things to do", activeText: "1 shopping and 2 swimming", text: "i have two things to do 1 shopping and 2 swimming" },
    { type: "final" as const, utteranceId: "u1", stableText: "i have two things to do 1 shopping and 2 swimming", activeText: "", text: "i have two things to do 1 shopping and 2 swimming", endpoint: true },
  ];

  it("correct:false bypasses the correction pass (STT-only)", async () => {
    let corrFired = false;
    let formatted = "";
    const pipeline = new Pipeline(new FixtureSTT(repeatEvents(), 10), new MockCorrection(), {
      onCorrection: () => (corrFired = true),
      onFormatted: (u) => (formatted = u.text),
    }, { correct: false });
    await pipeline.run();
    expect(corrFired).toBe(false); // correction never ran
    // The repeated word survived (correction would have removed the second "world").
    expect((formatted.toLowerCase().match(/world/g) || []).length).toBe(2);
  });

  it("correct:true (default) still runs correction", async () => {
    let corrFired = false;
    let cleanText = "";
    const pipeline = new Pipeline(new FixtureSTT(repeatEvents(), 10), new MockCorrection(), {
      onCorrection: (u) => { corrFired = true; cleanText = u.result.cleanText; },
    });
    await pipeline.run();
    expect(corrFired).toBe(true);
    expect((cleanText.toLowerCase().match(/world/g) || []).length).toBe(1); // repeat removed
  });

  it("correct:false + a throwing correction provider still finalizes", async () => {
    const throwing = {
      id: "throw",
      requiredKeys: [] as string[],
      async correct(): Promise<never> { throw new Error("correction should not be called"); },
    };
    let errored = false;
    let formatted: string | null = null;
    const pipeline = new Pipeline(new FixtureSTT(repeatEvents(), 10), throwing as any, {
      onError: () => (errored = true),
      onFormatted: (u) => (formatted = u.text),
    }, { correct: false });
    await pipeline.run();
    expect(errored).toBe(false); // never called -> never threw -> a true skip, not a caught failure
    expect(formatted).not.toBeNull();
    expect(norm(formatted as unknown as string)).toBe("hello world world"); // raw (no format provider)
  });

  it("format:false skips the FORMAT_PROMPT pass", async () => {
    let formatted = "";
    const pipeline = new Pipeline(new FixtureSTT(enumEvents(), 10), new MockCorrection(), {
      onFormatted: (u) => (formatted = u.text),
    }, { format: false });
    await pipeline.run();
    expect(formatted).not.toContain("1. Shopping"); // numbered-list structure did NOT get built
    // Correction found nothing to strip here, so cleaned == raw; the unformatted text is emitted.
    expect(norm(formatted)).toBe("i have two things to do 1 shopping and 2 swimming");
  });

  it("format:true (default) still formats", async () => {
    let formatted = "";
    const pipeline = new Pipeline(new FixtureSTT(enumEvents(), 10), new MockCorrection(), {
      onFormatted: (u) => (formatted = u.text),
    });
    await pipeline.run();
    expect(formatted).toContain("1. Shopping");
    expect(formatted).toContain("2. Swimming");
  });

  it("correct:false + format:false emits the raw transcript", async () => {
    let corrFired = false;
    let formatted = "";
    const pipeline = new Pipeline(new FixtureSTT(repeatEvents(), 10), new MockCorrection(), {
      onCorrection: () => (corrFired = true),
      onFormatted: (u) => (formatted = u.text),
    }, { correct: false, format: false });
    await pipeline.run();
    expect(corrFired).toBe(false);
    // Raw, unformatted: repeat intact, no capitalization / trailing period (format skipped).
    expect(norm(formatted)).toBe("hello world world");
  });
});
