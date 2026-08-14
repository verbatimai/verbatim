import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { AddressInfo } from "node:net";
import { OpenAiSTT } from "./openai.stt";
import type { TranscriptEvent } from "./types";

// A mock that speaks OpenAI Realtime transcription: it captures the auth/beta
// headers + the session config, counts audio appends, and — on commit — streams
// delta chunks followed by a completed transcript. Exercises the REAL OpenAiSTT
// connect/config/append/parse/finalize path without api.openai.com.
function mockRealtimeServer(deltas: string[], completed: string) {
  const wss = new WebSocketServer({ port: 0 });
  const seen = { auth: "", beta: "", config: null as any, appends: 0 };
  wss.on("connection", (ws: WebSocket, req) => {
    seen.auth = String(req.headers["authorization"] ?? "");
    seen.beta = String(req.headers["openai-beta"] ?? "");
    ws.send(JSON.stringify({ type: "session.created" }));
    ws.on("message", (d, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(d.toString());
      if (m.type === "session.update") seen.config = m.session;
      else if (m.type === "input_audio_buffer.append") seen.appends++;
      else if (m.type === "input_audio_buffer.commit") {
        deltas.forEach((delta, i) =>
          setTimeout(
            () =>
              ws.send(
                JSON.stringify({
                  type: "conversation.item.input_audio_transcription.delta",
                  item_id: "it1",
                  delta,
                }),
              ),
            (i + 1) * 10,
          ),
        );
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              type: "conversation.item.input_audio_transcription.completed",
              item_id: "it1",
              transcript: completed,
            }),
          );
          setTimeout(() => ws.close(), 20);
        }, (deltas.length + 1) * 10);
      }
    });
  });
  const port = (wss.address() as AddressInfo).port;
  return { url: `ws://localhost:${port}`, seen, close: () => wss.close() };
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  delete process.env.OPENAI_REALTIME_WS_URL;
  delete process.env.OPENAI_BASE;
  delete process.env.OPENAI_STT_MODEL;
  delete process.env.OPENAI_BATCH_MODEL;
});

describe("OpenAiSTT adapter (against a mock Realtime server)", () => {
  it("configures pcm16, sends base64 audio, and maps delta→active / completed→final", async () => {
    const mock = mockRealtimeServer(["hello", " world"], "Hello world.");
    cleanup.push(mock.close);
    process.env.OPENAI_REALTIME_WS_URL = mock.url;

    const events: TranscriptEvent[] = [];
    const stt = new OpenAiSTT();
    expect(stt.audio.sampleRate).toBe(24000); // OpenAI Realtime wants 24 kHz
    const session = await stt.startSession({ apiKey: "key-abc" });

    await new Promise<void>((resolve) => {
      session.onTranscript((e) => events.push(e));
      session.onClose(() => resolve());
      // let the socket open + config flush, then push audio and finalize
      setTimeout(async () => {
        session.sendAudio(new Uint8Array(960)); // 20ms @ 24k mono pcm16
        await session.finalize();
      }, 60);
    });

    const partials = events.filter((e) => e.type === "partial");
    const finals = events.filter((e) => e.type === "final");
    // deltas accumulate into the active tail
    expect(partials.at(-1)?.activeText).toBe("hello world");
    expect(partials.at(-1)?.stableText).toBe("");
    // completed → one clean final with endpoint
    expect(finals.length).toBe(1);
    expect(finals[0].text).toBe("Hello world.");
    expect(finals[0].stableText).toBe("Hello world.");
    expect(finals[0].endpoint).toBe(true);

    // wire assertions
    expect(mock.seen.auth).toBe("Bearer key-abc");
    expect(mock.seen.beta).toBe(""); // GA: no OpenAI-Beta header
    expect(mock.seen.config?.type).toBe("transcription");
    expect(mock.seen.config?.audio?.input?.format?.type).toBe("audio/pcm");
    expect(mock.seen.config?.audio?.input?.transcription?.model).toBeTruthy();
    expect(mock.seen.appends).toBeGreaterThanOrEqual(1);
  });
});

// 3.2 — auto-detect language. Assert the transcription_session.update config: on
// detect there is NO `language` key (model default); off, it's present.
describe("OpenAiSTT auto-detect language (3.2)", () => {
  async function seenConfig(cfg: { language?: string; detectLanguage?: boolean; model?: string }): Promise<any> {
    const mock = mockRealtimeServer([], "");
    cleanup.push(mock.close);
    process.env.OPENAI_REALTIME_WS_URL = mock.url;
    const stt = new OpenAiSTT();
    const session = await stt.startSession({ apiKey: "k", language: cfg.language, detectLanguage: cfg.detectLanguage, model: cfg.model });
    // Let the socket open + the config frame flush, then tear down.
    await new Promise((r) => setTimeout(r, 80));
    session.close();
    return mock.seen.config;
  }

  it("detectLanguage:true omits the language field in transcription_session.update", async () => {
    const config = await seenConfig({ language: "fr", detectLanguage: true });
    expect(config?.audio?.input?.transcription).toBeTruthy();
    expect("language" in config.audio.input.transcription).toBe(false);
  });

  it("detectLanguage unset keeps the language field", async () => {
    const config = await seenConfig({ language: "fr" });
    expect(config?.audio?.input?.transcription?.language).toBe("fr");
  });
});

