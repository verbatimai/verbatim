import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWav, frameize, pcmToWav } from "./wav";

/** Build a minimal 16-bit PCM WAV in memory. */
function makeWav(sampleRate: number, channels: number, samples: number): Buffer {
  const dataLen = samples * channels * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

describe("readWav + frameize", () => {
  it("parses header and data", () => {
    const dir = mkdtempSync(join(tmpdir(), "wav-"));
    const path = join(dir, "t.wav");
    writeFileSync(path, makeWav(16000, 1, 16000)); // 1 second mono
    const wav = readWav(path);
    expect(wav.sampleRate).toBe(16000);
    expect(wav.channels).toBe(1);
    expect(wav.bitsPerSample).toBe(16);
    expect(wav.pcm.length).toBe(16000 * 2);
  });

  it("frameizes into ~20ms frames", () => {
    const dir = mkdtempSync(join(tmpdir(), "wav-"));
    const path = join(dir, "t.wav");
    writeFileSync(path, makeWav(16000, 1, 16000));
    const wav = readWav(path);
    const frames = frameize(wav, 20); // 20ms @16k mono = 320 samples = 640 bytes
    expect(frames[0].length).toBe(640);
    expect(frames.length).toBe(50); // 1000ms / 20ms
  });

  it("pcmToWav produces a WAV that readWav can parse back", () => {
    const pcm = new Uint8Array(16000 * 2); // 1s of silence, 16-bit @16k
    for (let i = 0; i < 100; i++) pcm[i] = i; // a little data
    const wav = pcmToWav(pcm, 16000, 1);
    const dir = mkdtempSync(join(tmpdir(), "wav-"));
    const path = join(dir, "gen.wav");
    writeFileSync(path, wav);
    const parsed = readWav(path);
    expect(parsed.sampleRate).toBe(16000);
    expect(parsed.channels).toBe(1);
    expect(parsed.bitsPerSample).toBe(16);
    expect(parsed.pcm.length).toBe(pcm.length);
  });

  it("rejects non-WAV", () => {
    const dir = mkdtempSync(join(tmpdir(), "wav-"));
    const path = join(dir, "bad.wav");
    writeFileSync(path, Buffer.from("not a wav file"));
    expect(() => readWav(path)).toThrow();
  });
});
