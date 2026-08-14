import { describe, expect, it } from "vitest";
import {
  acceptSuggestion,
  dismissSuggestion,
  isGlossaryCandidate,
  learnFromDiff,
  mergeSuggestion,
  activeGlossaryEntries,
} from "./learn";
import { EMPTY_GLOSSARY } from "./types";

describe("isGlossaryCandidate", () => {
  it("rejects common words and case-only fixes on them", () => {
    expect(isGlossaryCandidate({ heard: "hi", preferred: "Hi", confidence: 0.55 })).toBe(false);
    expect(isGlossaryCandidate({ heard: "are", preferred: "an", confidence: 0.65 })).toBe(false);
    expect(isGlossaryCandidate({ heard: "how", preferred: "name", confidence: 0.65 })).toBe(false);
  });

  it("accepts proper names and brands", () => {
    expect(isGlossaryCandidate({ heard: "alex", preferred: "Alex", confidence: 0.75 })).toBe(true);
    expect(isGlossaryCandidate({ heard: "saaslabs", preferred: "SaaSLabs", confidence: 0.75 })).toBe(true);
    expect(isGlossaryCandidate({ heard: "mengbang", preferred: "Mengbang", confidence: 0.75 })).toBe(true);
  });
});

describe("learnFromDiff", () => {
  it("returns empty when texts match", () => {
    expect(learnFromDiff("hello world", "hello world")).toEqual([]);
  });

  it("detects casing fix for names", () => {
    const pairs = learnFromDiff("send to alex", "send to Alex");
    expect(pairs.some((p) => p.preferred === "Alex")).toBe(true);
  });

  it("detects spelling fix for brands", () => {
    const pairs = learnFromDiff("email saaslabs", "email SaaSLabs");
    expect(pairs.some((p) => p.preferred === "SaaSLabs")).toBe(true);
  });

  it("does not suggest common words after heavy edits", () => {
    const injected = "Hi I am Mengbang how are you Sir";
    const edited =
      "Hey, bank@banga.SaasLabs.com, and Sir, This is my name Mengbang Co.Sir, how are you";
    const pairs = learnFromDiff(injected, edited);
    const terms = pairs.map((p) => p.preferred.toLowerCase());
    expect(terms).not.toContain("hi");
    expect(terms).not.toContain("how");
    expect(terms).not.toContain("i");
    expect(terms).not.toContain("this");
    expect(terms).not.toContain("name");
  });

  it("still learns brand casing when overlap is low", () => {
    const pairs = learnFromDiff("email saaslabs team", "Hey contact SaaSLabs team please");
    expect(pairs.some((p) => p.preferred === "SaaSLabs")).toBe(true);
  });
});

describe("mergeSuggestion", () => {
  it("adds new suggested entry for names", () => {
    const g = mergeSuggestion(EMPTY_GLOSSARY, { heard: "sass labs", preferred: "SaaSLabs", confidence: 0.8 });
    expect(g.entries).toHaveLength(1);
    expect(g.entries[0].term).toBe("SaaSLabs");
    expect(g.entries[0].source).toBe("suggested");
  });

  it("skips common-word pairs", () => {
    const g = mergeSuggestion(EMPTY_GLOSSARY, { heard: "hi", preferred: "Hi", confidence: 0.55 });
    expect(g.entries).toHaveLength(0);
  });

  it("accept and dismiss", () => {
    let g = mergeSuggestion(EMPTY_GLOSSARY, { heard: "xcorp", preferred: "XCorp", confidence: 0.9 });
    const id = g.entries[0].id;
    g = acceptSuggestion(g, id);
    expect(g.entries[0].source).toBe("learned");
    g = dismissSuggestion(g, id);
    expect(g.entries).toHaveLength(0);
  });
});

describe("activeGlossaryEntries", () => {
  it("includes manual and learned only", () => {
    const g = mergeSuggestion(EMPTY_GLOSSARY, { heard: "xcorp", preferred: "XCorp", confidence: 0.9 });
    expect(activeGlossaryEntries(g)).toHaveLength(0);
    g.entries[0].source = "learned";
    expect(activeGlossaryEntries(g)).toHaveLength(1);
  });
});
