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
