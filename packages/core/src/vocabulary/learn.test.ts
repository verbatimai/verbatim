import { describe, expect, it } from "vitest";
import {
  acceptSuggestion,
  dismissSuggestion,
  learnFromDiff,
  mergeSuggestion,
  activeGlossaryEntries,
} from "./learn";
import { EMPTY_GLOSSARY } from "./types";

describe("learnFromDiff", () => {
  it("returns empty when texts match", () => {
    expect(learnFromDiff("hello world", "hello world")).toEqual([]);
  });

  it("detects casing fix", () => {
    const pairs = learnFromDiff("send to alex", "send to Alex");
    expect(pairs.some((p) => p.preferred === "Alex")).toBe(true);
  });

  it("detects spelling fix", () => {
    const pairs = learnFromDiff("email saaslabs", "email SaaSLabs");
    expect(pairs.some((p) => p.preferred === "SaaSLabs")).toBe(true);
  });
});

describe("mergeSuggestion", () => {
  it("adds new suggested entry", () => {
    const g = mergeSuggestion(EMPTY_GLOSSARY, { heard: "sass labs", preferred: "SaaSLabs", confidence: 0.8 });
    expect(g.entries).toHaveLength(1);
    expect(g.entries[0].term).toBe("SaaSLabs");
    expect(g.entries[0].source).toBe("suggested");
  });

  it("accept and dismiss", () => {
    let g = mergeSuggestion(EMPTY_GLOSSARY, { heard: "x", preferred: "X", confidence: 0.9 });
    const id = g.entries[0].id;
    g = acceptSuggestion(g, id);
    expect(g.entries[0].source).toBe("learned");
    g = dismissSuggestion(g, id);
    expect(g.entries).toHaveLength(0);
  });
});

describe("activeGlossaryEntries", () => {
  it("includes manual and learned only", () => {
    const g = mergeSuggestion(EMPTY_GLOSSARY, { heard: "a", preferred: "A", confidence: 0.9 });
    expect(activeGlossaryEntries(g)).toHaveLength(0);
    g.entries[0].source = "learned";
    expect(activeGlossaryEntries(g)).toHaveLength(1);
  });
});
