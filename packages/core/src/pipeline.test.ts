import { describe, it, expect } from "vitest";
import { mergeOverlap, collapseRepeats, TranscriptAccumulator } from "./pipeline";
import type { TranscriptEvent } from "./providers/types";

const ev = (p: Partial<TranscriptEvent>): TranscriptEvent => ({
  type: "partial",
  utteranceId: "u1",
  text: "",
  stableText: "",
  activeText: "",
  ...p,
});
const feed = (events: Array<Partial<TranscriptEvent>>) => {
  const acc = new TranscriptAccumulator();
  let last = { transcript: "", active: "" };
  for (const e of events) last = acc.push(ev(e));
  return { acc, last };
};

describe("mergeOverlap", () => {
  it("appends only the non-overlapping tail", () => {
    expect(mergeOverlap("a b c", "c d e")).toBe("a b c d e");
    expect(mergeOverlap("a b c d", "c d e f")).toBe("a b c d e f");
  });
  it("appends the new suffix when add starts with the entire base (re-transcription)", () => {
    expect(mergeOverlap("alpha beta gamma delta", "alpha beta gamma delta epsilon")).toBe(
      "alpha beta gamma delta epsilon",
    );
  });
  it("skips content already present", () => {
    expect(mergeOverlap("a b c d", "a b c d")).toBe("a b c d");
    expect(mergeOverlap("a b c d e", "c d")).toBe("a b c d e");
  });
  it("concatenates a genuinely fresh window", () => {
    expect(mergeOverlap("a b c", "x y z")).toBe("a b c x y z");
  });
  it("fuzzy-aligns minor revisions instead of duplicating", () => {
    // "this" revised to "This"; the overlap should still be detected.
    expect(mergeOverlap("this is now five", "This is now five and non transcription")).toBe(
      "this is now five and non transcription",
    );
  });
  it("does not double the tail when Hear re-appends the last sentence on flush", () => {
    const base = "keys stays on the dev server demo mode needs no mic or key";
    const flush = "demo mode needs no mic or key i have two things on my list";
    const merged = mergeOverlap(base, flush);
    expect((merged.match(/demo mode needs no mic or key/g) ?? []).length).toBe(1);
    expect(merged).toBe(
      "keys stays on the dev server demo mode needs no mic or key i have two things on my list",
    );
  });
});

describe("collapseRepeats", () => {
  it("collapses an exact doubled tail", () => {
    expect(collapseRepeats("i have two things on my list i have two things on my list")).toBe(
      "i have two things on my list",
    );
  });
  it("collapses a whole-paragraph re-emission", () => {
    expect(collapseRepeats("a b c d e f a b c d e f")).toBe("a b c d e f");
  });
  it("leaves clean text and short repeats alone", () => {
    expect(collapseRepeats("this is a normal sentence")).toBe("this is a normal sentence");
    expect(collapseRepeats("no no make it nine pm")).toBe("no no make it nine pm");
  });
});

describe("TranscriptAccumulator — Hear streaming patterns", () => {
  it("real single-utterance capture reconstructs the clean transcript", () => {
    const { acc } = feed([
      { stableText: "", activeText: "okay" },
      { stableText: "let's schedule", activeText: "a meeting okay" },
      { stableText: "let's schedule a meeting at", activeText: "eightpm no no" },
      { stableText: "let's schedule a meeting at eightpm no no", activeText: "make it i" },
      { stableText: "let's schedule a meeting at eightpm no no make", activeText: "it ninepm r" },
      { stableText: "let's schedule a meeting at eightpm no no make it ninepm", activeText: "r i think" },
      { stableText: "let's schedule a meeting at eightpm no no make it ninepm r i think that that", activeText: "works for me" },
      { type: "final", endpoint: true, stableText: "let's schedule a meeting at eightpm no no make it ninepm r i think that that", activeText: "works for me" },
    ]);
    expect(acc.final()).toBe(
      "let's schedule a meeting at eightpm no no make it ninepm r i think that that works for me",
    );
  });

  it("cumulative stable growth stays a single clean line (no stacking)", () => {
    const { last } = feed([
      { stableText: "testing this", activeText: "again" },
      { stableText: "testing this again this is", activeText: "now for" },
      { stableText: "testing this again this is now for a long transcription", activeText: "" },
    ]);
    expect(last.transcript).toBe("testing this again this is now for a long transcription");
  });

  it("multi-utterance with NO overlap concatenates in order", () => {
    const { acc } = feed([
      { utteranceId: "u1", type: "final", endpoint: true, stableText: "first sentence here" },
      { utteranceId: "u2", type: "final", endpoint: true, stableText: "second sentence now" },
    ]);
    expect(acc.final()).toBe("first sentence here second sentence now");
  });

  it("multi-utterance with boundary overlap dedupes the seam", () => {
    const { acc } = feed([
      { utteranceId: "u1", type: "final", endpoint: true, stableText: "watch it transcribe live and correct itself speak and watch" },
      { utteranceId: "u2", type: "final", endpoint: true, stableText: "speak and watch showing exactly what was removed" },
    ]);
    const t = acc.final();
    expect((t.match(/speak and watch/g) ?? []).length).toBe(1);
    expect(t).toBe("watch it transcribe live and correct itself speak and watch showing exactly what was removed");
  });

  it("rolling-window stable_text reassembles the full transcript", () => {
    const { acc } = feed([
      { stableText: "the quick brown fox" },
      { stableText: "brown fox jumps over" },
      { stableText: "jumps over the lazy dog", type: "final", endpoint: true },
    ]);
    expect(acc.final()).toBe("the quick brown fox jumps over the lazy dog");
  });

  it("a full-paragraph re-emission at the end does not duplicate", () => {
    const body =
      "testing this again this is just the transcript live speak and watch transcribe live and correct itself";
    const { acc } = feed([
      { stableText: "testing this again this is just the transcript live", activeText: "speak and watch" },
      { stableText: body, activeText: "" },
      { type: "final", endpoint: true, stableText: body, activeText: body }, // Hear flush repeats it
    ]);
    const t = acc.final();
    expect((t.match(/testing this again/g) ?? []).length).toBe(1);
    expect(t).toBe(body);
  });

  it("provider that only sends full `text` (no stable/active) still accumulates", () => {
    const { acc } = feed([
      { stableText: "", activeText: "", text: "hello world" },
      { stableText: "", activeText: "", text: "hello world this is a test" },
      { type: "final", endpoint: true, stableText: "", activeText: "", text: "hello world this is a test done" },
    ]);
    expect(acc.final()).toBe("hello world this is a test done");
  });
});
