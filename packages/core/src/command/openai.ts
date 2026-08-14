import type { IntentProvider, IntentResult, CommandContext, CommandIntent } from "./types";
import { SYSTEM_PROMPT, userMessage, parseIntent } from "./prompt";

const TRANSIENT = new Set([408, 409, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// OpenAI intent adapter. Chat Completions with `response_format:{type:"json_object"}`
// (the CommandIntent grammar is a discriminated union — awkward under strict
// json_schema — so we constrain via the system prompt and validate locally with
// parseIntent, keeping the same validate-or-noop discipline as the other vendors).
// OPENAI_BASE / OPENAI_COMMAND_MODEL override endpoint/model. Mirrors correction/openai.ts.
export class OpenAiIntent implements IntentProvider {
  readonly id = "openai";
  readonly requiredKeys = ["OPENAI_API_KEY"];

  constructor(private apiKey = process.env.OPENAI_API_KEY ?? "") {}

  private async chat(body: unknown): Promise<any> {
    const base = process.env.OPENAI_BASE ?? "https://api.openai.com/v1"; // read at call time (testable)
    const attempts = Math.max(1, Number(process.env.OPENAI_RETRIES ?? 3));
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) return await res.json();
        const detail = `OpenAI command ${res.status}: ${await res.text()}`;
        if (!TRANSIENT.has(res.status) || i === attempts - 1) throw new Error(detail);
        lastErr = new Error(detail);
      } catch (e) {
        lastErr = e;
        if (i === attempts - 1) throw e;
      }
      await sleep(300 * (i + 1) * (i + 1));
    }
    throw lastErr;
  }

  async interpret(transcript: string, ctx?: CommandContext): Promise<IntentResult> {
    const model = ctx?.model?.trim() ? ctx.model : (process.env.OPENAI_COMMAND_MODEL ?? "gpt-4o-mini");
    const t0 = Date.now();
    const body = await this.chat({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage(transcript) },
      ],
      response_format: { type: "json_object" },
    });
    const msg = body.choices?.[0]?.message ?? {};
    if (msg.refusal) return { intent: { action: "noop", reason: `refused: ${msg.refusal}` }, valid: false, latencyMs: Date.now() - t0 };
    const parsed = parseIntent(String(msg.content ?? ""));
    const intent: CommandIntent = parsed ?? { action: "noop", reason: "unparseable model output" };
    return { intent, valid: parsed != null, latencyMs: Date.now() - t0 };
  }
}
