import { describe, it, expect } from "vitest";
import { formatPromptFor, FORMAT_PROMPT, FORMAT_PROMPTS } from "./prompt";

describe("formatting modes (5.3)", () => {
  it("prose is the existing FORMAT_PROMPT (back-compat with prompt.test.ts)", () => {
    expect(formatPromptFor("prose")).toBe(FORMAT_PROMPT);
    expect(formatPromptFor(undefined)).toBe(FORMAT_PROMPT);
  });
  it("message mode is casual and avoids lists/formalizing", () => {
    const p = formatPromptFor("message");
    expect(p).not.toBe(FORMAT_PROMPT);
    expect(p.toLowerCase()).toContain("casual");
    expect(p.toLowerCase()).toContain("do not");
  });
  it("code mode preserves casing/symbols", () => {
    const p = formatPromptFor("code");
    expect(p.toLowerCase()).toContain("preserve casing");
    expect(p).toContain("myVar");
  });
  it("raw falls back to prose (raw is never routed to format())", () => {
    expect(formatPromptFor("raw")).toBe(FORMAT_PROMPT);
  });
  it("the three non-raw modes are distinct prompts", () => {
    const set = new Set([FORMAT_PROMPTS.prose, FORMAT_PROMPTS.message, FORMAT_PROMPTS.code]);
    expect(set.size).toBe(3);
  });
});
