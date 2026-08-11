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

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
/** Longest run of >=3 words that repeats back-to-back — the duplication bug signature. */
const hasBackToBackDup = (s: string): boolean => {
  const w = norm(s).split(" ").filter(Boolean);
  for (let len = 3; len <= Math.floor(w.length / 2); len++) {
    for (let i = 0; i + 2 * len <= w.length; i++) {
      const a = w.slice(i, i + len).join(" ");
      const b = w.slice(i + len, i + 2 * len).join(" ");
      if (a === b) return true;
    }
  }
  return false;
};
/** Collect the live `transcript` view after every event. */
const trail = (events: Array<Partial<TranscriptEvent>>): string[] => {
  const acc = new TranscriptAccumulator();
  return events.map((e) => acc.push(ev(e)).transcript);
};

describe("TranscriptAccumulator — Hear streaming patterns", () => {
  it("real single-utterance capture reconstructs the clean transcript", () => {
    // Each partial carries the FULL per-utterance hypothesis in `text` (as Hear does).
    const { acc } = feed([
      { text: "okay", activeText: "okay" },
      { text: "let's schedule a meeting", activeText: "a meeting" },
      { text: "let's schedule a meeting at eightpm no no", activeText: "eightpm no no" },
      { text: "let's schedule a meeting at eightpm no no make it ninepm r i think", activeText: "r i think" },
      {
        type: "final",
        endpoint: true,
        text: "let's schedule a meeting at eightpm no no make it ninepm r i think that that works for me",
      },
    ]);
    expect(acc.final()).toBe(
      "let's schedule a meeting at eightpm no no make it ninepm r i think that that works for me",
    );
  });

  it("REGRESSION: sliding stable_text + full text never duplicates in the live view", () => {
    // Mirrors the captured [hear] stream: `text` is the full utterance hypothesis
    // while `stable_text` is a sliding window that drops words off the front.
    const views = trail([
      { utteranceId: "u1", text: "i am testing", stableText: "i am testing", activeText: "testing" },
      { utteranceId: "u1", text: "i am testing the live", stableText: "testing the live", activeText: "the live" },
      { utteranceId: "u1", text: "i am testing the live input streaming", stableText: "live input streaming", activeText: "streaming" },
      { utteranceId: "u1", type: "final", endpoint: true, text: "i am testing the live input streaming" },
      { utteranceId: "u2", text: "and it should not", stableText: "and it should not", activeText: "not" },
      { utteranceId: "u2", text: "and it should not duplicate words", stableText: "not duplicate words", activeText: "words" },
      { utteranceId: "u2", type: "final", endpoint: true, text: "and it should not duplicate words" },
    ]);
    // No view ever contains a doubled run, and the transcript grows monotonically.
    for (const v of views) expect(hasBackToBackDup(v)).toBe(false);
    for (let i = 1; i < views.length; i++) {
      expect(views[i].length).toBeGreaterThanOrEqual(views[i - 1].length);
    }
    expect(views.at(-1)).toBe("i am testing the live input streaming and it should not duplicate words");
  });

  it("current utterance shows as solid text + a dim active tail", () => {
    const acc = new TranscriptAccumulator();
    const v = acc.push(ev({ text: "hello there friend", activeText: "friend" }));
    expect(v.transcript).toBe("hello there"); // solid part
    expect(v.active).toBe("friend"); // volatile tail rendered dim
  });

  it("multi-utterance with NO overlap concatenates in order", () => {
    const { acc } = feed([
      { utteranceId: "u1", type: "final", endpoint: true, text: "first sentence here" },
      { utteranceId: "u2", type: "final", endpoint: true, text: "second sentence now" },
    ]);
    expect(acc.final()).toBe("first sentence here second sentence now");
  });

  it("multi-utterance with boundary overlap dedupes the seam", () => {
    const { acc } = feed([
      { utteranceId: "u1", type: "final", endpoint: true, text: "watch it transcribe live and correct itself speak and watch" },
      { utteranceId: "u2", type: "final", endpoint: true, text: "speak and watch showing exactly what was removed" },
    ]);
    const t = acc.final();
    expect((t.match(/speak and watch/g) ?? []).length).toBe(1);
    expect(t).toBe("watch it transcribe live and correct itself speak and watch showing exactly what was removed");
  });

  it("utterance rollover with NO explicit final still commits the previous utterance", () => {
    // A new utterance_id appears mid-stream before any final for the old one.
    const { acc, last } = feed([
      { utteranceId: "u1", text: "first thing i said" },
      { utteranceId: "u2", text: "second thing i said" },
    ]);
    expect(last.transcript).toBe("first thing i said second thing i said");
    expect(acc.final()).toBe("first thing i said second thing i said");
  });

  it("provider that sends ONLY a sliding stable_text (no `text`) reassembles", () => {
    // e.g. a vendor without a full-text field: within one utterance we fold the
    // sliding window via mergeOverlap.
    const { acc } = feed([
      { utteranceId: "u1", stableText: "the quick brown fox" },
      { utteranceId: "u1", stableText: "brown fox jumps over" },
      { utteranceId: "u1", stableText: "jumps over the lazy dog", type: "final", endpoint: true },
    ]);
    expect(acc.final()).toBe("the quick brown fox jumps over the lazy dog");
  });

  it("provider that only sends full `text` (no stable/active) still accumulates", () => {
    const { acc } = feed([
      { text: "hello world" },
      { text: "hello world this is a test" },
      { type: "final", endpoint: true, text: "hello world this is a test done" },
    ]);
    expect(acc.final()).toBe("hello world this is a test done");
  });

  it("a final that repeats its own text (flush echo) does not duplicate", () => {
    const body = "i have two things on my list one shopping and two swimming";
    const { acc } = feed([
      { utteranceId: "u1", text: body, activeText: "two swimming" },
      // Hear flush sometimes echoes: stable+active both equal the body.
      { utteranceId: "u1", type: "final", endpoint: true, stableText: body, activeText: body },
    ]);
    const t = acc.final();
    expect(hasBackToBackDup(t)).toBe(false);
    expect(t).toBe(body);
  });
});
