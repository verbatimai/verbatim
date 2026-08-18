import { describe, it, expect } from "vitest";
import { userMessage, formatMessage } from "./prompt";

describe("language note (multilingual, 4.7)", () => {
  it("appends no note for English or an unset language", () => {
    expect(userMessage("hello", undefined, undefined)).not.toMatch(/language/i);
    expect(userMessage("hello", undefined, "en")).not.toMatch(/language/i);
    expect(userMessage("hello", undefined, "en-GB")).not.toMatch(/language/i);
    expect(formatMessage("hello", "en")).not.toMatch(/language/i);
  });

  it("appends a preserve-language note for a non-English tag", () => {
    const u = userMessage("bonjour", undefined, "fr");
    expect(u).toContain("Raw transcript:\nbonjour");
    expect(u).toMatch(/language "fr"/);
    expect(u).toMatch(/do not translate/i);

    const f = formatMessage("bonjour le monde", "fr");
    expect(f).toMatch(/language "fr"/);
  });

  it("still includes prior context alongside a language note", () => {
    const u = userMessage("raw text", "earlier clean text", "es");
    expect(u).toContain("Prior context (already cleaned): earlier clean text");
    expect(u).toContain("Raw transcript:\nraw text");
    expect(u).toMatch(/language "es"/);
  });

  it("appends glossary block when entries provided", () => {
    const u = userMessage("hello", undefined, "en", [
      { id: "1", term: "SaaSLabs", aliases: ["sass labs"], source: "manual", createdAt: 0 },
    ]);
    expect(u).toContain("User glossary");
    expect(u).toContain("SaaSLabs");
    expect(u).toContain("sass labs");
  });

  // Guards added 18 Aug 2026 alongside the glossary-block implementation. The bug this
  // replaces was `vocabularyNote` assuming `string[]` and calling `t.trim()` on an entry
  // object — a throw on the correction path. These three lock down the shapes that must
  // keep working, and in particular that the string path stays BYTE-identical: the widget
  // and backend still send `string[]`, so a change there would alter every live prompt.
  it("leaves the plain-string vocabulary path byte-identical", () => {
    expect(userMessage("hi", undefined, "en", ["Acme", " Verbatim "])).toBe(
      'Raw transcript:\nhi\n\nKnown terms (preserve and spell exactly): Acme, Verbatim.',
    );
    expect(userMessage("hi")).toBe("Raw transcript:\nhi");
    expect(userMessage("hi", undefined, "en", [])).toBe("Raw transcript:\nhi");
  });

  it("renders mixed strings and entries without empty bullets", () => {
    const u = userMessage("x", undefined, "en", [
      "PlainTerm",
      { id: "2", term: "Priya Sharma", aliases: [], source: "learned", createdAt: 1 },
      { id: "3", term: "  ", aliases: ["ghost"], source: "suggested", createdAt: 2 },
    ]);
    expect(u).toContain("Known terms (preserve and spell exactly): PlainTerm.");
    expect(u).toContain("- Priya Sharma");
    expect(u).not.toContain("Priya Sharma (also heard as"); // no alias clause when there are none
    expect(u).not.toContain("ghost"); // a blank term is dropped, aliases and all
  });

  it("does not throw when only glossary entries are supplied", () => {
    expect(() =>
      userMessage("x", undefined, "en", [{ id: "9", term: "T", source: "manual", createdAt: 0 }]),
    ).not.toThrow();
  });
});
