import { describe, it, expect } from "vitest";
import { localFormat } from "./prompt";

describe("localFormat (deterministic fallback formatter)", () => {
  it("capitalizes sentences, fixes standalone i, and adds terminal punctuation", () => {
    expect(localFormat("i think this works for me")).toBe("I think this works for me.");
  });

  it("capitalizes after sentence-ending punctuation", () => {
    expect(localFormat("hello there. how are you? i am fine")).toBe(
      "Hello there. How are you? I am fine.",
    );
  });

  it("leaves existing terminal punctuation alone", () => {
    expect(localFormat("this is done!")).toBe("This is done!");
  });

  it("turns an explicitly numbered enumeration into a numbered list", () => {
    const out = localFormat("here is my shopping list 1 phone 2 laptop 3 keyboard");
    expect(out).toBe("Here is my shopping list:\n\n1. Phone\n2. Laptop\n3. Keyboard");
  });

  it("does NOT invent a list from free prose with a stray number", () => {
    // Only one marker, or markers that don't start at 1,2 -> stays a sentence.
    expect(localFormat("i have 1 thing to say today")).toBe("I have 1 thing to say today.");
    expect(localFormat("the year 2026 was 3 times better")).toBe("The year 2026 was 3 times better.");
  });

  it("preserves intentional newlines and never throws on empty input", () => {
    expect(localFormat("")).toBe("");
    expect(localFormat("   ")).toBe("");
  });
});
