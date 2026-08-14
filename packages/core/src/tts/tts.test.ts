import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { getTtsProvider, assertTtsKeys } from "./registry";
import { DeepgramTts } from "./deepgram";
import { PyAiTts } from "./pyai";

interface Captured {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

/** A tiny mock HTTP server that captures the request and replies with raw audio bytes. */
async function mockAudioServer(
  audio: Buffer,
  contentType = "audio/mpeg",
): Promise<{ base: string; server: Server; requests: Captured[] }> {
  const requests: Captured[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body: any = {};
        try { body = JSON.parse(raw); } catch { /* leave {} */ }
        requests.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.setHeader("content-type", contentType);
        res.end(audio);
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
  delete process.env.DEEPGRAM_BASE;
  delete process.env.DEEPGRAM_TTS_MODEL;
  delete process.env.PYAI_BASE;
  delete process.env.PYAI_TTS_MODEL;
  delete process.env.PYAI_TTS_VOICE;
});

describe("getTtsProvider (registry)", () => {
  it("defaults to pyai", () => {
    expect(getTtsProvider().id).toBe("pyai");
  });

  it("resolves deepgram", () => {
    expect(getTtsProvider("deepgram").id).toBe("deepgram");
  });

  it("throws a clear message for an unknown vendor", () => {
    expect(() => getTtsProvider("nope")).toThrow(/Unknown TTS provider 'nope'/);
  });
});

describe("assertTtsKeys", () => {
  it("throws when the required key is missing", () => {
    const tts = new DeepgramTts("");
    expect(() => assertTtsKeys(tts, {})).toThrow(/DEEPGRAM_API_KEY/);
  });

  it("passes when the required key is present", () => {
    const tts = new DeepgramTts("k");
    expect(() => assertTtsKeys(tts, { DEEPGRAM_API_KEY: "k" })).not.toThrow();
  });
});

describe("DeepgramTts.synthesize (against a mock /v1/speak)", () => {
  it("sends Token auth + text, and returns the raw audio bytes back", async () => {
    const fakeAudio = Buffer.from("fake-mp3-bytes");
    const { base, server, requests } = await mockAudioServer(fakeAudio);
    cleanup.push(() => server.close());
    process.env.DEEPGRAM_BASE = base;

    const result = await new DeepgramTts("test-key").synthesize("Hello Mayank, how can I help you?");

    expect(Buffer.from(result.audio).equals(fakeAudio)).toBe(true);
    expect(result.mime).toBe("audio/mpeg");
    expect(requests[0].headers["authorization"]).toBe("Token test-key");
    expect(requests[0].url).toContain("/speak?model=aura-2-thalia-en"); // default voice
    expect(requests[0].body.text).toBe("Hello Mayank, how can I help you?");
  });

  it("honours a voice/model override and DEEPGRAM_TTS_MODEL", async () => {
    const { base, server, requests } = await mockAudioServer(Buffer.from("x"));
    cleanup.push(() => server.close());
    process.env.DEEPGRAM_BASE = base;

    await new DeepgramTts("k").synthesize("hi", { voice: "aura-2-luna-en" });
    expect(requests[0].url).toContain("model=aura-2-luna-en");

    process.env.DEEPGRAM_TTS_MODEL = "aura-2-orion-en";
    await new DeepgramTts("k").synthesize("hi");
    expect(requests[1].url).toContain("model=aura-2-orion-en");
  });
});

// PyAI's TTS endpoint is UNVERIFIED (see pyai.ts's [verify] note) — this test locks down
// OUR client's request/response handling against the assumed OpenAI-mirroring shape, not
// a confirmed vendor contract. Re-verify against the live API before shipping.
describe("PyAiTts.synthesize (against a mock /v1/audio/speech, [verify] shape)", () => {
  it("sends Bearer auth + model/input/voice, and returns the raw audio bytes back", async () => {
    const fakeAudio = Buffer.from("fake-mp3-bytes-2");
    const { base, server, requests } = await mockAudioServer(fakeAudio);
    cleanup.push(() => server.close());
    process.env.PYAI_BASE = base;

    const result = await new PyAiTts("test-key").synthesize("Hello Mayank, how can I help you?");

    expect(Buffer.from(result.audio).equals(fakeAudio)).toBe(true);
    expect(result.mime).toBe("audio/mpeg");
    expect(requests[0].headers["authorization"]).toBe("Bearer test-key");
    expect(requests[0].url).toBe("/audio/speech");
    expect(requests[0].body).toEqual({
      model: "pyai-speak",
      input: "Hello Mayank, how can I help you?",
      voice: "alloy",
      response_format: "mp3",
    });
  });

  it("honours model/voice overrides and their env fallbacks", async () => {
    const { base, server, requests } = await mockAudioServer(Buffer.from("x"));
    cleanup.push(() => server.close());
    process.env.PYAI_BASE = base;

    await new PyAiTts("k").synthesize("hi", { model: "pyai-speak-2", voice: "nova" });
    expect(requests[0].body.model).toBe("pyai-speak-2");
    expect(requests[0].body.voice).toBe("nova");

    process.env.PYAI_TTS_MODEL = "pyai-speak-env";
    process.env.PYAI_TTS_VOICE = "shimmer";
    await new PyAiTts("k").synthesize("hi");
    expect(requests[1].body.model).toBe("pyai-speak-env");
    expect(requests[1].body.voice).toBe("shimmer");
  });
});
