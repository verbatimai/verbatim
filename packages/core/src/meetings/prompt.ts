/**
 * Meetings — enhancement prompt + templates.
 *
 * Shared across every summarizer vendor, exactly as `correction/prompt.ts` is
 * shared across correction vendors. Only the wire format differs per adapter.
 */

import type { MeetingTemplate, SummarizeContext, TranscriptSegment } from "./types";
import { renderTranscript } from "./transcript";

export const TEMPLATES: MeetingTemplate[] = [
  {
    id: "general",
    label: "General meeting",
    guidance: "Organise by topic in the order the conversation covered them.",
  },
  {
    id: "one-on-one",
    label: "1:1",
    guidance:
      "This is a 1:1. Prioritise: what the other person raised, blockers they named, " +
      "feedback given in either direction, and anything either person committed to. " +
      "Keep personal/sensitive remarks out of Key points unless they are work-relevant.",
  },
  {
    id: "standup",
    label: "Standup",
    guidance:
      "This is a standup. Group by person where possible: what they finished, what " +
      "they are on next, and blockers. Be terse — bullets, not prose.",
  },
  {
    id: "customer",
    label: "Customer call",
    guidance:
      "This is a customer call. Capture: the customer's stated problem in THEIR words, " +
      "requirements and constraints, objections, pricing/timeline discussion, and every " +
      "follow-up promised to them. Quote the customer verbatim where the wording matters.",
  },
  {
    id: "design-review",
    label: "Design review",
    guidance:
      "This is a design/technical review. Capture: the proposal, alternatives considered, " +
      "trade-offs argued, concerns raised and whether each was resolved, and what was decided " +
      "versus deferred.",
  },
  {
    id: "interview",
    label: "Interview",
    guidance:
      "This is an interview. Capture the candidate's answers by theme, concrete examples they " +
      "gave, and questions they asked. Do NOT infer a hiring recommendation — record only what was said.",
  },
];

export function templateById(id?: string): MeetingTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}

export const MEETING_SYSTEM_PROMPT = `You turn a meeting transcript plus the user's own sparse notes into the notes they would have written if they'd had time.

THE TRANSCRIPT
- Speakers are labelled. "Me" is the user. Everyone else came from the other side of the call.
- It is raw speech-to-text: expect fillers, false starts, and mis-transcribed words. Read through them.
- Timestamps are [mm:ss] from the start of the meeting.

THE USER'S NOTES
- Shorthand typed or dictated DURING the call. They are the strongest possible signal of what the user cared about.
- Treat every one as a heading to expand from the transcript, not as text to copy. If a note is cryptic, find what the conversation says about it.
- If a note has no support in the transcript, keep it anyway, verbatim, and list it in from_user_notes.

HARD RULES
1. Never invent a decision, commitment, number, name, or date that is not in the transcript or the user's notes. Omission is always better than invention.
2. Every action item MUST include a verbatim quote copied EXACTLY from the transcript that justifies it. Copy the words character-for-character; do not paraphrase inside "quote". If you cannot find such a span, do not emit the action item.
3. "decisions" means things actually settled. If the meeting settled nothing, return an empty array. Do not promote a discussion into a decision.
4. Say who owns an action item only if the transcript makes it clear. Otherwise use an empty owner.
5. Write in the language of the transcript. Do not translate.
6. Match the user's register. These are their notes, not a formal report — no filler like "The team discussed various topics".`;

export function meetingUserMessage(
  segments: TranscriptSegment[],
  notes: string,
  ctx: SummarizeContext = {},
): string {
  const tpl = ctx.template ?? TEMPLATES[0];
  const parts: string[] = [];
  parts.push(`MEETING TYPE: ${tpl.label}\n${tpl.guidance}`);
  if (ctx.language && ctx.language !== "en") {
    parts.push(
      `\nLANGUAGE: the transcript is ${ctx.language}. Write the note in ${ctx.language}.`,
    );
  }
  if (ctx.vocabulary?.length) {
    parts.push(
      `\nSPELL THESE EXACTLY (they are often mis-transcribed): ${ctx.vocabulary.join(", ")}`,
    );
  }
  const n = notes.trim();
  parts.push(
    `\n--- USER'S NOTES DURING THE MEETING ---\n${n || "(the user typed nothing — build the note from the transcript alone)"}`,
  );
  parts.push(`\n--- TRANSCRIPT ---\n${renderTranscript(segments)}`);
  return parts.join("\n");
}

/** Structured-output schema. Strict + closed so the shape is guaranteed. */
export const NOTE_SCHEMA = {
  name: "meeting_note",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "summary",
      "key_points",
      "decisions",
      "action_items",
      "open_questions",
      "from_user_notes",
    ],
    properties: {
      title: { type: "string", description: "Short, specific. Not 'Meeting notes'." },
      summary: { type: "string", description: "2-4 sentences." },
      key_points: { type: "array", items: { type: "string" } },
      decisions: { type: "array", items: { type: "string" } },
      action_items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "owner", "quote"],
          properties: {
            text: { type: "string" },
            owner: { type: "string", description: "Empty string if unclear." },
            quote: {
              type: "string",
              description: "Verbatim span copied exactly from the transcript.",
            },
          },
        },
      },
      open_questions: { type: "array", items: { type: "string" } },
      from_user_notes: {
        type: "array",
        items: { type: "string" },
        description: "User notes with no transcript support, kept verbatim.",
      },
    },
  },
} as const;
