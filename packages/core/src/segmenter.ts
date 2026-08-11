import type { TranscriptEvent } from "./providers/types";

/**
 * Turns a stream of TranscriptEvents into segment boundaries. A segment is one
 * utterance; it finalizes when the provider marks a `final` or `endpoint`, or
 * when a new utteranceId appears (the previous one is then implicitly done).
 */
export interface Segment {
  utteranceId: string;
  text: string;
}

export class Segmenter {
  private lastTextByUtterance = new Map<string, string>();
  private finalized = new Set<string>();
  private currentUtterance: string | null = null;

  /** Feed one event; returns a finalized Segment if this event closes one. */
  push(e: TranscriptEvent): Segment | null {
    let boundary: Segment | null = null;

    // A new utterance implicitly finalizes the previous one.
    if (this.currentUtterance && e.utteranceId !== this.currentUtterance && !this.finalized.has(this.currentUtterance)) {
      boundary = this.finalize(this.currentUtterance);
    }
    this.currentUtterance = e.utteranceId;

    const best = e.text || [e.stableText, e.activeText].filter(Boolean).join(" ");
    if (best) this.lastTextByUtterance.set(e.utteranceId, best.trim());

    if ((e.type === "final" || e.endpoint) && !this.finalized.has(e.utteranceId)) {
      // If we already produced a boundary for a *previous* utterance in this
      // same call, prefer finalizing this one (callers loop, but keep it simple).
      const seg = this.finalize(e.utteranceId);
      return seg ?? boundary;
    }
    return boundary;
  }

  /** Force-finalize whatever is open (e.g. stream closed). */
  flush(): Segment | null {
    if (this.currentUtterance && !this.finalized.has(this.currentUtterance)) {
      return this.finalize(this.currentUtterance);
    }
    return null;
  }

  private finalize(utteranceId: string): Segment | null {
    const text = this.lastTextByUtterance.get(utteranceId)?.trim();
    this.finalized.add(utteranceId);
    if (!text) return null;
    return { utteranceId, text };
  }
}
