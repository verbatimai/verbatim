/**
 * Meetings — the durable transcript.
 *
 * Two independent STT streams (mic + system audio) land here and are merged into
 * one ordered, speaker-tagged timeline. Deliberately NOT built on
 * `TranscriptAccumulator`, which is tuned for a single ~30s dictation utterance
 * (it collapses repeats and stitches overlapping revisions of ONE speaker). A
 * meeting needs the opposite: keep every speaker's turns distinct and ordered.
 */

import type { MeetingSession, SpeakerStream, TranscriptSegment } from "./types";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** mm:ss for display; hh:mm:ss past an hour. */
export function stamp(atMs: number): string {
  const t = Math.max(0, Math.floor(atMs / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export class MeetingTranscript {
  private segments: TranscriptSegment[] = [];
  /** Last text committed per stream, so a re-sent partial doesn't duplicate. */
  private lastByStream: Record<SpeakerStream, string> = { me: "", them: "" };

  constructor(private startedAtMs: number = Date.now()) {}

  /**
   * Append a finalized utterance. Returns the segment, or null if it was empty or
   * an exact repeat of that stream's previous commit (Hear re-sends revisions of
   * the same window — see the stitch-artifact caveat in STATUS.md).
   */
  push(
    stream: SpeakerStream,
    text: string,
    opts: { atMs?: number; speaker?: string; speakerName?: string } = {},
  ): TranscriptSegment | null {
    const t = norm(text);
    if (!t) return null;
    if (t === this.lastByStream[stream]) return null;
    // A pure extension of the previous commit replaces it rather than duplicating.
    const prev = this.lastByStream[stream];
    if (prev && t.startsWith(prev)) {
      for (let i = this.segments.length - 1; i >= 0; i--) {
        if (this.segments[i].stream === stream) {
          this.segments[i].text = t;
          this.lastByStream[stream] = t;
          return this.segments[i];
        }
      }
    }
    const seg: TranscriptSegment = {
      atMs: opts.atMs ?? Date.now() - this.startedAtMs,
      stream,
      text: t,
      ...(opts.speaker ? { speaker: opts.speaker } : {}),
      ...(opts.speakerName ? { speakerName: opts.speakerName } : {}),
    };
    this.segments.push(seg);
    this.segments.sort((a, b) => a.atMs - b.atMs);
    this.lastByStream[stream] = t;
    return seg;
  }

  all(): TranscriptSegment[] {
    return this.segments.slice();
  }

  durationMs(): number {
    return this.segments.length ? this.segments[this.segments.length - 1].atMs : 0;
  }

  clear(): void {
    this.segments = [];
    this.lastByStream = { me: "", them: "" };
  }
}

/** Human label for a segment: a resolved name, else a diarized id, else the stream. */
export function speakerLabel(seg: TranscriptSegment): string {
  if (seg.speakerName) return seg.speakerName;
  if (seg.stream === "me") return "Me";
  if (seg.speaker) return `Speaker ${seg.speaker.replace(/^spk_?/i, "")}`;
  return "Them";
}

/**
 * Render the transcript for the model (and for the saved .md file). Consecutive
 * turns from the same speaker are merged so the model sees conversation, not
 * hundreds of one-line fragments — that materially improves summary quality and
 * cuts tokens.
 */
export function renderTranscript(
  segments: TranscriptSegment[],
  opts: { timestamps?: boolean } = {},
): string {
  const withTs = opts.timestamps !== false;
  const lines: string[] = [];
  let curLabel = "";
  let curAt = 0;
  let buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    const head = withTs ? `[${stamp(curAt)}] ${curLabel}:` : `${curLabel}:`;
    lines.push(`${head} ${buf.join(" ")}`);
    buf = [];
  };
  for (const seg of segments) {
    const label = speakerLabel(seg);
    if (label !== curLabel) {
      flush();
      curLabel = label;
      curAt = seg.atMs;
    }
    buf.push(seg.text);
  }
  flush();
  return lines.join("\n");
}

/**
 * Find the segment whose text best contains a quote, so an action item can be
 * anchored to a real timestamp. Returns -1 when the quote isn't in the
 * transcript at all — the caller drops that item as unverifiable.
 */
export function locateQuote(segments: TranscriptSegment[], quote: string): number {
  const q = norm(quote).toLowerCase();
  if (!q) return -1;
  for (const seg of segments) {
    if (seg.text.toLowerCase().includes(q)) return seg.atMs;
  }
  // Fall back to a loose token-overlap match (the model may paraphrase slightly).
  const qt = new Set(q.split(" ").filter((w) => w.length > 3));
  if (qt.size < 3) return -1;
  let best = -1;
  let bestScore = 0;
  for (const seg of segments) {
    const st = new Set(seg.text.toLowerCase().split(" "));
    let hit = 0;
    for (const w of qt) if (st.has(w)) hit++;
    const score = hit / qt.size;
    if (score > bestScore) {
      bestScore = score;
      best = seg.atMs;
    }
  }
  return bestScore >= 0.6 ? best : -1;
}

/** The saved artefact: a self-contained Markdown file, local-first by design. */
export function renderMarkdown(session: MeetingSession): string {
  const n = session.note;
  const out: string[] = [];
  out.push(`# ${n?.title || session.title}`);
  out.push("");
  out.push(
    `*${new Date(session.startedAt).toLocaleString()} · ${stamp(session.durationMs)} · ` +
      `${session.segments.length} segments*`,
  );
  out.push("");
  if (n) {
    if (n.summary) out.push(n.summary, "");
    if (n.keyPoints.length) {
      out.push("## Key points", "");
      for (const k of n.keyPoints) out.push(`- ${k}`);
      out.push("");
    }
    if (n.decisions.length) {
      out.push("## Decisions", "");
      for (const d of n.decisions) out.push(`- ${d}`);
      out.push("");
    }
    if (n.actionItems.length) {
      out.push("## Action items", "");
      for (const a of n.actionItems) {
        const who = a.owner ? `**${a.owner}** — ` : "";
        const at = a.atMs >= 0 ? ` *(${stamp(a.atMs)})*` : "";
        out.push(`- [ ] ${who}${a.text}${at}`);
      }
      out.push("");
    }
    if (n.openQuestions.length) {
      out.push("## Open questions", "");
      for (const q of n.openQuestions) out.push(`- ${q}`);
      out.push("");
    }
  }
  if (session.notes.trim()) {
    out.push("## My notes", "", session.notes.trim(), "");
  }
  out.push("## Transcript", "", "```", renderTranscript(session.segments), "```", "");
  const via = [session.sttProvider && `STT: ${session.sttProvider}`, session.summaryProvider && `Notes: ${session.summaryProvider}`]
    .filter(Boolean)
    .join(" · ");
  if (via) out.push(`---`, "", `*${via} · stored locally on this device*`);
  return out.join("\n");
}
