import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
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
    ws.send(JSON.stringify({ type: "transcription_session.created" }));
    ws.on("message", (d, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(d.toString());
      if (m.type === "transcription_session.update") seen.config = m.session;
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
    expect(mock.seen.beta).toBe("realtime=v1");
    expect(mock.seen.config?.input_audio_format).toBe("pcm16");
    expect(mock.seen.config?.input_audio_transcription?.model).toBeTruthy();
    expect(mock.seen.appends).toBeGreaterThanOrEqual(1);
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
});
