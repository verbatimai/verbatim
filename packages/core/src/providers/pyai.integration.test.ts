import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { PyAiSTT } from "./pyai.stt";
import { PyAiCorrection } from "../correction/pyai";
import { Pipeline } from "../pipeline";
import type { TranscriptEvent } from "./types";

// A mock that speaks PyAI Hear's real streaming wire format (session.created +
// transcript.partial with stable_text/active_text + transcript.final). Lets us
// exercise the REAL PyAiSTT adapter's connection/auth/parse/mapping/finalize
// without pyai.com.
function mockHearServer(finalText: string) {
  const wss = new WebSocketServer({ port: 0 });
  const received: string[] = [];
  wss.on("connection", (ws: WebSocket, req) => {
    received.push("AUTH:" + (req.headers["authorization"] ?? ""));
    ws.send(JSON.stringify({ type: "session.created", model: "hear-realtime-1", session_id: "s1" }));
    const partials = [
      { stable_text: "let's schedule", active_text: "a meeting" },
      { stable_text: "let's schedule a meeting at", active_text: "eightpm no no" },
    ];
    partials.forEach((p, i) =>
      setTimeout(
        () =>
          ws.send(
            JSON.stringify({
              type: "transcript.partial",
              utterance_id: "u1",
              stable_text: p.stable_text,
              active_text: p.active_text,
              text: `${p.stable_text} ${p.active_text}`.trim(),
              t_ms: (i + 1) * 100,
            }),
          ),
        (i + 1) * 15,
      ),
    );
    setTimeout(() => {
      ws.send(
        JSON.stringify({
          type: "transcript.final",
          utterance_id: "u1",
          stable_text: finalText,
          active_text: "",
          text: finalText,
          t_ms: 500,
        }),
      );
      setTimeout(() => ws.close(), 30);
    }, 60);
    ws.on("message", (d, isBinary) => {
      if (!isBinary) received.push("CTRL:" + d.toString());
    });
  });
  const port = (wss.address() as AddressInfo).port;
  return { url: `ws://localhost:${port}`, received, close: () => wss.close() };
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  delete process.env.PYAI_STT_WS_URL;
  delete process.env.PYAI_BASE;
});

describe("PyAiSTT adapter (against a faithful mock Hear server)", () => {
  it("connects with a Bearer header and maps stable/active/final", async () => {
    const finalText = "let's schedule a meeting at eightpm no no make it ninepm r i think that that works for me";
    const mock = mockHearServer(finalText);
    cleanup.push(mock.close);
    process.env.PYAI_STT_WS_URL = mock.url;

    const events: TranscriptEvent[] = [];
    const stt = new PyAiSTT();
    const session = await stt.startSession({ apiKey: "test-key-123" });
    await new Promise<void>((resolve) => {
      session.onTranscript((e) => events.push(e));
      session.onClose(() => resolve());
    });

    const partials = events.filter((e) => e.type === "partial");
    const finals = events.filter((e) => e.type === "final");
    expect(partials.length).toBeGreaterThanOrEqual(2);
    expect(partials[0].stableText).toBe("let's schedule");
    expect(partials[0].activeText).toBe("a meeting");
    expect(finals.length).toBe(1);
    expect(finals[0].text).toBe(finalText);
    // the adapter forwarded the Bearer auth header on the WS upgrade
    expect(mock.received.some((r) => r.startsWith("AUTH:Bearer test-key-123"))).toBe(true);
  });

  it("handles sliding stable_text, noise messages, raw_text finals and rollover cleanly", async () => {
    // A mock that reproduces Hear's real quirks: session.created + usage.delta
    // noise, a SLIDING stable_text (drops words off the front), a final carrying
    // only `raw_text`, then a SECOND utterance with a fresh utterance_id.
    const wss = new WebSocketServer({ port: 0 });
    cleanup.push(() => wss.close());
    wss.on("connection", (ws: WebSocket) => {
      const emit = (o: unknown, ms: number) => setTimeout(() => ws.send(JSON.stringify(o)), ms);
      emit({ type: "session.created", session_id: "s1" }, 5);
      emit({ type: "usage.delta", usage: { audio_ms: 100 } }, 10); // noise -> ignored
      // Utterance 1: `text` is full; stable_text is a sliding window.
      emit({ type: "transcript.partial", utterance_id: "u1", text: "i am testing", stable_text: "i am testing", active_text: "testing", t_ms: 100 }, 15);
      emit({ type: "transcript.partial", utterance_id: "u1", text: "i am testing the live input", stable_text: "the live input", active_text: "input", t_ms: 200 }, 25);
      emit({ type: "usage.delta", usage: { audio_ms: 300 } }, 30); // noise -> ignored
      emit({ type: "transcript.final", utterance_id: "u1", raw_text: "i am testing the live input", endpoint_reason: "vad", t_ms: 300 }, 40);
      // Utterance 2: fresh id.
      emit({ type: "transcript.partial", utterance_id: "u2", text: "and it should not", stable_text: "and it should not", active_text: "not", t_ms: 400 }, 55);
      emit({ type: "transcript.final", utterance_id: "u2", text: "and it should not duplicate words", endpoint_reason: "vad", t_ms: 500 }, 65);
      setTimeout(() => ws.close(), 90);
    });
    process.env.PYAI_STT_WS_URL = `ws://localhost:${(wss.address() as AddressInfo).port}`;

    const { TranscriptAccumulator } = await import("../pipeline");
    const acc = new TranscriptAccumulator();
    const events: TranscriptEvent[] = [];
    const stt = new PyAiSTT();
    const session = await stt.startSession({ apiKey: "k" });
    await new Promise<void>((resolve) => {
      session.onTranscript((e) => { events.push(e); acc.push(e); });
      session.onClose(() => resolve());
    });

    // raw_text-only final was mapped to `text` (never dropped as empty).
    const finals = events.filter((e) => e.type === "final");
    expect(finals.length).toBe(2);
    expect(finals[0].text).toBe("i am testing the live input");
    expect(finals[0].endpoint).toBe(true);
    // Two utterances stitched in order, no duplication from the sliding windows.
    expect(acc.final()).toBe("i am testing the live input and it should not duplicate words");
  });

  it("drives the full Pipeline (STT -> segmenter -> correction) to a clean result", async () => {
    const finalText = "let's schedule a meeting at eightpm no no make it ninepm r i think that that works for me";
    const mock = mockHearServer(finalText);
    cleanup.push(mock.close);
    process.env.PYAI_STT_WS_URL = mock.url;

    const { MockCorrection } = await import("../correction/mock");
    let correction: any = null;
    const pipeline = new Pipeline(new PyAiSTT(), new MockCorrection(), {
      onCorrection: (u) => (correction = u),
    });
    await pipeline.run(); // mock self-drives + closes

    expect(correction).not.toBeNull();
    expect(correction.result.valid).toBe(true);
    expect(correction.result.cleanText).toBe("let's schedule a meeting at 9 pm i think that works for me");
  });
});

