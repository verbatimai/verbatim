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
});
