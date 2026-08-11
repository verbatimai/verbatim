import { readFileSync } from "node:fs";

export interface WavData {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  pcm: Buffer; // raw sample bytes (data chunk)
}

/** Minimal PCM WAV reader (16-bit little-endian). Enough for our fixtures. */
export function readWav(path: string): WavData {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }
  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number } | null = null;
  let pcm: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      pcm = buf.subarray(body, body + size);
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !pcm) throw new Error(`${path}: missing fmt or data chunk`);
  if (fmt.bitsPerSample !== 16) throw new Error(`${path}: expected 16-bit PCM, got ${fmt.bitsPerSample}`);
  return { ...fmt, pcm };
}

/** Wrap raw 16-bit PCM in a WAV container (cross-platform, no Buffer). */
export function pcmToWav(pcm: Uint8Array, sampleRate = 16000, channels = 1): Uint8Array {
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const buf = new ArrayBuffer(44 + pcm.length);
  const dv = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF");
  dv.setUint32(4, 36 + pcm.length, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitsPerSample, true);
  w(36, "data");
  dv.setUint32(40, pcm.length, true);
  const out = new Uint8Array(buf);
  out.set(pcm, 44);
  return out;
}

/** Split PCM into fixed-duration frames (bytes). */
export function frameize(wav: WavData, frameMs = 20): Buffer[] {
  const bytesPerFrame = Math.floor((wav.sampleRate * frameMs) / 1000) * 2 * wav.channels;
  const frames: Buffer[] = [];
  for (let i = 0; i < wav.pcm.length; i += bytesPerFrame) {
    frames.push(wav.pcm.subarray(i, i + bytesPerFrame));
  }
  return frames;
}
