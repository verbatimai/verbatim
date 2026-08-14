import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { AddressInfo } from "node:net";
import { DeepgramSTT } from "./deepgram.stt";
import type { TranscriptEvent } from "./types";

// A mock that speaks Deepgram streaming: it captures the auth header + query string
// and the audio-frame count, then — on the first audio frame — streams a scripted
// sequence of Results/UtteranceEnd messages to exercise the REAL DeepgramSTT
// connect/parse/segment path without api.deepgram.com. Closes on CloseStream.
function mockDeepgram(script: unknown[]) {
  const wss = new WebSocketServer({ port: 0 });
  const seen = { auth: "", query: "", appends: 0, textMsgs: [] as string[] };
  wss.on("connection", (ws: WebSocket, req) => {
    seen.auth = String(req.headers["authorization"] ?? "");
    seen.query = req.url ?? "";
    let started = false;
    ws.on("message", (d, isBinary) => {
      if (isBinary) {
        seen.appends++;
        if (!started) {
          started = true;
          script.forEach((msg, i) =>
            setTimeout(() => {
              if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
            }, (i + 1) * 10),
          );
        }
        return;
      }
      const s = d.toString();
      seen.textMsgs.push(s);
      if (s.includes("CloseStream")) setTimeout(() => ws.close(), 5);
    });
  });
  const port = (wss.address() as AddressInfo).port;
  return { url: `ws://localhost:${port}`, seen, close: () => wss.close() };
}

// Drive one dictation: connect, push a frame (triggers the script), finalize, and
// collect every TranscriptEvent until the socket closes.
async function run(scriptUrlEnv: string): Promise<TranscriptEvent[]> {
  process.env.DEEPGRAM_WS_URL = scriptUrlEnv;
  const events: TranscriptEvent[] = [];
  const stt = new DeepgramSTT();
  const session = await stt.startSession({ apiKey: "key-abc" });
  await new Promise<void>((resolve) => {
    session.onTranscript((e) => events.push(e));
    session.onClose(() => resolve());
    setTimeout(async () => {
      session.sendAudio(new Uint8Array(640)); // 20ms @ 16k mono pcm16
      await session.finalize();
    }, 60);
  });
  return events;
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  delete process.env.DEEPGRAM_WS_URL;
  delete process.env.DEEPGRAM_BASE;
  delete process.env.DEEPGRAM_STT_MODEL;
});

describe("DeepgramSTT adapter (against a mock streaming server)", () => {
  it("sends auth + endpointing query, maps interim→active / is_final→stable, UtteranceEnd→one final", async () => {
    const mock = mockDeepgram([
      { type: "Results", is_final: false, channel: { alternatives: [{ transcript: "hello" }] } },
      { type: "Results", is_final: true, speech_final: false, channel: { alternatives: [{ transcript: "hello world" }] } },
      { type: "UtteranceEnd" },
    ]);
    cleanup.push(mock.close);

    const events = await run(mock.url);
    const partials = events.filter((e) => e.type === "partial");
    const finals = events.filter((e) => e.type === "final");

    // interim tail → activeText
    expect(partials.some((p) => p.activeText === "hello" && p.stableText === "")).toBe(true);
    // is_final locks into stableText (active cleared)
    expect(partials.some((p) => p.stableText === "hello world" && p.activeText === "")).toBe(true);
    // exactly one final, with endpoint
    expect(finals.length).toBe(1);
    expect(finals[0].text).toBe("hello world");
    expect(finals[0].stableText).toBe("hello world");
    expect(finals[0].endpoint).toBe(true);

    // wire assertions
    expect(mock.seen.auth).toBe("Token key-abc");
    expect(mock.seen.query).toContain("endpointing=300");
    expect(mock.seen.query).toContain("utterance_end_ms=1000");
    expect(mock.seen.query).toContain("smart_format=true");
    expect(mock.seen.query).toContain("model=nova-2");
    expect(mock.seen.appends).toBeGreaterThanOrEqual(1);
  });

  it("closes a segment on speech_final and de-duplicates a trailing UtteranceEnd", async () => {
    const mock = mockDeepgram([
      { type: "Results", is_final: true, speech_final: true, channel: { alternatives: [{ transcript: "one two" }] } },
      { type: "UtteranceEnd" }, // must NOT produce a second final
    ]);
    cleanup.push(mock.close);

    const events = await run(mock.url);
    const finals = events.filter((e) => e.type === "final");
    expect(finals.length).toBe(1);
    expect(finals[0].text).toBe("one two");
    expect(finals[0].endpoint).toBe(true);
  });
});

