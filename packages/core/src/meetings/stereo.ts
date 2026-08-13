/**
 * Meetings — stereo muxing.
 *
 * PyAI's async transcription-jobs API gives **exact, model-free speaker separation
 * per channel** when you send a dual-channel file (`channel: true`). A meeting is
 * already two physically separate streams — mic (me) and system output (them) — so
 * interleaving them as L/R gives perfect Me/Them attribution with no diarization
 * model involved and nothing to get wrong.
 *
 * Channel convention (fixed, relied on by the jobs adapter):
 *   channel 0 / LEFT  = "me"   (microphone)
 *   channel 1 / RIGHT = "them" (system output)
 */

import type { SpeakerStream } from "./types";

/** channel index -> stream. Single source of truth for the L/R convention. */
export const CHANNEL_STREAM: Record<number, SpeakerStream> = { 0: "me", 1: "them" };

export function streamForChannel(ch: number | undefined): SpeakerStream {
  return ch === 1 ? "them" : "me";
}

/**
 * Interleave two mono 16-bit PCM buffers into one stereo buffer.
 *
 * The two capture streams start at the same wall-clock moment but will not be
 * byte-identical in length (different devices, different callback cadence, one may
 * stop a beat earlier). We pad the shorter side with silence rather than truncating
 * the longer one — losing the tail of someone's sentence is worse than a little
 * trailing silence, and the transcriber ignores silence.
 */
export function interleaveStereo(left: Uint8Array, right: Uint8Array): Uint8Array {
  // 16-bit samples: work in whole frames, never split a sample across the boundary.
  const lSamples = Math.floor(left.length / 2);
  const rSamples = Math.floor(right.length / 2);
  const n = Math.max(lSamples, rSamples);
  const out = new Uint8Array(n * 4); // 2 channels x 2 bytes
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (i < lSamples) {
      out[o] = left[i * 2];
      out[o + 1] = left[i * 2 + 1];
    }
    if (i < rSamples) {
      out[o + 2] = right[i * 2];
      out[o + 3] = right[i * 2 + 1];
    }
    // else: leave zeros = silence
  }
  return out;
}

/** Concatenate PCM chunks as they arrive from a capture stream. */
export function concatPcm(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Duration of a mono 16-bit PCM buffer, in ms. */
export function pcmDurationMs(pcm: Uint8Array, sampleRate: number, channels = 1): number {
  const bytesPerFrame = 2 * channels;
  return Math.round((pcm.length / bytesPerFrame / sampleRate) * 1000);
}
