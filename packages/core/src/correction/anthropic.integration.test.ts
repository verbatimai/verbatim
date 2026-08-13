import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { AnthropicCorrection } from "./anthropic";

// A mock that speaks Anthropic's real forced-tool-use shape (a `tool_use`
// content block whose `input` is already a parsed object) so the REAL
// AnthropicCorrection adapter's request/parse/reconstruct path is exercised
// without api.anthropic.com.
function mockMessagesServer(build: (raw: string) => unknown): Promise<{ base: string; server: Server; requests: any[] }> {
  const requests: any[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const parsed = JSON.parse(raw);
        requests.push({ headers: req.headers, body: parsed });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(build(raw)));
      });
    });
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://localhost:${port}`, server, requests });
    });
  });
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  delete process.env.ANTHROPIC_BASE;
});

describe("AnthropicCorrection.correct (against a mock /v1/messages, forced tool-use)", () => {
  it("sends the tool_choice + input_schema, and reconstructs the tool_use input", async () => {
    const toolUseBody = () => ({
      role: "assistant",
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "emit_correction",
          input: {
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
          },
        },
      ],
    });
    const { base, server, requests } = await mockMessagesServer(toolUseBody);
    cleanup.push(() => server.close());
    process.env.ANTHROPIC_BASE = base;

    const result = await new AnthropicCorrection("test-key").correct(
      "The the total is like fifty, umm, fifty five dollars ahh yeah fifty five",
    );

    expect(result.valid).toBe(true);
    expect(result.cleanText).toBe("The total is 55 dollars");
    expect(result.edits.length).toBe(8);
    expect(result.ops.some((o) => o.type === "replace" && o.replacement === "55")).toBe(true);

    // request shape: auth header + forced tool-use.
    const req = requests[0];
    expect(req.headers["x-api-key"]).toBe("test-key");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.body.tool_choice).toEqual({ type: "tool", name: "emit_correction" });
    expect(req.body.tools[0].name).toBe("emit_correction");
    expect(req.body.tools[0].input_schema.required).toEqual(["clean_text", "edits"]);
  });

  it("falls back to the model's clean_text when edits don't reconstruct it (drift)", async () => {
    const { base, server } = await mockMessagesServer(() => ({
      role: "assistant",
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          name: "emit_correction",
          input: { clean_text: "totally different text", edits: [{ raw: "nope not in raw", replacement: "", reason: "filler" }] },
        },
      ],
    }));
    cleanup.push(() => server.close());
    process.env.ANTHROPIC_BASE = base;

    const result = await new AnthropicCorrection("k").correct("some raw transcript");
    expect(result.valid).toBe(false);
    expect(result.cleanText).toBe("totally different text");
  });

  it("throws with the response body on a non-2xx", async () => {
    const server = await new Promise<{ base: string; server: Server }>((resolve) => {
      const s = createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
          res.statusCode = 401;
          res.end("invalid x-api-key");
        });
      });
      s.listen(0, () => resolve({ base: `http://localhost:${(s.address() as AddressInfo).port}`, server: s }));
    });
    cleanup.push(() => server.server.close());
    process.env.ANTHROPIC_BASE = server.base;

    await expect(new AnthropicCorrection("bad-key").correct("hello")).rejects.toThrow(/401/);
  });
});

describe("AnthropicCorrection.format (plain text pass, no tool)", () => {
  it("posts the format prompt and strips stray code fences", async () => {
    const { base, server, requests } = await mockMessagesServer(() => ({
      role: "assistant",
      content: [{ type: "text", text: "```\nHere it is:\n\n1. Phone\n2. Laptop\n```" }],
    }));
    cleanup.push(() => server.close());
    process.env.ANTHROPIC_BASE = base;

    const out = await new AnthropicCorrection("k").format("here it is 1 phone 2 laptop");
    expect(out.text).toBe("Here it is:\n\n1. Phone\n2. Laptop");
    expect(requests[0].body.tools).toBeUndefined(); // format is a plain rewrite, no forced tool
  });
});
