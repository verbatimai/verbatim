import type { STTProvider, TranscriptEvent } from "./providers/types";
import type { CorrectionProvider, CorrectionResult } from "./correction/types";
import { expandSnippets, type Snippet } from "./snippets";
import type { FormatMode } from "./correction/prompt";

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
  sttConfig?: { apiKey?: string; language?: string; detectLanguage?: boolean; keywords?: string[] };
  frames?: Buffer[];
  frameMs?: number;
}

export interface StreamHandle {
  pushAudio(frame: ArrayBufferView | ArrayBuffer): void;
  finish(): Promise<void>;
}

/**
 * Behaviour toggles for the finalize pass (Settings §2.2 / §2.3). Both default to
 * ON (`!== false` semantics): an omitted / undefined flag keeps today's behaviour.
 * These are pipeline BEHAVIOUR, not provider selection — they deliberately live
 * here (and in the widget config / WS `start` frame), NOT in core `AppSettings`.
 */
export interface PipelineOptions {
  correct?: boolean; // 2.2 — run the self-correction pass on finalize (default true)
  format?: boolean;  // 2.3 — run the formatting pass on finalize (default true)
  vocabulary?: string[]; // 3.4 — custom terms injected into the format prompt (preserve/spell)
  snippets?: Snippet[];  // 3.5 — deterministic trigger→expansion applied to the final text
  formatMode?: FormatMode; // 5.3 — prose | message | code | raw ("raw" skips the format pass)
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
 * Stitch `add` onto `base` collapsing ONLY an exact overlapping run at the seam
 * (plus a repeated-tail guard). Unlike `mergeOverlap`, there is NO fuzzy
 * matching — two distinct utterances that merely share a suffix (e.g. "first
 * thing i said" / "second thing i said") must NOT be collapsed into one. This is
 * what the accumulator uses to fold sliding windows within an utterance and to
 * dedupe a seam between two consecutive finals.
 */
export function stitch(base: string, add: string): string {
  const a = norm(add);
  if (!a) return norm(base);
  const b = norm(base);
  if (!b) return collapseRepeats(a);
  if (b.includes(a)) return b; // `add` already present
  const B = b.split(" ");
  const A = a.split(" ");
  const max = Math.min(B.length, A.length);
  let k = 0;
  for (let n = max; n >= 1; n--) {
    if (matchCount(B, A, n) === n) { k = n; break; }
  }
  const tail = A.slice(k);
  if (!tail.length) return b;
  return collapseRepeats(b + " " + tail.join(" "));
}

/**
 * Accumulates Hear's streaming events into one clean, growing transcript.
 *
 * The design follows how Hear actually streams (confirmed from a captured raw
 * `[hear]` stream):
 *  - Each utterance has its own `utterance_id`. While it's in progress, Hear
 *    emits `transcript.partial` events whose `text` is the FULL best hypothesis
 *    for THAT utterance so far. (`stable_text`/`active_text` are a low-latency
 *    SLIDING WINDOW view of the same text — `stable_text` drops words off the
 *    FRONT as it advances — so they are NOT a reliable running prefix.)
 *  - When an utterance ends (VAD endpoint or the ~30s max-utterance cap), Hear
 *    emits a `transcript.final` carrying the full utterance text, then starts a
 *    NEW `utterance_id` from scratch.
 *
 * So the correct model is utterance-scoped, not whole-session window merging:
 *  committed utterances (from finals) + the current utterance's live text.
 * Each utterance contributes exactly once, so overlapping partial windows can
 * never stack/duplicate across the session — the old failure mode.
 *
 * `mergeOverlap`/`collapseRepeats` are still used, but only in BOUNDED spots: to
 * fold a provider's sliding windows WITHIN one utterance, and to dedupe a tiny
 * seam if two consecutive finals happen to overlap. They never run across the
 * whole session anymore.
 */
export class TranscriptAccumulator {
  private committed = "";       // completed utterances, joined (seam-deduped)
  private curId: string | null = null; // utterance_id currently in progress
  private curText = "";         // full hypothesis for the in-progress utterance
  private curActive = "";       // volatile tail (rendered dim)

  /** Best full text for an event: prefer `text`; else reconstruct from the window. */
  private derive(e: TranscriptEvent): string {
    const t = norm(e.text || "");
    if (t) return t;
    return norm([norm(e.stableText || ""), norm(e.activeText || "")].filter(Boolean).join(" "));
  }

  private commit(text: string): void {
    const t = norm(text);
    if (!t) return;
    this.committed = this.committed ? stitch(this.committed, t) : collapseRepeats(t);
  }

  push(e: TranscriptEvent): { transcript: string; active: string } {
    // A new utterance_id appeared while the previous one was never finalized
    // (rollover): commit what we had for it before switching.
    if (e.utteranceId && this.curId !== null && e.utteranceId !== this.curId) {
      this.commit(this.curText);
      this.curText = "";
      this.curActive = "";
    }
    if (e.utteranceId) this.curId = e.utteranceId;

    const hasText = norm(e.text || "") !== "";
    const derived = this.derive(e);
    // With a real `text` field, it's the FULL current-utterance hypothesis and may
    // REVISE earlier words (e.g. a mis-heard "okay" gets dropped) — so replace.
    // Window-only providers (no `text`) stream a sliding window we must stitch.
    const foldInto = (prev: string) => (hasText ? derived : stitch(prev, derived));

    if (e.type === "final" || e.endpoint) {
      // Completed utterance -> commit it exactly once.
      this.commit(foldInto(this.curText) || this.curText);
      this.curId = null;
      this.curText = "";
      this.curActive = "";
    } else if (derived) {
      // In-progress utterance: keep the fullest hypothesis for it.
      this.curText = foldInto(this.curText);
      this.curActive = norm(e.activeText || "");
    } else {
      this.curActive = norm(e.activeText || "");
    }
    return this.view();
  }

  private view(): { transcript: string; active: string } {
    // Split the current utterance into a solid part + the dim volatile tail.
    const solidCurrent =
      this.curActive && this.curText.endsWith(this.curActive)
        ? norm(this.curText.slice(0, this.curText.length - this.curActive.length))
        : this.curText;
    const transcript = norm([this.committed, solidCurrent].filter(Boolean).join(" "));
    return { transcript, active: this.curActive };
  }

  /** The finished transcript (fallback for demo/no-batch; batch is authoritative live). */
  final(): string {
    return norm(this.curText ? stitch(this.committed, this.curText) : this.committed);
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
    private opts: PipelineOptions = {},
  ) {}

  async startStreaming(sttConfig?: RunOptions["sttConfig"]): Promise<StreamHandle> {
    const session = await this.stt.startSession({
      apiKey: sttConfig?.apiKey ?? "",
      language: sttConfig?.language,
      detectLanguage: sttConfig?.detectLanguage, // 3.2 — forwarded to the vendor adapter
      keywords: sttConfig?.keywords,             // 3.4 — Deepgram-only keyword boost
    });
    const acc = new TranscriptAccumulator();
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => (resolveClosed = r));
    let doneFired = false;

    session.onTranscript((e) => {
      const { transcript, active } = acc.push(e);
      this.h.onLive?.({ transcript, active });
    });
    session.onError((err) => this.h.onError?.(err));

    // 3.5 — ALL three onFormatted paths (LLM-formatted / unformatted-clean / catch→raw)
    // route through here so snippet expansion runs exactly once, on the final text, on
    // every path including the error fallback. Expansion is deterministic + verbatim.
    const snippets = this.opts.snippets;
    const emitFormatted = (text: string) => {
      const expanded = snippets && snippets.length ? expandSnippets(text, snippets) : text;
      this.h.onFormatted?.({ text: expanded });
    };

    const finalizeOnce = async () => {
      if (doneFired) return;
      doneFired = true;
      const raw = acc.final();
      if (raw) {
        try {
          const language = sttConfig?.language;
          const vocabulary = this.opts.vocabulary; // 3.4 — into the format prompt
          const doCorrect = this.opts.correct !== false; // 2.2 — default true
          const mode = this.opts.formatMode;              // 5.3 — formatting mode
          const doFormat = this.opts.format !== false && mode !== "raw"; // 2.3/5.3 — "raw" skips format
          let cleaned = raw;
          if (doCorrect) {
            // vocabulary passed for parity; correction forbids re-spelling (harmless there).
            const result = await this.correction.correct(raw, { language, vocabulary }); // full-transcript cleanup -> diff
            this.h.onCorrection?.({ raw, result });
            cleaned = result.cleanText || raw;
          }
          // Skip correction off => cleaned = raw (STT-only, no diff). Format off => emit
          // the unformatted cleaned text (which is raw when correction is also off).
          if (doFormat && this.correction.format) {
            const f = await this.correction.format(cleaned, language, vocabulary, undefined, mode); // 3.4 vocab + 5.3 mode
            emitFormatted(f.text);
          } else {
            emitFormatted(cleaned);
          }
        } catch (e) {
          this.h.onError?.(e as Error);
          emitFormatted(raw);
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
