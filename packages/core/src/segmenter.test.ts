import { describe, it, expect } from "vitest";
import { Segmenter } from "./segmenter";
import type { TranscriptEvent } from "./providers/types";

const ev = (p: Partial<TranscriptEvent>): TranscriptEvent => ({
  type: "partial",
  utteranceId: "u1",
  text: "",
  stableText: "",
  activeText: "",
  ...p,
});

describe("Segmenter", () => {
  it("finalizes on a final event with the final text", () => {
    const s = new Segmenter();
    expect(s.push(ev({ stableText: "hello", text: "hello there", activeText: "there" }))).toBeNull();
    const seg = s.push(ev({ type: "final", text: "hello there world", endpoint: true }));
    expect(seg).toEqual({ utteranceId: "u1", text: "hello there world" });
  });

  it("finalizes on endpoint flag", () => {
    const s = new Segmenter();
    const seg = s.push(ev({ endpoint: true, text: "quick note" }));
    expect(seg?.text).toBe("quick note");
  });

  it("implicitly finalizes the previous utterance when a new id appears", () => {
    const s = new Segmenter();
    expect(s.push(ev({ utteranceId: "u1", text: "first thing" }))).toBeNull();
    const seg = s.push(ev({ utteranceId: "u2", text: "second" }));
    expect(seg).toEqual({ utteranceId: "u1", text: "first thing" });
  });

  it("does not double-finalize", () => {
    const s = new Segmenter();
    s.push(ev({ type: "final", text: "done", endpoint: true }));
    expect(s.push(ev({ type: "final", text: "done", endpoint: true }))).toBeNull();
    expect(s.flush()).toBeNull();
  });

  it("flush closes an open utterance", () => {
    const s = new Segmenter();
    s.push(ev({ text: "unfinished" }));
    expect(s.flush()).toEqual({ utteranceId: "u1", text: "unfinished" });
  });
});
