import { describe, expect, it } from "vitest";
import { toPromptBlock, toSttKeywords, toSttPrompt, applyGlossaryReplacements } from "./format";
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

describe("applyGlossaryReplacements", () => {
  it("replaces spoken alias with symbol term", () => {
    const text = applyGlossaryReplacements("email me at the rate example.com", [
      entry("@", ["at the rate"]),
    ]);
    expect(text).toBe("email me @ example.com");
  });

  it("replaces brand aliases case-insensitively", () => {
    const text = applyGlossaryReplacements("contact sass labs today", [entry("SaaSLabs", ["sass labs"])]);
    expect(text).toBe("contact SaaSLabs today");
  });

  it("prefers longest alias match", () => {
    const text = applyGlossaryReplacements("say at the rate now", [
      entry("@", ["at the rate", "at"]),
    ]);
    expect(text).toBe("say @ now");
  });

  it("handles backwards symbol entry (term=spoken, alias=symbol)", () => {
    const text = applyGlossaryReplacements("call mainbanga at the rate SaasLabs.com", [
      entry("at the rate", ["@"]),
    ]);
    expect(text).toBe("call mainbanga @ SaasLabs.com");
  });
});