// 3.2 — auto-detect language. The mock captures the connect query; we assert the
// vendor params directly (no scripted transcript needed).
describe("DeepgramSTT auto-detect language (3.2)", () => {
  async function connectQuery(cfg: { language?: string; detectLanguage?: boolean; model?: string; keywords?: string[] }): Promise<string> {
    const mock = mockDeepgram([]);
    cleanup.push(mock.close);
    process.env.DEEPGRAM_WS_URL = mock.url;
    const stt = new DeepgramSTT();
    const session = await stt.startSession({ apiKey: "k", language: cfg.language, detectLanguage: cfg.detectLanguage, model: cfg.model, keywords: cfg.keywords });
    await new Promise<void>((resolve) => {
      session.onClose(() => resolve());
      setTimeout(() => { session.close(); resolve(); }, 120);
    });
    return mock.seen.query;
  }

  it("detectLanguage:true uses language=multi on streaming (detect_language is prerecorded-only and 400s on streaming)", async () => {
    const q = await connectQuery({ language: "fr", detectLanguage: true });
    expect(q).toContain("language=multi");
    // Must NOT send detect_language on the streaming socket (Deepgram 400s it).
    expect(q).not.toContain("detect_language");
  });

  it("detectLanguage unset sends language=fr and no detect_language", async () => {
    const q = await connectQuery({ language: "fr" });
    expect(q).toContain("language=fr");
    expect(q).not.toContain("detect_language");
  });

  // Phase 7 (Fix 1 + Fix 2) — per-session STT model override + the keyword-boost
  // param branching on the RESOLVED model, on the streaming socket.
  it("startSession({ model: 'nova-3' }) puts model=nova-3 on the connect query", async () => {
    const q = await connectQuery({ model: "nova-3" });
    expect(q).toContain("model=nova-3");
  });

  it("keyword boost branches on the per-user model: nova-3 uses keyterm, not keywords", async () => {
    const q = await connectQuery({ model: "nova-3", keywords: ["Verbatim"] });
    expect(q).toContain("keyterm=Verbatim");
    expect(q).not.toContain("keywords=");
  });

  it("empty model does NOT override (env unset ⇒ default nova-2)", async () => {
    const q = await connectQuery({ model: "" });
    expect(q).toContain("model=nova-2");
  });

  it("empty model falls through to DEEPGRAM_STT_MODEL when set", async () => {
    process.env.DEEPGRAM_STT_MODEL = "nova-3";
    const q = await connectQuery({ model: "" });
    expect(q).toContain("model=nova-3"); // env used when cfg is empty
  });

  it("cfg model wins over the env var", async () => {
    process.env.DEEPGRAM_STT_MODEL = "nova-3";
    const q = await connectQuery({ model: "nova-custom" });
    expect(q).toContain("model=nova-custom");
  });
});