// Phase 7 Fix 1 — the Settings model field maps to the STREAMING model
// (transcription_session.update.input_audio_transcription.model).
describe("OpenAiSTT streaming model override (Phase 7)", () => {
  async function seenConfig(cfg: { model?: string }): Promise<any> {
    const mock = mockRealtimeServer([], "");
    cleanup.push(mock.close);
    process.env.OPENAI_REALTIME_WS_URL = mock.url;
    const stt = new OpenAiSTT();
    const session = await stt.startSession({ apiKey: "k", model: cfg.model });
    await new Promise((r) => setTimeout(r, 80));
    session.close();
    return mock.seen.config;
  }

  it("uses the passed streaming model", async () => {
    const config = await seenConfig({ model: "gpt-live-custom" });
    expect(config?.audio?.input?.transcription?.model).toBe("gpt-live-custom");
  });

  it("empty model does NOT override (default gpt-4o-mini-transcribe)", async () => {
    const config = await seenConfig({ model: "" });
    expect(config?.audio?.input?.transcription?.model).toBe("gpt-4o-mini-transcribe");
  });

  it("empty model falls through to OPENAI_STT_MODEL", async () => {
    process.env.OPENAI_STT_MODEL = "gpt-live-env";
    const config = await seenConfig({ model: "" });
    expect(config?.audio?.input?.transcription?.model).toBe("gpt-live-env");
  });
});

describe("OpenAiSTT.transcribeBatch (against a mock /v1/audio/transcriptions)", () => {
  it("posts the WAV as multipart and returns the transcript", async () => {
    let gotContentType = "";
    let gotAuth = "";
    const server = await new Promise<{ base: string; server: Server }>((resolve) => {
      const s = createServer((req, res) => {
        gotContentType = String(req.headers["content-type"] ?? "");
        gotAuth = String(req.headers["authorization"] ?? "");
        req.on("data", () => {});
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ text: "the clean batch transcript" }));
        });
      });
      s.listen(0, () => resolve({ base: `http://localhost:${(s.address() as AddressInfo).port}/v1`, server: s }));
    });
    cleanup.push(() => server.server.close());
    process.env.OPENAI_BASE = server.base;

    const pcm = new Uint8Array(4800); // 100ms @ 24k
    const text = await new OpenAiSTT().transcribeBatch!(pcm, { apiKey: "test-key" });
    expect(text).toBe("the clean batch transcript");
    expect(gotContentType).toContain("multipart/form-data");
    expect(gotAuth).toBe("Bearer test-key");
  });

  // Phase 7 Fix 1 (OpenAI split, open-question #2) — the batch endpoint keeps its OWN
  // model resolution (OPENAI_BATCH_MODEL ?? "gpt-transcribe") and MUST NOT use cfg.model:
  // the streaming model name would 400 the Whisper-family batch endpoint. We capture the
  // raw multipart body to read the `model` field the adapter sent.
  async function batchBody(cfg: { apiKey: string; model?: string }): Promise<string> {
    let raw = "";
    const server = await new Promise<{ base: string; server: Server }>((resolve) => {
      const s = createServer((req, res) => {
        req.on("data", (c) => (raw += c.toString()));
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ text: "ok" }));
        });
      });
      s.listen(0, () => resolve({ base: `http://localhost:${(s.address() as AddressInfo).port}/v1`, server: s }));
    });
    cleanup.push(() => server.server.close());
    process.env.OPENAI_BASE = server.base;
    await new OpenAiSTT().transcribeBatch!(new Uint8Array(4800), cfg);
    return raw;
  }

  it("ignores cfg.model on batch and defaults to gpt-4o-mini-transcribe", async () => {
    // A streaming-only model name is passed but must NOT reach the batch endpoint.
    const body = await batchBody({ apiKey: "k", model: "gpt-live-custom" });
    expect(body).toContain("gpt-4o-mini-transcribe");
    expect(body).not.toContain("gpt-live-custom");
  });

  it("uses OPENAI_BATCH_MODEL when set (independent of cfg.model)", async () => {
    process.env.OPENAI_BATCH_MODEL = "gpt-transcribe-custom";
    const body = await batchBody({ apiKey: "k", model: "gpt-live-custom" });
    expect(body).toContain("gpt-transcribe-custom");
  });
});

// Regression — same underlying bug as Deepgram: calling close() while the socket
// is still CONNECTING (e.g. an instant start→stop) makes the `ws` library abort
// the handshake and emit "WebSocket was closed before the connection was
// established" as an 'error'. That's a side effect of a close WE asked for, not a
// real stream failure, so onError() must stay silent while onClose() still fires.
describe("OpenAiSTT close() while still CONNECTING (regression)", () => {
  it("does not surface the handshake-abort error to onError, and still closes", async () => {
    const server = createTcpServer(() => {}); // accept but never complete the WS handshake
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    process.env.OPENAI_REALTIME_WS_URL = `ws://localhost:${port}`;

    const stt = new OpenAiSTT();
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
    delete process.env.OPENAI_REALTIME_WS_URL;
  });
});
