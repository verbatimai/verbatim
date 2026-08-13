import { describe, expect, it } from "vitest";
import { toPromptBlock, toSttKeywords, toSttPrompt } from "./format";
import type { GlossaryEntry } from "./types";

const entry = (term: string, aliases?: string[], source: GlossaryEntry["source"] = "manual"): GlossaryEntry => ({
  id: "1",
  term,
  aliases,
  source,
  createdAt: 1,
});

describe("toPromptBlock", () => {
  it("returns empty for no entries", () => {
    expect(toPromptBlock()).toBe("");
    expect(toPromptBlock([])).toBe("");
  });

  it("includes term and aliases", () => {
    const block = toPromptBlock([entry("SaaSLabs", ["sass labs"])]);
    expect(block).toContain("SaaSLabs");
    expect(block).toContain("sass labs");
    expect(block).toContain("User glossary");
  });

  it("skips low-confidence suggestions", () => {
    expect(toPromptBlock([{ ...entry("X", [], "suggested"), confidence: 0.2 }])).toBe("");
  });
});

describe("toSttKeywords", () => {
  it("dedupes case-insensitively", () => {
    const kw = toSttKeywords([entry("SaaSLabs", ["saaslabs"])]);
    expect(kw.map((k) => k.toLowerCase())).toEqual(["saaslabs"]);
  });

  it("includes aliases", () => {
    const kw = toSttKeywords([entry("Priya", ["priya sharma"])]);
    expect(kw).toContain("Priya");
    expect(kw).toContain("priya sharma");
  });
});

describe("toSttPrompt", () => {
  it("joins keywords", () => {
    expect(toSttPrompt([entry("A"), entry("B")])).toBe("A, B");
  });
});
