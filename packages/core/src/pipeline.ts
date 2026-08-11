import type { STTProvider, TranscriptEvent } from "./providers/types";
import type { CorrectionProvider, CorrectionResult } from "./correction/types";

export interface LiveUpdate {
  /** The clean, accumulated transcript so far (locked text). */
  transcript: string;
  /** The volatile tail currently being revised. */
  active: string;
}
export interface CorrectionUpdate {
  raw: string; // the full transcript that was cleaned
  result: CorrectionResult;
}
export interface PipelineHandlers {
  onLive?(u: LiveUpdate): void;
  onCorrection?(u: CorrectionUpdate): void;
  /** The whole-text formatted final output (grammar/punctuation/structure), on finalize. */
  onFormatted?(u: { text: string }): void;
  onError?(e: Error): void;
  onDone?(): void;
}
export interface RunOptions {
  sttConfig?: { apiKey?: string; language?: string };
  frames?: Buffer[];
  frameMs?: number;
}

export interface StreamHandle {
  pushAudio(frame: ArrayBufferView | ArrayBuffer): void;
  finish(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Remove a duplicated run of words at the END of `text` (Hear's flush on stop
 * often re-appends the last sentence). "a b c d a b c d" -> "a b c d".
 */
export function collapseRepeats(text: string): string {
  const w = norm(text).split(" ");
  for (let len = Math.floor(w.length / 2); len >= 3; len--) {
    const a = w.slice(w.length - 2 * len, w.length - len).join(" ");
    const b = w.slice(w.length - len).join(" ");
    if (a && a === b) return collapseRepeats(w.slice(0, w.length - len).join(" "));
  }
  return norm(text);
}

/** How many of the last `n` words of B match the first `n` words of A. */
function matchCount(B: string[], A: string[], n: number): number {
  let m = 0;
  for (let i = 0; i < n; i++) if (B[B.length - n + i] === A[i]) m++;
  return m;
}

/**
 * Merge `add` onto the end of `base`, collapsing any overlap. Hear streams
 * overlapping / self-revising rolling windows, so we fold each new window into
 * ONE growing transcript instead of stacking duplicates. Word-based, with a
 * FUZZY fallback so minor revisions ("this"->"This", "correct"->"correct itself")
 * still align instead of producing a duplicate, plus a repeated-tail guard.
 */
export function mergeOverlap(base: string, add: string): string {
  const a = norm(add);
  if (!a) return base;
  if (!base) return collapseRepeats(a);
  if (base.includes(a)) return base; // `add` already present -> nothing new
  const B = base.split(" ");
  const A = a.split(" ");
  const max = Math.min(B.length, A.length);

  // 1) exact overlap: largest k where last k of B == first k of A
  let k = 0;
  for (let n = max; n >= 1; n--) {
    if (matchCount(B, A, n) === n) { k = n; break; }
  }
  // 2) fuzzy overlap (only for a meaningful run): tolerate minor word revisions
  if (k === 0) {
    for (let n = max; n >= 3; n--) {
      if (matchCount(B, A, n) / n >= 0.7) { k = n; break; }
    }
  }
  const tail = A.slice(k);
  if (!tail.length) return base;
  return collapseRepeats(norm(base + " " + tail.join(" ")));
}

/**
 * Accumulates Hear's streaming events into one clean transcript. Uses `stableText`
 * (the locked, non-revising prefix) as the source of truth, folds the volatile
 * `activeText` in on finalize, and merges overlapping windows via mergeOverlap.
 */
export class TranscriptAccumulator {
  private transcript = "";
  private active = "";

  push(e: TranscriptEvent): { transcript: string; active: string } {
    if (e.stableText) this.transcript = mergeOverlap(this.transcript, e.stableText);
    else if (e.text && !e.activeText) this.transcript = mergeOverlap(this.transcript, e.text);
    this.active = norm(e.activeText || "");
    if ((e.type === "final" || e.endpoint) && this.active) {
      this.transcript = mergeOverlap(this.transcript, this.active);
      this.active = "";
    }
    return { transcript: this.transcript, active: this.active };
  }

  /** The finished transcript (folds any remaining active tail, collapses repeats). */
  final(): string {
    return collapseRepeats(mergeOverlap(this.transcript, this.active));
  }
}

/**
 * Streaming pipeline. The transcript is streamed CLEAN as one growing line
 * (accumulated locked text + volatile tail). Cleanup + formatting run once on
 * finalize: the cleanup drives the "what was removed" diff over the finished
 * transcript, and the formatter produces the polished output that gets inserted.
 */
export class Pipeline {
  constructor(
    private stt: STTProvider,
    private correction: CorrectionProvider,
    private h: PipelineHandlers = {},
  ) {}

  async startStreaming(sttConfig?: RunOptions["sttConfig"]): Promise<StreamHandle> {
    const session = await this.stt.startSession({ apiKey: sttConfig?.apiKey ?? "", language: sttConfig?.language });
    const acc = new TranscriptAccumulator();
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => (resolveClosed = r));
    let doneFired = false;

    session.onTranscript((e) => {
      const { transcript, active } = acc.push(e);
      this.h.onLive?.({ transcript, active });
    });
    session.onError((err) => this.h.onError?.(err));

    const finalizeOnce = async () => {
      if (doneFired) return;
      doneFired = true;
      const raw = acc.final();
      if (raw) {
        try {
          const result = await this.correction.correct(raw); // full-transcript cleanup -> diff
          this.h.onCorrection?.({ raw, result });
          const cleaned = result.cleanText || raw;
          if (this.correction.format) {
            const f = await this.correction.format(cleaned);
            this.h.onFormatted?.({ text: f.text });
          } else {
            this.h.onFormatted?.({ text: cleaned });
          }
        } catch (e) {
          this.h.onError?.(e as Error);
          this.h.onFormatted?.({ text: raw });
        }
      }
      this.h.onDone?.();
    };

    session.onClose(async () => {
      await finalizeOnce();
      resolveClosed();
    });

    return {
      pushAudio: (f) => session.sendAudio(f),
      finish: async () => {
        await session.finalize();
        await Promise.race([closed, sleep(20000)]);
        await finalizeOnce();
        session.close();
      },
    };
  }

  async run(opts: RunOptions = {}): Promise<void> {
    const handle = await this.startStreaming(opts.sttConfig);
    if (opts.frames && opts.frames.length) {
      const paced = opts.frameMs ?? 20;
      for (const f of opts.frames) {
        handle.pushAudio(f);
        await sleep(paced);
      }
    }
    await handle.finish();
  }
}