describe("DeepgramSTT.transcribeBatch (against a mock /v1/listen)", () => {
  async function batchCall(cfg: { language?: string; detectLanguage?: boolean; model?: string; keywords?: string[] }): Promise<{ url: string; text: string; auth: string; ctype: string }> {
    let gotAuth = "", gotUrl = "", gotContentType = "";
    const server = await new Promise<{ base: string; server: Server }>((resolve) => {
      const s = createServer((req, res) => {
        gotAuth = String(req.headers["authorization"] ?? "");
        gotContentType = String(req.headers["content-type"] ?? "");
        gotUrl = req.url ?? "";
        req.on("data", () => {});
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "clean batch" }] }] } }));
        });
      });
      s.listen(0, () => resolve({ base: `http://localhost:${(s.address() as AddressInfo).port}/v1`, server: s }));
    });
    cleanup.push(() => server.server.close());
    process.env.DEEPGRAM_BASE = server.base;
    const pcm = new Uint8Array(3200); // 100ms @ 16k
    const text = await new DeepgramSTT().transcribeBatch!(pcm, { apiKey: "test-key", ...cfg });
    return { url: gotUrl, text, auth: gotAuth, ctype: gotContentType };
  }

  it("posts the WAV and returns the transcript", async () => {
    const r = await batchCall({});
    expect(r.text).toBe("clean batch");
    expect(r.auth).toBe("Token test-key");
    expect(r.url).toContain("/listen");
    expect(r.ctype).toBe("audio/wav");
  });

  it("passes the fixed language on the batch (authoritative) path", async () => {
    const r = await batchCall({ language: "es" });
    expect(r.url).toContain("language=es");
    expect(r.url).not.toContain("detect_language");
  });

  it("detectLanguage:true uses detect_language=true on the batch path (prerecorded supports it)", async () => {
    const r = await batchCall({ detectLanguage: true });
    expect(r.url).toContain("detect_language=true");
    expect(/[?&]language=/.test(r.url)).toBe(false);
  });

  // Phase 7 Fix 1 — model override on the AUTHORITATIVE batch path.
  it("threads model=nova-3 onto the batch request", async () => {
    const r = await batchCall({ model: "nova-3" });
    expect(r.url).toContain("model=nova-3");
  });

  it("empty batch model does NOT override (default nova-2)", async () => {
    const r = await batchCall({ model: "" });
    expect(r.url).toContain("model=nova-2");
  });

  it("empty batch model falls through to DEEPGRAM_STT_MODEL", async () => {
    process.env.DEEPGRAM_STT_MODEL = "nova-3";
    const r = await batchCall({ model: "" });
    expect(r.url).toContain("model=nova-3");
  });

  // Phase 7 Fix 2 — the keyword boost now also applies on the batch/finalize path,
  // with the SAME model-branch as streaming.
  it("keywords boost the batch request (nova-2 default ⇒ keywords=)", async () => {
    const r = await batchCall({ keywords: ["Verbatim", "PyAI"] });
    expect(r.url).toContain("keywords=Verbatim");
    expect(r.url).toContain("keywords=PyAI");
  });

  it("keyword boost uses keyterm= on nova-3 (via the model override)", async () => {
    const r = await batchCall({ model: "nova-3", keywords: ["Verbatim"] });
    expect(r.url).toContain("keyterm=Verbatim");
    expect(r.url).not.toContain("keywords=");
  });

  it("no keywords ⇒ neither keywords= nor keyterm= on the batch url (unchanged)", async () => {
    const r = await batchCall({});
    expect(r.url).not.toContain("keywords=");
    expect(r.url).not.toContain("keyterm=");
  });
});

// Regression — reported bug: "WebSocket was closed before the connection was
// established" surfacing as a stt.stream error. An instant start→stop (or just a
// slow vendor handshake) can call close() while the socket is still CONNECTING;
// the `ws` library then aborts the handshake and emits that exact message as an
// 'error'. It's a side effect of a close WE asked for, not a real stream failure,
// so onError() must stay silent for it while onClose() still fires normally.
describe("DeepgramSTT close() while still CONNECTING (regression)", () => {
  it("does not surface the handshake-abort error to onError, and still closes", async () => {
    // Accept the TCP connection but never complete the WS handshake, so the
    // socket stays CONNECTING until we close it ourselves.
    const server = createTcpServer(() => {});
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    process.env.DEEPGRAM_WS_URL = `ws://localhost:${port}`;

    const stt = new DeepgramSTT();
    const session = await stt.startSession({ apiKey: "k" });
    let errored: Error | undefined;
    let closed = false;
    session.onError((e) => { errored = e; });
    session.onClose(() => { closed = true; });
    session.close();
    await new Promise((r) => setTimeout(r, 50));

    expect(errored).toBeUndefined();
    expect(closed).toBe(true);

    server.close();
    delete process.env.DEEPGRAM_WS_URL;
  });

  it("still surfaces a genuine connection error that has nothing to do with our own close()", async () => {
    process.env.DEEPGRAM_WS_URL = "ws://127.0.0.1:1"; // nothing listens on port 1
    const stt = new DeepgramSTT();
    const session = await stt.startSession({ apiKey: "k" });
    const errored = await new Promise<Error | undefined>((resolve) => {
      session.onError((e) => resolve(e));
      setTimeout(() => resolve(undefined), 500);
    });
    expect(errored).toBeDefined();
    session.close();
    delete process.env.DEEPGRAM_WS_URL;
  });
});
