import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
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

describe("DeepgramSTT.transcribeBatch (against a mock /v1/listen)", () => {
  it("posts the WAV and returns the transcript", async () => {
    let gotAuth = "";
    let gotUrl = "";
    let gotContentType = "";
    const server = await new Promise<{ base: string; server: Server }>((resolve) => {
      const s = createServer((req, res) => {
        gotAuth = String(req.headers["authorization"] ?? "");
        gotContentType = String(req.headers["content-type"] ?? "");
        gotUrl = req.url ?? "";
        req.on("data", () => {});
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              results: { channels: [{ alternatives: [{ transcript: "clean batch" }] }] },
            }),
          );
        });
      });
      s.listen(0, () => resolve({ base: `http://localhost:${(s.address() as AddressInfo).port}/v1`, server: s }));
    });
    cleanup.push(() => server.server.close());
    process.env.DEEPGRAM_BASE = server.base;

    const pcm = new Uint8Array(3200); // 100ms @ 16k
    const text = await new DeepgramSTT().transcribeBatch!(pcm, { apiKey: "test-key" });
    expect(text).toBe("clean batch");
    expect(gotAuth).toBe("Token test-key");
    expect(gotUrl).toContain("/listen");
    expect(gotContentType).toBe("audio/wav");
  });
});
