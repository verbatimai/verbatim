import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { PyAiIntent } from "./pyai";
import { OpenAiIntent } from "./openai";
import { AnthropicIntent } from "./anthropic";

// Spin a local HTTP mock so the adapters are verified end-to-end (request shape +
// response parsing + validate-or-noop) with NO external network — the same pattern
// as providers/*.integration.test.ts. `reply` returns the JSON body for one call
// and captures the request for assertions.
function mockServer(reply: (path: string, body: any) => any): Promise<{ server: Server; base: string; last: () => { path: string; body: any; headers: any } }> {
  let last: any = null;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? JSON.parse(raw) : {};
        last = { path: req.url, body, headers: req.headers };
        const out = reply(req.url ?? "", body);
        res.writeHead(out.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(out.json));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}/v1`, last: () => last });
    });
  });
}

let active: Server | null = null;
afterEach(() => {
  active?.close();
  active = null;
  delete process.env.PYAI_BASE;
  delete process.env.OPENAI_BASE;
  delete process.env.ANTHROPIC_BASE;
});

describe("PyAiIntent (JSON-in-text)", () => {
  it("sends the right request and parses a valid command", async () => {
    const m = await mockServer(() => ({
      status: 200,
      json: { content: [{ type: "text", text: '{"action":"delete","target":"selection"}' }] },
    }));
    active = m.server;
    process.env.PYAI_BASE = m.base;

    const r = await new PyAiIntent("test-key").interpret("scratch that whole thing");
    expect(r.valid).toBe(true);
    expect(r.intent).toEqual({ action: "delete", target: "selection" });
    // request assertions
    expect(m.last().path).toBe("/v1/messages");
    expect(m.last().headers.authorization).toBe("Bearer test-key");
    expect(m.last().body.system).toContain("ONE editing action");
  });

  it("falls back to noop when the model returns non-JSON", async () => {
    const m = await mockServer(() => ({ status: 200, json: { content: [{ type: "text", text: "sorry, no idea" }] } }));
    active = m.server;
    process.env.PYAI_BASE = m.base;

    const r = await new PyAiIntent("k").interpret("do a barrel roll");
    expect(r.valid).toBe(false);
    expect(r.intent.action).toBe("noop");
  });
});

describe("OpenAiIntent (json_object)", () => {
  it("parses a valid command from a chat completion", async () => {
    const m = await mockServer(() => ({
      status: 200,
      json: { choices: [{ message: { content: '{"action":"insert","what":"newline"}' } }] },
    }));
    active = m.server;
    process.env.OPENAI_BASE = m.base;

    const r = await new OpenAiIntent("k").interpret("new line");
    expect(r.valid).toBe(true);
    expect(r.intent).toEqual({ action: "insert", what: "newline" });
    expect(m.last().path).toBe("/v1/chat/completions");
    expect(m.last().body.response_format).toEqual({ type: "json_object" });
  });

  it("noops on a safety refusal", async () => {
    const m = await mockServer(() => ({ status: 200, json: { choices: [{ message: { refusal: "no" } }] } }));
    active = m.server;
    process.env.OPENAI_BASE = m.base;

    const r = await new OpenAiIntent("k").interpret("x");
    expect(r.valid).toBe(false);
    expect(r.intent.action).toBe("noop");
  });
});

describe("AnthropicIntent (forced tool-use)", () => {
  it("reads the tool_use input and validates it", async () => {
    const m = await mockServer(() => ({
      status: 200,
      json: { content: [{ type: "tool_use", name: "emit_command", input: { action: "format", style: "bold", target: "selection" } }] },
    }));
    active = m.server;
    process.env.ANTHROPIC_BASE = m.base;

    const r = await new AnthropicIntent("k").interpret("bold that");
    expect(r.valid).toBe(true);
    expect(r.intent).toEqual({ action: "format", style: "bold", target: "selection" });
    expect(m.last().path).toBe("/v1/messages");
    expect(m.last().headers["x-api-key"]).toBe("k");
    expect(m.last().body.tool_choice).toEqual({ type: "tool", name: "emit_command" });
  });

  it("noops when the tool input is out of grammar", async () => {
    const m = await mockServer(() => ({
      status: 200,
      json: { content: [{ type: "tool_use", name: "emit_command", input: { action: "format", style: "sparkle", target: "all" } }] },
    }));
    active = m.server;
    process.env.ANTHROPIC_BASE = m.base;

    const r = await new AnthropicIntent("k").interpret("sparkle that");
    expect(r.valid).toBe(false);
    expect(r.intent.action).toBe("noop");
  });
});
