/**
 * Meetings — shared types.
 *
 * A meeting is two audio streams (mic = "me", system output = "them") transcribed
 * into ONE append-only, timestamped, speaker-tagged segment list. That shape is
 * deliberate: it is what lets the demo use whole-session batch transcription today
 * and swap in chunked/rolling transcription later WITHOUT a data migration.
 * See docs/product/meetings-plan.md §2 (N0-B) and §8.
 */

/** Which audio stream a segment came from. */
export type SpeakerStream = "me" | "them";

export interface TranscriptSegment {
  /** Milliseconds since the session started. */
  atMs: number;
  /** Which capture stream produced this. Free, exact, no diarization needed. */
  stream: SpeakerStream;
  /**
   * Optional finer-grained speaker id from vendor diarization, scoping the
   * `them` stream into individual remote speakers (e.g. "spk_0"). Undefined when
   * the vendor has no diarization — the UI then falls back to the stream label.
   */
  speaker?: string;
  /** Display name if we ever resolve one (calendar attendee, Zoom AX read). */
  speakerName?: string;
  text: string;
}

export interface MeetingSession {
  id: string;
  /** ISO-8601 start time. */
  startedAt: string;
  /** Wall-clock duration in ms; 0 while recording. */
  durationMs: number;
  title: string;
  /** Append-only, ordered by `atMs`. */
  segments: TranscriptSegment[];
  /** The user's own sparse notes typed (or dictated) during the meeting. */
  notes: string;
  /** Template id used for enhancement. */
  templateId: string;
  /** Generated note, once enhancement has run. */
  note?: MeetingNote;
  /** Provider ids actually used, for the footer + debugging. */
  sttProvider?: string;
  summaryProvider?: string;
}

/**
 * An action item MUST carry evidence — a verbatim quote from the transcript and
 * the timestamp it came from. This is the guard against the failure mode that
 * matters most: a model inventing commitments nobody made. An action item that
 * cannot be traced is dropped, not shown. (meetings-plan.md §2 N0-C, §4.)
 */
export interface ActionItem {
  text: string;
  /** Best-effort owner ("me" / "them" / a name), or "" when genuinely unclear. */
  owner: string;
  /** Verbatim span from the transcript that justifies this item. */
  quote: string;
  /** Timestamp of the segment the quote came from; -1 if unmatched. */
  atMs: number;
}

export interface MeetingNote {
  title: string;
  /** 2-4 sentence abstract. */
  summary: string;
  /** Bulleted key points, in the meeting's own order. */
  keyPoints: string[];
  /** Explicit decisions reached. Empty when none were. */
  decisions: string[];
  actionItems: ActionItem[];
  /** Questions raised and left unanswered. */
  openQuestions: string[];
  /** Which parts came from the user's own notes (provenance for the UI). */
  fromUserNotes: string[];
  latencyMs: number;
}

export interface MeetingTemplate {
  id: string;
  label: string;
  /** Extra instruction appended to the system prompt. */
  guidance: string;
}

export interface SummarizeContext {
  template?: MeetingTemplate;
  /** BCP-47 tag; the note is written in the transcript's language. */
  language?: string;
  /** Per-request model override; empty/undefined ⇒ adapter default. */
  model?: string;
  /** Custom vocabulary/proper nouns to spell exactly. */
  vocabulary?: string[];
}

/**
 * Vendor-agnostic summarizer, mirroring `CorrectionProvider`. Keeping this an
 * interface (rather than calling OpenAI inline) is what preserves the core
 * guardrail: no meeting feature may hard-code a vendor.
 */
export interface MeetingSummarizer {
  readonly id: string;
  readonly requiredKeys: string[];
  summarize(
    session: Pick<MeetingSession, "segments" | "notes">,
    ctx?: SummarizeContext,
  ): Promise<MeetingNote>;
}
