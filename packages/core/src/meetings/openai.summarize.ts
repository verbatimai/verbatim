/**
 * Meetings — OpenAI summarizer.
 *
 * Mirrors `correction/openai.ts`: Chat Completions with Structured Outputs
 * (`response_format: json_schema`, strict) so the note shape is guaranteed, plus
 * the same transient-error retry. OPENAI_BASE / OPENAI_SUMMARY_MODEL override the
 * endpoint and model (tests, self-host, and the Settings model dropdown).
 */

import type {
  ActionItem,
  MeetingNote,
  MeetingSession,
  MeetingSummarizer,
  SummarizeContext,
} from "./types";
import { NOTE_SCHEMA, MEETING_SYSTEM_PROMPT, meetingUserMessage } from "./prompt";
import { locateQuote } from "./transcript";

const TRANSIENT = new Set([408, 409, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];

export class OpenAiSummarizer implements MeetingSummarizer {
  readonly id = "openai";
  readonly requiredKeys = ["OPENAI_API_KEY"];

  constructor(private apiKey = process.env.OPENAI_API_KEY ?? "") {}

  private async chat(body: unknown): Promise<any> {
    const base = process.env.OPENAI_BASE ?? "https://api.openai.com/v1";
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          if (TRANSIENT.has(res.status) && attempt < 2) {
            await sleep(400 * 2 ** attempt);
            continue;
          }
          throw new Error(`openai summarize ${res.status}: ${text.slice(0, 300)}`);
        }
        return await res.json();
      } catch (e) {
        lastErr = e;
        if (attempt >= 2) break;
        await sleep(400 * 2 ** attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async summarize(
    session: Pick<MeetingSession, "segments" | "notes">,
    ctx: SummarizeContext = {},
  ): Promise<MeetingNote> {
    const t0 = Date.now();
    const model =
      (ctx.model && ctx.model.trim()) ||
      process.env.OPENAI_SUMMARY_MODEL ||
      "gpt-4o";

    const body = await this.chat({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: MEETING_SYSTEM_PROMPT },
        { role: "user", content: meetingUserMessage(session.segments, session.notes, ctx) },
      ],
      response_format: { type: "json_schema", json_schema: NOTE_SCHEMA },
    });

    const raw = body?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("openai summarize: response was not valid JSON");
    }

    // Enforce rule 2 locally rather than trusting the model: every action item must
    // anchor to a real span in the transcript. Unverifiable items are dropped, and
    // dropping them is reported so the UI can say so honestly.
    const proposed: any[] = Array.isArray(parsed.action_items) ? parsed.action_items : [];
    const actionItems: ActionItem[] = [];
    let dropped = 0;
    for (const a of proposed) {
      if (!a || typeof a.text !== "string" || !a.text.trim()) continue;
      const quote = typeof a.quote === "string" ? a.quote : "";
      const atMs = locateQuote(session.segments, quote);
      if (atMs < 0) {
        dropped++;
        continue;
      }
      actionItems.push({
        text: a.text.trim(),
        owner: typeof a.owner === "string" ? a.owner.trim() : "",
        quote: quote.trim(),
        atMs,
      });
    }
    if (dropped > 0) {
      console.warn(
        `[meetings] dropped ${dropped} action item(s) with no traceable transcript quote`,
      );
    }

    return {
      title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "Untitled meeting",
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      keyPoints: asStrings(parsed.key_points),
      decisions: asStrings(parsed.decisions),
      actionItems,
      openQuestions: asStrings(parsed.open_questions),
      fromUserNotes: asStrings(parsed.from_user_notes),
      latencyMs: Date.now() - t0,
    };
  }
}