// A mock that returns PyAI's Anthropic-Messages shape so the REAL PyAiCorrection
// adapter's request/parse/reconstruct path is exercised without pyai.com.
function mockMessagesServer(): Promise<{ base: string; server: Server; captured: { body: any } }> {
  const captured: { body: any } = { body: null };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try { captured.body = JSON.parse(raw); } catch { captured.body = null; }
        const editsJson = JSON.stringify({
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
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ role: "assistant", content: [{ type: "text", text: editsJson }], stop_reason: "end_turn" }));
      });
    });
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://localhost:${port}`, server, captured });
    });
  });
}

describe("PyAiSTT.transcribeBatch (against a mock /v1/audio/transcriptions)", () => {
  it("posts the WAV and returns the clean transcript", async () => {
    let gotContentType = "";
    const server = await new Promise<{ base: string; server: Server }>((resolve) => {
      const s = createServer((req, res) => {
        gotContentType = String(req.headers["content-type"] ?? "");
        let bytes = 0;
        req.on("data", (c) => (bytes += c.length));
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ text: "the clean batch transcript" }));
        });
      });
      s.listen(0, () => resolve({ base: `http://localhost:${(s.address() as AddressInfo).port}`, server: s }));
    });
    cleanup.push(() => server.server.close());
    process.env.PYAI_BASE = server.base;

    const pcm = new Uint8Array(3200); // 100ms @16k
    const text = await new PyAiSTT().transcribeBatch!(pcm, { apiKey: "test-key" });
    expect(text).toBe("the clean batch transcript");
    expect(gotContentType).toContain("multipart/form-data"); // sent as a file upload
  });
});

describe("PyAiCorrection retry (PyAI is flaky under stress)", () => {
  it("retries a transient 503 on format() and then succeeds", async () => {
    let hits = 0;
    const server = await new Promise<{ base: string; server: Server }>((resolve) => {
      const s = createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
          hits += 1;
          if (hits === 1) {
            res.statusCode = 503;
            res.end("service unavailable");
            return;
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Here it is:\n\n1. Phone\n2. Laptop" }] }));
        });
      });
      s.listen(0, () => resolve({ base: `http://localhost:${(s.address() as AddressInfo).port}`, server: s }));
    });
    cleanup.push(() => server.server.close());
    process.env.PYAI_BASE = server.base;
    process.env.PYAI_RETRIES = "3";

    const out = await new PyAiCorrection("k").format("here it is 1 phone 2 laptop");
    expect(hits).toBe(2); // failed once, retried, succeeded
    expect(out.text).toBe("Here it is:\n\n1. Phone\n2. Laptop"); // newlines preserved, no fences
    delete process.env.PYAI_RETRIES;
  });

  it("throws after exhausting retries on persistent 5xx", async () => {
    let hits = 0;
    const server = await new Promise<{ base: string; server: Server }>((resolve) => {
      const s = createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => { hits += 1; res.statusCode = 500; res.end("boom"); });
      });
      s.listen(0, () => resolve({ base: `http://localhost:${(s.address() as AddressInfo).port}`, server: s }));
    });
    cleanup.push(() => server.server.close());
    process.env.PYAI_BASE = server.base;
    process.env.PYAI_RETRIES = "2";

    await expect(new PyAiCorrection("k").format("x")).rejects.toThrow(/500/);
    expect(hits).toBe(2);
    delete process.env.PYAI_RETRIES;
  });
});

