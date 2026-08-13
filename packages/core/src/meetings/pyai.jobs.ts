/**
 * Meetings — PyAI async transcription jobs (speaker-separated final transcript).
 *
 * WHY THIS EXISTS (probed 13 Aug 2026, see docs/research/pyai-api-findings.md):
 * Hear's STREAMING surface has no diarization — `diarize` / `diarization` /
 * `speaker_labels` on the WS are all silently ignored and no event carries a
 * speaker field. Diarization lives on a *different* surface:
 * `POST /v1/transcription/jobs`, which supports
 *   • `channel: true`  — dual-channel: exact, MODEL-FREE separation per channel
 *   • `diarize: true`  — mono diarization via Sortformer (mutually exclusive with channel)
 *
 * Because a meeting is already two physically separate captures, we take the
 * `channel` path: mux mic->L and system->R, and speaker attribution becomes exact
 * rather than a model's guess. This mirrors the M2 architecture the product already
 * uses — live streaming preview, authoritative batch pass on stop.
 */

import type { TranscriptSegment } from "./types";
import { streamForChannel } from "./stereo";
import { pcmToWav } from "../audio/wav";

export interface JobOptions {
  /** 16-bit PCM sample rate of the muxed audio. */
  sampleRate?: number;
  /** Format spoken numbers as digits — fixes findings F6 ("eightpm" -> "8pm"). */
  numerals?: boolean;
  /**
   * Override the job model. The API default is `pyai-hear-telephony`, which is
   * tuned for 8 kHz phone audio; meeting capture is wideband, so this is worth
   * A/B-ing against `pyai-hear`. Omitted by default (server picks).
   */
  model?: string;
  /** Poll interval and ceiling. A 10-minute meeting should finish well inside this. */
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export interface JobResult {
  segments: TranscriptSegment[];
  /** Whole-transcript text as returned by the service. */
  text: string;
  /** Distinct speakers the service reports. */
  speakers: number;
  audioSeconds: number;
  jobId: string;
  latencyMs: number;
}

const TERMINAL_OK = new Set(["completed", "succeeded", "success", "done", "finished"]);
const TERMINAL_BAD = new Set(["failed", "error", "cancelled", "canceled"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PyAiTranscriptionJobs {
  readonly id = "pyai-jobs";
  readonly requiredKeys = ["PYAI_API_KEY"];

  constructor(private apiKey = process.env.PYAI_API_KEY ?? "") {}

  private base(): string {
    return process.env.PYAI_BASE ?? "https://api.pyai.com/v1";
  }

  /**
   * Submit interleaved STEREO PCM (L=me, R=them) and resolve to speaker-tagged
   * segments. Throws on job failure or timeout — the caller falls back to the
   * live streaming transcript, which is never lost.
   */
  async transcribeStereo(stereoPcm: Uint8Array, opts: JobOptions = {}): Promise<JobResult> {
    const t0 = Date.now();
    const doFetch = opts.fetchImpl ?? fetch;
    const sampleRate = opts.sampleRate ?? 16000;
    const wav = pcmToWav(stereoPcm, sampleRate, 2);

    const form = new FormData();
    form.append("audio", new Blob([wav], { type: "audio/wav" }), "meeting.wav");
    // Multipart takes STRING enums for the booleans (see the openapi multipart schema).
    form.append("channel", "true");
    if (opts.numerals !== false) form.append("numerals", "true");
    if (opts.model) form.append("model", opts.model);
    form.append("output_formats", "json");

    const res = await doFetch(`${this.base()}/transcription/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`pyai jobs create ${res.status}: ${body.slice(0, 300)}`);
    }
    const created: any = await res.json();
    const jobId = created?.id ?? created?.job_id;
    if (!jobId) throw new Error("pyai jobs create: no job id in response");

    const job = await this.poll(jobId, opts, doFetch);
    const result = await this.resolveResult(job, doFetch);

    return {
      segments: mapSegments(result),
      text: typeof result?.text === "string" ? result.text : "",
      speakers: Number(result?.speakers ?? 0) || 0,
      audioSeconds: Number(result?.audio_seconds ?? 0) || 0,
      jobId,
      latencyMs: Date.now() - t0,
    };
  }

  private async poll(jobId: string, opts: JobOptions, doFetch: typeof fetch): Promise<any> {
    const every = opts.pollIntervalMs ?? 1200;
    const until = Date.now() + (opts.timeoutMs ?? 180_000);
    let last = "";
    while (Date.now() < until) {
      const r = await doFetch(`${this.base()}/transcription/jobs/${jobId}`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`pyai jobs get ${r.status}: ${body.slice(0, 200)}`);
      }
      const job: any = await r.json();
      last = String(job?.status ?? "").toLowerCase();
      if (TERMINAL_OK.has(last)) return job;
      if (TERMINAL_BAD.has(last)) {
        throw new Error(`pyai job ${jobId} ${last}: ${job?.error?.message ?? job?.error ?? "no detail"}`);
      }
      await sleep(every);
    }
    throw new Error(`pyai job ${jobId} timed out (last status: ${last || "unknown"})`);
  }

  /** Large results are offloaded to `result_url` instead of being inlined. */
  private async resolveResult(job: any, doFetch: typeof fetch): Promise<any> {
    if (job?.result) return job.result;
    const url = job?.result_url;
    if (!url) throw new Error("pyai job completed with neither result nor result_url");
    const r = await doFetch(url);
    if (!r.ok) throw new Error(`pyai result_url ${r.status}`);
    return await r.json();
  }
}

/**
 * Map job segments to our transcript shape.
 *
 * `channel` is authoritative for Me/Them (that's the whole point of the stereo
 * path). `speaker` is kept as the finer-grained id when the service also reports
 * one, so multiple remote humans can be split later without a schema change.
 */
export function mapSegments(result: any): TranscriptSegment[] {
  const raw = Array.isArray(result?.segments) ? result.segments : [];
  const out: TranscriptSegment[] = [];
  for (const s of raw) {
    const text = typeof s?.text === "string" ? s.text.trim() : "";
    if (!text) continue;
    // `start` is in seconds per the schema; tolerate a service that sends ms.
    const start = Number(s?.start ?? 0) || 0;
    const atMs = Math.round(start > 10_000 ? start : start * 1000);
    const ch = typeof s?.channel === "number" ? s.channel : undefined;
    const seg: TranscriptSegment = { atMs, stream: streamForChannel(ch), text };
    if (typeof s?.speaker === "string" && s.speaker) seg.speaker = s.speaker;
    out.push(seg);
  }
  out.sort((a, b) => a.atMs - b.atMs);
  return out;
}
