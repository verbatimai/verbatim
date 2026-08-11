import { describe, it, expect } from "vitest";
import { reconstruct, validate } from "./prompt";

describe("reconstruct (compact edits -> clean text + ops)", () => {
  it("handles filler + self-correction", () => {
    const raw = "Umm let's schedule a meeting at 8 pm no no make it 9 pm";
    const edits = [
      { raw: "Umm ", replacement: "", reason: "filler" as const },
      { raw: "8 pm no no make it 9 pm", replacement: "9 pm", reason: "self_correction" as const },
    ];
    const { cleanText, ops } = reconstruct(raw, edits);
    expect(cleanText).toBe("let's schedule a meeting at 9 pm");
    expect(ops.some((o) => o.type === "remove")).toBe(true);
    expect(validate(cleanText, "let's schedule a meeting at 9 pm")).toBe(true);
  });

  it("handles repetitions + number formatting", () => {
    const raw = "The the total is like fifty, umm, fifty five dollars ahh yeah fifty five";
    const edits = [
      { raw: "The the", replacement: "The", reason: "repetition" as const },
      { raw: "like ", replacement: "", reason: "filler" as const },
      { raw: "fifty, ", replacement: "", reason: "false_start" as const },
      { raw: "umm, ", replacement: "", reason: "filler" as const },
      { raw: "fifty five", replacement: "55", reason: "grammar" as const },
      { raw: " ahh", replacement: "", reason: "filler" as const },
      { raw: " yeah", replacement: "", reason: "filler" as const },
      { raw: " fifty five", replacement: "", reason: "repetition" as const },
    ];
    const { cleanText } = reconstruct(raw, edits);
    expect(cleanText).toBe("The total is 55 dollars");
  });

  it("ignores edits whose raw substring is not found (model drift)", () => {
    const raw = "hello world";
    const { cleanText } = reconstruct(raw, [
      { raw: "not-present", replacement: "", reason: "filler" as const },
    ]);
    expect(cleanText).toBe("hello world");
  });
});