describe("PyAiCorrection adapter (against a mock /v1/messages)", () => {
  it("posts, parses the Anthropic body, and reconstructs the clean text", async () => {
    const { base, server } = await mockMessagesServer();
    cleanup.push(() => server.close());
    process.env.PYAI_BASE = base;

    const result = await new PyAiCorrection("test-key").correct(
      "The the total is like fifty, umm, fifty five dollars ahh yeah fifty five",
    );
    expect(result.valid).toBe(true);
    expect(result.cleanText).toBe("The total is 55 dollars");
    expect(result.edits.length).toBe(8);
    expect(result.ops.some((o) => o.type === "replace" && o.replacement === "55")).toBe(true);
  });
});

// Phase 7 Fix 1 — PyAI STT is single-model: any `cfg.model` is a documented no-op,
// the adapter always uses pyai-hear on both the streaming URL and the batch body.
describe("PyAiSTT single-model no-op (Phase 7)", () => {
  it("startSession ignores model and still connects with model=pyai-hear", async () => {
    const wss = new WebSocketServer({ port: 0 });
    cleanup.push(() => wss.close());
    let seenUrl = "";
    wss.on("connection", (ws: WebSocket, req) => { seenUrl = req.url ?? ""; setTimeout(() => ws.close(), 20); });
    process.env.PYAI_STT_WS_URL = `ws://localhost:${(wss.address() as AddressInfo).port}`;
    const session = await new PyAiSTT().startSession({ apiKey: "k", model: "some-other-model" });
    await new Promise((r) => setTimeout(r, 60));
    session.close();
    expect(seenUrl).toContain("model=pyai-hear");
    expect(seenUrl).not.toContain("some-other-model");
  });

  it("transcribeBatch ignores model and still posts model=pyai-hear", async () => {
    let raw = "";
    const server = await new Promise<{ base: string; server: Server }>((resolve) => {
      const s = createServer((req, res) => {
        req.on("data", (c) => (raw += c.toString()));
        req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ text: "ok" })); });
      });
      s.listen(0, () => resolve({ base: `http://localhost:${(s.address() as AddressInfo).port}`, server: s }));
    });
    cleanup.push(() => server.server.close());
    process.env.PYAI_BASE = server.base;
    await new PyAiSTT().transcribeBatch!(new Uint8Array(3200), { apiKey: "k", model: "some-other-model" });
    expect(raw).toContain("pyai-hear");
    expect(raw).not.toContain("some-other-model");
  });
});

// Phase 7 Fix 1 — PyAI correction SENDS the resolved model on the wire (uniform
// threading), even though the PyAI server ignores it (findings F4) — a documented no-op.
describe("PyAiCorrection model override (Phase 7 — sent on the wire; server ignores, F4)", () => {
  afterEach(() => { delete process.env.PYAI_MODEL; });

  it("correct sends the per-request model in the request body", async () => {
    const { base, server, captured } = await mockMessagesServer();
    cleanup.push(() => server.close());
    process.env.PYAI_BASE = base;
    await new PyAiCorrection("k").correct("The the total is fifty five", { model: "custom-x" });
    expect(captured.body.model).toBe("custom-x");
  });

  it("empty model does NOT override (default gpt-5.6-sol on the wire)", async () => {
    const { base, server, captured } = await mockMessagesServer();
    cleanup.push(() => server.close());
    process.env.PYAI_BASE = base;
    await new PyAiCorrection("k").correct("The the total is fifty five", { model: "" });
    expect(captured.body.model).toBe("gpt-5.6-sol");
  });

  it("empty model falls through to PYAI_MODEL", async () => {
    const { base, server, captured } = await mockMessagesServer();
    cleanup.push(() => server.close());
    process.env.PYAI_BASE = base;
    process.env.PYAI_MODEL = "pyai-env-model";
    await new PyAiCorrection("k").correct("The the total is fifty five", { model: "" });
    expect(captured.body.model).toBe("pyai-env-model");
  });
});
