import type { IntentProvider, IntentResult, CommandContext, CommandIntent } from "./types";
import { SYSTEM_PROMPT, userMessage, parseIntent } from "./prompt";

const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// PyAI intent adapter. PyAI's text LLM is Anthropic-Messages-style at
// POST /v1/messages (model gpt-5.6-sol), JSON-in-text mode (forced tool-use 503s,
// finding F1). Small retry-with-backoff (PYAI_RETRIES). PYAI_BASE overrides the
// base for integration tests / self-host. Mirrors correction/pyai.ts.
export class PyAiIntent implements IntentProvider {
  readonly id = "pyai";
  readonly requiredKeys = ["PYAI_API_KEY"];

  constructor(private apiKey = process.env.PYAI_API_KEY ?? "") {}

  private async messages(body: unknown): Promise<any> {
    const base = process.env.PYAI_BASE ?? "https://api.pyai.com/v1"; // read at call time (testable)
    const attempts = Math.max(1, Number(process.env.PYAI_RETRIES ?? 3));
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(`${base}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) return await res.json();
        const detail = `PyAI command ${res.status}: ${await res.text()}`;
        if (!TRANSIENT.has(res.status) || i === attempts - 1) throw new Error(detail);
        lastErr = new Error(detail);
      } catch (e) {
        lastErr = e;
        if (i === attempts - 1) throw e;
      }
      await sleep(300 * (i + 1) * (i + 1)); // 300ms, 1200ms, ...
    }
    throw lastErr;
  }

  async interpret(transcript: string, ctx?: CommandContext): Promise<IntentResult> {
    // F4: the PyAI server currently ignores `model` (always gpt-5.6-sol); sent for uniformity.
    const model = ctx?.model?.trim() ? ctx.model : (process.env.PYAI_MODEL ?? "gpt-5.6-sol");
    const t0 = Date.now();
    const body = await this.messages({
      model,
      max_tokens: 200, // one small JSON object — keep it tight for latency
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage(transcript) }],
    });
    const text = (body.content ?? []).find((b: any) => b.type === "text")?.text ?? "";
    const parsed = parseIntent(text);
    const intent: CommandIntent = parsed ?? { action: "noop", reason: "unparseable model output" };
    return { intent, valid: parsed != null, latencyMs: Date.now() - t0 };
  }
}
