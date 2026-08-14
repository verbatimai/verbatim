import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { OpenAiCorrection } from "./openai";

// The same compact-edits result the PyAI test uses, so we exercise the SHARED
// reconstructor identically — only the wire envelope differs (OpenAI Chat
// Completions: choices[0].message.content is the JSON string).
const EDITS_JSON = JSON.stringify({
  clean_text: "The total is 55 dollars",
  edits: [
    { raw: "The the", replacement: "The", reason: "repetition" },
    { raw: "like ", replacement: "", reason: "filler" },
    { raw: "fifty, ", replacement: "", reason: "false_start" },
    { raw: "umm, ", replacement: "", reason: "filler" },
    { raw: "fifty five", replacement: "55", reason: "grammar" },
    { raw: " ahh", replacement: "", reason: "filler" },
    { raw: " yeah", replacement: "", reason: "filler" },
    { raw: " fifty five", replacement: "", reason: "repetition" },
  ],
});

const RAW = "The the total is like fifty, umm, fifty five dollars ahh yeah fifty five";

interface Captured {
  auth: string;
  body: any;
}

/** Stand up a mock /v1/chat/completions; `handler` decides each response. */
async function mockChatServer(
  handler: (cap: Captured, res: ServerResponse) => void,
): Promise<{ base: string; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body: any = {};
        try {
          body = JSON.parse(raw);
        } catch {
          /* leave {} */
        }
        handler({ auth: String(req.headers["authorization"] ?? ""), body }, res);
      });
    });
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://localhost:${port}/v1`, server });
    });
  });
}

const okChat = (content: string, res: ServerResponse) => {
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      id: "chatcmpl-1",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    }),
  );
};

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  delete process.env.OPENAI_BASE;
  delete process.env.OPENAI_RETRIES;
  delete process.env.OPENAI_CORRECTION_MODEL;
});

describe("OpenAiCorrection.correct (against a mock /v1/chat/completions)", () => {
  it("sends Bearer auth + json_schema and reconstructs the clean text", async () => {
    let seen: Captured | undefined;
    const { base, server } = await mockChatServer((cap, res) => {
      seen = cap;
      okChat(EDITS_JSON, res);
    });
    cleanup.push(() => server.close());
    process.env.OPENAI_BASE = base;
    process.env.OPENAI_CORRECTION_MODEL = "gpt-4o-mini";

    const result = await new OpenAiCorrection("test-key").correct(RAW);

    expect(result.valid).toBe(true);
    expect(result.cleanText).toBe("The total is 55 dollars");
    expect(result.edits.length).toBe(8);
    expect(result.ops.some((o) => o.type === "replace" && o.replacement === "55")).toBe(true);

    // request shape: auth header, model, and Structured Outputs json_schema
    expect(seen?.auth).toBe("Bearer test-key");
    expect(seen?.body.model).toBe("gpt-4o-mini");
    expect(seen?.body.response_format?.type).toBe("json_schema");
    expect(seen?.body.response_format?.json_schema?.strict).toBe(true);
    expect(seen?.body.messages?.[0]?.role).toBe("system");
  });

  it("throws on a Structured Outputs refusal", async () => {
    const { base, server } = await mockChatServer((_cap, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", refusal: "I can't help with that." } }],
        }),
      );
    });
    cleanup.push(() => server.close());
    process.env.OPENAI_BASE = base;

    await expect(new OpenAiCorrection("k").correct(RAW)).rejects.toThrow(/refused/i);
  });
});

describe("OpenAiCorrection.format", () => {
  it("returns formatted text and strips stray code fences", async () => {
    const { base, server } = await mockChatServer((_cap, res) =>
      okChat("```\nHere it is:\n\n1. Phone\n2. Laptop\n```", res),
    );
    cleanup.push(() => server.close());
    process.env.OPENAI_BASE = base;

    const out = await new OpenAiCorrection("k").format("here it is 1 phone 2 laptop");
    expect(out.text).toBe("Here it is:\n\n1. Phone\n2. Laptop");
  });
});

