import type { IntentProvider, IntentResult, CommandContext, CommandIntent } from "./types";
import { SYSTEM_PROMPT, userMessage } from "./prompt";
import { validateIntent } from "./grammar";

// Anthropic intent adapter. Forced tool-use: one tool whose input_schema is a
// permissive flat schema (action + the optional fields), `tool_choice` forces the
// call, so the tool_use block's `input` is already a parsed object — no JSON-in-text
// parsing. We still run it through validateIntent (the schema is intentionally loose
// on cross-field requirements; the validator enforces per-action correctness).
// Mirrors correction/anthropic.ts. ANTHROPIC_BASE / ANTHROPIC_MODEL override.
const TOOL_NAME = "emit_command";

const COMMAND_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["format", "delete", "case", "select", "insert", "noop"] },
    style: { type: "string", enum: ["bold", "italic", "underline"] },
    mode: { type: "string", enum: ["upper", "lower", "title"] },
    target: { type: "string", enum: ["selection", "last-word", "last-sentence", "all"] },
    what: { type: "string", enum: ["newline", "literal"] },
    text: { type: "string" },
    reason: { type: "string" },
  },
  required: ["action"],
} as const;

const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AnthropicIntent implements IntentProvider {
  readonly id = "anthropic";
  readonly requiredKeys = ["ANTHROPIC_API_KEY"];

  constructor(private apiKey = process.env.ANTHROPIC_API_KEY ?? "") {}

  private async messages(body: unknown): Promise<any> {
    const base = process.env.ANTHROPIC_BASE ?? "https://api.anthropic.com/v1"; // read at call time (testable)
    const attempts = Math.max(1, Number(process.env.ANTHROPIC_RETRIES ?? 3));
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(`${base}/messages`, {
          method: "POST",
          headers: {
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (res.ok) return await res.json();
        const detail = `Anthropic command ${res.status}: ${await res.text()}`;
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
    const model = ctx?.model?.trim() ? ctx.model : (process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5");
    const t0 = Date.now();
    const body = await this.messages({
      model,
      max_tokens: 200,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage(transcript) }],
      tools: [{ name: TOOL_NAME, description: "Emit the single editing command for the utterance.", input_schema: COMMAND_SCHEMA }],
      tool_choice: { type: "tool", name: TOOL_NAME },
    });
    const use = (body.content ?? []).find((b: any) => b.type === "tool_use" && b.name === TOOL_NAME);
    const parsed = validateIntent(use?.input);
    const intent: CommandIntent = parsed ?? { action: "noop", reason: "invalid tool output" };
    return { intent, valid: parsed != null, latencyMs: Date.now() - t0 };
  }
}
