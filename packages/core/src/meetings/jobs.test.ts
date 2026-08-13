import { describe, it, expect } from "vitest";
import { interleaveStereo, concatPcm, pcmDurationMs, streamForChannel } from "./stereo";
import { PyAiTranscriptionJobs, mapSegments } from "./pyai.jobs";

/** Build a mono 16-bit PCM buffer from sample values. */
const pcm = (...samples: number[]) => {
  const b = new Uint8Array(samples.length * 2);
  const dv = new DataView(b.buffer);
  samples.forEach((s, i) => dv.setInt16(i * 2, s, true));
  return b;
};
const readSamples = (b: Uint8Array) => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return Array.from({ length: b.length / 2 }, (_, i) => dv.getInt16(i * 2, true));
};

describe("interleaveStereo", () => {
  it("puts me on the left and them on the right", () => {
    const out = interleaveStereo(pcm(1, 2, 3), pcm(-1, -2, -3));
    expect(readSamples(out)).toEqual([1, -1, 2, -2, 3, -3]);
  });

  it("pads the shorter stream with silence rather than truncating the longer", () => {
    // Losing the tail of someone's sentence is worse than trailing silence.
    const out = interleaveStereo(pcm(1, 2, 3, 4), pcm(-1));
    expect(readSamples(out)).toEqual([1, -1, 2, 0, 3, 0, 4, 0]);
    expect(out.length).toBe(4 * 4);
  });

  it("handles one side being empty", () => {
    expect(readSamples(interleaveStereo(pcm(5, 6), new Uint8Array(0)))).toEqual([5, 0, 6, 0]);
    expect(readSamples(interleaveStereo(new Uint8Array(0), pcm(7)))).toEqual([0, 7]);
    expect(interleaveStereo(new Uint8Array(0), new Uint8Array(0)).length).toBe(0);
  });

  it("never splits a 16-bit sample on an odd-length input", () => {
    const odd = new Uint8Array([1, 2, 3]); // 1.5 samples
    const out = interleaveStereo(odd, new Uint8Array(0));
    expect(out.length).toBe(4); // one whole frame, not two
  });
});

describe("pcm helpers", () => {
  it("concatenates chunks in order", () => {
    expect(readSamples(concatPcm([pcm(1, 2), pcm(3), pcm(4, 5)]))).toEqual([1, 2, 3, 4, 5]);
    expect(concatPcm([]).length).toBe(0);
  });

  it("computes duration for mono and stereo", () => {
    expect(pcmDurationMs(new Uint8Array(16000 * 2), 16000, 1)).toBe(1000);
    expect(pcmDurationMs(new Uint8Array(16000 * 4), 16000, 2)).toBe(1000);
  });

  it("maps channel index to stream with left=me", () => {
    expect(streamForChannel(0)).toBe("me");
    expect(streamForChannel(1)).toBe("them");
    expect(streamForChannel(undefined)).toBe("me");
  });
});

describe("mapSegments", () => {
  it("uses channel as authoritative Me/Them and keeps any finer speaker id", () => {
    const segs = mapSegments({
      segments: [
        { id: 0, start: 1.5, end: 2.0, text: "hello there", channel: 1, speaker: "spk_2" },
        { id: 1, start: 3.0, end: 3.4, text: "hi", channel: 0 },
      ],
    });
    expect(segs).toEqual([
      { atMs: 1500, stream: "them", text: "hello there", speaker: "spk_2" },
      { atMs: 3000, stream: "me", text: "hi" },
    ]);
  });

  it("sorts by time and drops empty segments", () => {
    const segs = mapSegments({
      segments: [
        { start: 5, text: "later", channel: 0 },
        { start: 1, text: "  ", channel: 1 },
        { start: 2, text: "earlier", channel: 1 },
      ],
    });
    expect(segs.map((s) => s.text)).toEqual(["earlier", "later"]);
  });

  it("tolerates a service that sends milliseconds instead of seconds", () => {
    expect(mapSegments({ segments: [{ start: 90_000, text: "x", channel: 0 }] })[0].atMs).toBe(90_000);
  });

  it("returns empty for a malformed result", () => {
    expect(mapSegments({})).toEqual([]);
    expect(mapSegments(null)).toEqual([]);
  });
});

// ── Job lifecycle against a mock server ─────────────────────────────────────
function mockJobs(script: Array<{ status: string; result?: unknown; result_url?: string; error?: unknown }>) {
  let i = 0;
  const calls: string[] = [];
  const f = (async (url: any, init?: any) => {
    const u = String(url);
    calls.push(`${init?.method ?? "GET"} ${u.replace("https://api.pyai.com/v1", "")}`);
    if (u.endsWith("/transcription/jobs") && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "job_1", status: "queued" }), { status: 202 });
    }
    if (u.includes("/transcription/jobs/job_1")) {
      const step = script[Math.min(i++, script.length - 1)];
      return new Response(JSON.stringify(step), { status: 200 });
    }
    if (u.startsWith("https://cdn.example/")) {
      return new Response(JSON.stringify({ text: "offloaded", speakers: 2, segments: [{ start: 0, text: "big", channel: 1 }] }), { status: 200 });
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const stereo = interleaveStereo(pcm(1, 2, 3), pcm(4, 5, 6));

describe("PyAiTranscriptionJobs", () => {
  it("submits, polls past queued/running, and maps the result", async () => {
    const { f, calls } = mockJobs([
      { status: "queued" },
      { status: "running" },
      { status: "completed", result: { text: "hi there", speakers: 2, audio_seconds: 7.9, segments: [{ start: 0.5, text: "hi", channel: 0 }, { start: 1.2, text: "there", channel: 1 }] } },
    ]);
    const out = await new PyAiTranscriptionJobs("k").transcribeStereo(stereo, { fetchImpl: f, pollIntervalMs: 1 });
    expect(out.jobId).toBe("job_1");
    expect(out.speakers).toBe(2);
    expect(out.audioSeconds).toBeCloseTo(7.9);
    expect(out.segments.map((s) => s.stream)).toEqual(["me", "them"]);
    expect(calls[0]).toBe("POST /transcription/jobs");
    expect(calls.filter((c) => c.includes("job_1"))).toHaveLength(3);
  });

  it("follows result_url when the result is offloaded", async () => {
    const { f } = mockJobs([{ status: "completed", result_url: "https://cdn.example/r.json" }]);
    const out = await new PyAiTranscriptionJobs("k").transcribeStereo(stereo, { fetchImpl: f, pollIntervalMs: 1 });
    expect(out.text).toBe("offloaded");
    expect(out.segments[0].stream).toBe("them");
  });

  it("throws with the service's reason when the job fails", async () => {
    const { f } = mockJobs([{ status: "failed", error: { message: "bad audio" } }]);
    await expect(
      new PyAiTranscriptionJobs("k").transcribeStereo(stereo, { fetchImpl: f, pollIntervalMs: 1 }),
    ).rejects.toThrow(/failed: bad audio/);
  });

  it("times out rather than polling forever", async () => {
    const { f } = mockJobs([{ status: "running" }]);
    await expect(
      new PyAiTranscriptionJobs("k").transcribeStereo(stereo, { fetchImpl: f, pollIntervalMs: 1, timeoutMs: 25 }),
    ).rejects.toThrow(/timed out/);
  });

  it("surfaces a create failure", async () => {
    const f = (async () => new Response("no credit", { status: 402 })) as unknown as typeof fetch;
    await expect(
      new PyAiTranscriptionJobs("k").transcribeStereo(stereo, { fetchImpl: f }),
    ).rejects.toThrow(/402/);
  });
});