// Platform P1c — free-form rewrite, driven by command mode's classified instruction.
describe("OpenAiCorrection.rewrite", () => {
  it("sends the instruction + text and returns the rewritten text", async () => {
    let seen: Captured | undefined;
    const { base, server } = await mockChatServer((cap, res) => { seen = cap; okChat("Please find the attached report.", res); });
    cleanup.push(() => server.close());
    process.env.OPENAI_BASE = base;

    const out = await new OpenAiCorrection("k").rewrite("here's the report you asked for", "make it more formal");
    expect(out.text).toBe("Please find the attached report.");
    expect(seen?.body.messages?.[0]).toEqual({ role: "system", content: expect.stringContaining("rewrite") });
    expect(seen?.body.messages?.[1]?.content).toContain("make it more formal");
    expect(seen?.body.messages?.[1]?.content).toContain("here's the report you asked for");
  });

  it("strips stray code fences like format does", async () => {
    const { base, server } = await mockChatServer((_cap, res) => okChat("```\nShorter version.\n```", res));
    cleanup.push(() => server.close());
    process.env.OPENAI_BASE = base;

    const out = await new OpenAiCorrection("k").rewrite("a much longer version of the same text", "make it shorter");
    expect(out.text).toBe("Shorter version.");
  });

  it("falls back to the original text if the model returns nothing usable", async () => {
    const { base, server } = await mockChatServer((_cap, res) => okChat("   ", res));
    cleanup.push(() => server.close());
    process.env.OPENAI_BASE = base;

    const out = await new OpenAiCorrection("k").rewrite("keep me", "make it shorter");
    expect(out.text).toBe("keep me");
  });
});

// Phase 7 Fix 1 — per-request correction model override (OpenAI honours it).
describe("OpenAiCorrection model override (Phase 7)", () => {
  it("correct sends the per-request model in the body", async () => {
    let seen: Captured | undefined;
    const { base, server } = await mockChatServer((cap, res) => { seen = cap; okChat(EDITS_JSON, res); });
    cleanup.push(() => server.close());
    process.env.OPENAI_BASE = base;
    await new OpenAiCorrection("k").correct(RAW, { model: "gpt-4o-custom" });
    expect(seen?.body.model).toBe("gpt-4o-custom");
  });

  it("empty model does NOT override (default gpt-4o-mini)", async () => {
    let seen: Captured | undefined;
    const { base, server } = await mockChatServer((cap, res) => { seen = cap; okChat(EDITS_JSON, res); });
    cleanup.push(() => server.close());
    process.env.OPENAI_BASE = base;
    await new OpenAiCorrection("k").correct(RAW, { model: "" });
    expect(seen?.body.model).toBe("gpt-4o-mini");
  });

  it("empty model falls through to OPENAI_CORRECTION_MODEL", async () => {
    let seen: Captured | undefined;
    const { base, server } = await mockChatServer((cap, res) => { seen = cap; okChat(EDITS_JSON, res); });
    cleanup.push(() => server.close());
    process.env.OPENAI_BASE = base;
    process.env.OPENAI_CORRECTION_MODEL = "gpt-4o-env";
    await new OpenAiCorrection("k").correct(RAW, { model: "" });
    expect(seen?.body.model).toBe("gpt-4o-env");
  });

  it("format's 4th model param reaches the body", async () => {
    let seen: Captured | undefined;
    const { base, server } = await mockChatServer((cap, res) => { seen = cap; okChat("done", res); });
    cleanup.push(() => server.close());
    process.env.OPENAI_BASE = base;
    await new OpenAiCorrection("k").format("hello", "en", [], "gpt-4o-custom");
    expect(seen?.body.model).toBe("gpt-4o-custom");
  });
});

describe("OpenAiCorrection retry", () => {
  it("retries a transient 429 then succeeds", async () => {
    let hits = 0;
    const { base, server } = await mockChatServer((_cap, res) => {
      hits += 1;
      if (hits === 1) {
        res.statusCode = 429;
        res.end("rate limited");
        return;
      }
      okChat(EDITS_JSON, res);
    });
    cleanup.push(() => server.close());
    process.env.OPENAI_BASE = base;
    process.env.OPENAI_RETRIES = "3";

    const result = await new OpenAiCorrection("k").correct(RAW);
    expect(hits).toBe(2);
    expect(result.cleanText).toBe("The total is 55 dollars");
  });

  it("throws after exhausting retries on persistent 500", async () => {
    let hits = 0;
    const { base, server } = await mockChatServer((_cap, res) => {
      hits += 1;
      res.statusCode = 500;
      res.end("boom");
    });
    cleanup.push(() => server.close());
    process.env.OPENAI_BASE = base;
    process.env.OPENAI_RETRIES = "2";

    await expect(new OpenAiCorrection("k").correct(RAW)).rejects.toThrow(/500/);
    expect(hits).toBe(2);
  });
});
