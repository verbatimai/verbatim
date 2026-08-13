import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { AddressInfo } from "node:net";
import { userMessage, formatMessage } from "./prompt";
import { DeepgramSTT } from "../providers/deepgram.stt";

describe("vocabulary → prompt injection (3.4)", () => {
  it("formatMessage injects the term list when provided (the effective lever)", () => {
    const m = formatMessage("call me Xa Long", undefined, ["Xa Long", "Verbatim"]);
    expect(m).toContain("Known terms");
    expect(m).toContain("Xa Long");
    expect(m).toContain("Verbatim");
  });

  it("userMessage also carries the term list (harmless parity on the correction turn)", () => {
    const m = userMessage("call me Xa Long", undefined, undefined, ["Xa Long", "Verbatim"]);
    expect(m).toContain("Xa Long");
    expect(m).toContain("Verbatim");
  });

  it("empty/undefined vocabulary is byte-identical to today (no vocab line)", () => {
    expect(userMessage("hi")).toBe(userMessage("hi", undefined, undefined, []));
    expect(userMessage("hi")).toBe(userMessage("hi", undefined, undefined, undefined));
    expect(formatMessage("hi")).toBe(formatMessage("hi", undefined, []));
    expect(userMessage("hi")).not.toMatch(/Known terms/);
    expect(formatMessage("hi")).not.toMatch(/Known terms/);
  });
});

// A minimal mock that only captures the connect query string (no scripted messages) —
// enough to assert Deepgram's keyword-boost params (3.4) reach the wire.
function mockDeepgramQuery() {
  const wss = new WebSocketServer({ port: 0 });
  const seen = { query: "" };
  wss.on("connection", (ws: WebSocket, req) => {
    seen.query = req.url ?? "";
    ws.close();
  });
  const port = (wss.address() as AddressInfo).port;
  return { url: `ws://localhost:${port}`, seen, close: () => wss.close() };
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  delete process.env.DEEPGRAM_WS_URL;
  delete process.env.DEEPGRAM_STT_MODEL;
});

describe("Deepgram keyword-boost (3.4)", () => {
  async function connectQuery(cfg: { keywords?: string[] }): Promise<string> {
    const mock = mockDeepgramQuery();
    cleanup.push(mock.close);
    process.env.DEEPGRAM_WS_URL = mock.url;
    const stt = new DeepgramSTT();
    const session = await stt.startSession({ apiKey: "k", keywords: cfg.keywords });
    await new Promise<void>((resolve) => {
      session.onClose(() => resolve());
      setTimeout(resolve, 200); // safety net if the socket never opens
    });
    return mock.seen.query;
  }

  it("adds nova-2 `keywords` params when given (default model)", async () => {
    const q = await connectQuery({ keywords: ["Verbatim", "Xa Long"] });
    expect(q).toContain("keywords=Verbatim");
    expect(q).toContain("keywords=Xa+Long"); // URLSearchParams encodes the space
    expect(q).not.toContain("keyterm="); // nova-2 uses `keywords`, not `keyterm`
  });

  it("uses `keyterm` for nova-3", async () => {
    process.env.DEEPGRAM_STT_MODEL = "nova-3";
    const q = await connectQuery({ keywords: ["Verbatim"] });
    expect(q).toContain("keyterm=Verbatim");
    expect(q).not.toContain("keywords=");
  });

  it("adds no keyword params when none are given", async () => {
    const q = await connectQuery({});
    expect(q).not.toContain("keywords=");
    expect(q).not.toContain("keyterm=");
  });
});
