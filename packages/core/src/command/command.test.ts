import { describe, it, expect } from "vitest";
import { MockIntent } from "./mock";
import { getIntentProvider, assertIntentKeys } from "./registry";

describe("MockIntent (offline provider)", () => {
  const mock = new MockIntent();

  it("resolves fast-path phrases", async () => {
    const r = await mock.interpret("make that bold");
    expect(r.intent).toEqual({ action: "format", style: "bold", target: "selection" });
    expect(r.valid).toBe(true);
  });

  it("resolves canned multi-word phrases", async () => {
    const r = await mock.interpret("make the last sentence bold");
    expect(r.intent).toEqual({ action: "format", style: "bold", target: "last-sentence" });
  });

  it("falls back to noop for anything it doesn't know", async () => {
    const r = await mock.interpret("summarize this email");
    expect(r.intent.action).toBe("noop");
    expect(r.valid).toBe(true); // a deliberate noop is still a valid result
  });
});

describe("registry", () => {
  it("resolves each known provider id", () => {
    expect(getIntentProvider("mock").id).toBe("mock");
    expect(getIntentProvider("pyai").id).toBe("pyai");
    expect(getIntentProvider("openai").id).toBe("openai");
    expect(getIntentProvider("anthropic").id).toBe("anthropic");
  });

  it("throws on an unknown provider id", () => {
    expect(() => getIntentProvider("gemini")).toThrow(/Unknown command provider/);
  });

  it("assertIntentKeys throws when the required key is absent, passes when present", () => {
    const pyai = getIntentProvider("pyai");
    expect(() => assertIntentKeys(pyai, {})).toThrow(/PYAI_API_KEY/);
    expect(() => assertIntentKeys(pyai, { PYAI_API_KEY: "x" })).not.toThrow();
    // mock needs no keys
    expect(() => assertIntentKeys(getIntentProvider("mock"), {})).not.toThrow();
  });
});
