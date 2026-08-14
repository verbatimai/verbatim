import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { OpenAiCorrection } from "./openai";

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  delete process.env.OPENAI_BASE;
  delete process.env.OPENAI_RETRIES;
});

function mockChatServer(content: string): Promise<{ base: string; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const payload = JSON.parse(raw);
        expect(payload.messages[0].role).toBe("system");
        expect(payload.messages[1].role).toBe("user");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    server.listen(0, () => resolve({ base: `http://localhost:${(server.address() as AddressInfo).port}/v1`, server }));
  });
}

describe("OpenAiCorrection", () => {
  it("posts to chat/completions and reconstructs clean text", async () => {
    const editsJson = JSON.stringify({
      clean_text: "hello world",
      edits: [{ raw: "um ", replacement: "", reason: "filler" }],
    });
    const { base, server } = await mockChatServer(editsJson);
    cleanup.push(() => server.close());
    process.env.OPENAI_BASE = base;

    const result = await new OpenAiCorrection("test-key").correct("um hello world");
    expect(result.valid).toBe(true);
    expect(result.cleanText).toBe("hello world");
  });

  it("retries transient 503 errors", async () => {
    let hits = 0;
    const { base, server: httpServer } = await new Promise<{ base: string; server: Server }>((resolve) => {
      const s = createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
          hits += 1;
          if (hits === 1) {
            res.statusCode = 503;
            res.end("unavailable");
            return;
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ choices: [{ message: { content: "Formatted." } }] }));
        });
      });
      s.listen(0, () => resolve({ base: `http://localhost:${(s.address() as AddressInfo).port}/v1`, server: s }));
    });
    cleanup.push(() => httpServer.close());
    process.env.OPENAI_BASE = base;
    process.env.OPENAI_RETRIES = "3";

    const out = await new OpenAiCorrection("k").format("hello");
    expect(hits).toBe(2);
    expect(out.text).toBe("Formatted.");
  });
});
