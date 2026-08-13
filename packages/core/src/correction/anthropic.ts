import type { CorrectionProvider, CorrectionResult, CorrectionContext, CorrectionEdit } from "./types";
import { SYSTEM_PROMPT, userMessage, reconstruct, validate, FORMAT_PROMPT, formatMessage } from "./prompt";

// Anthropic Messages API correction adapter. Structured output = forced
// tool-use (docs/architecture/vendor-apis.md §4): one tool whose input_schema
// is the compact-edits schema, `tool_choice:{type:"tool", name:...}` forces the
// model to call it — the `tool_use` block's `input` is already a parsed object
// (no JSON-in-text parsing needed, unlike PyAI's F1 workaround).
const TOOL_NAME = "emit_correction";

const EDIT_SCHEMA = {
  type: "object",
  properties: {
    clean_text: { type: "string" },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          raw: { type: "string" },
          replacement: { type: "string" },
          reason: { type: "string", enum: ["filler", "false_start", "self_correction", "repetition", "grammar"] },
        },
        required: ["raw", "replacement", "reason"],
      },
    },
  },
  required: ["clean_text", "edits"],
} as const;

export class AnthropicCorrection implements CorrectionProvider {
  readonly id = "anthropic";
  readonly requiredKeys = ["ANTHROPIC_API_KEY"];

  constructor(private apiKey = process.env.ANTHROPIC_API_KEY ?? "") {}

  private async messages(body: unknown): Promise<any> {
    const base = process.env.ANTHROPIC_BASE ?? "https://api.anthropic.com/v1"; // read at call time (testable)
    const res = await fetch(`${base}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Anthropic messages ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async correct(raw: string, ctx?: CorrectionContext): Promise<CorrectionResult> {
    const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
    const t0 = Date.now();
    const body = await this.messages({
      model,
      max_tokens: 1024,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage(raw, ctx?.priorContext, ctx?.language) }],
      tools: [{ name: TOOL_NAME, description: "Emit the compact disfluency edits for the transcript.", input_schema: EDIT_SCHEMA }],
      tool_choice: { type: "tool", name: TOOL_NAME },
    });
    const latencyMs = Date.now() - t0;
    const use = (body.content ?? []).find((b: any) => b.type === "tool_use" && b.name === TOOL_NAME);
    const input = use?.input ?? {};
    const edits: CorrectionEdit[] = input.edits ?? [];
    const { cleanText, ops } = reconstruct(raw, edits);
    const valid = validate(cleanText, input.clean_text ?? cleanText);
    return { cleanText: valid ? cleanText : input.clean_text ?? raw, edits, ops, latencyMs, valid };
  }

  async format(text: string, language?: string): Promise<{ text: string }> {
    const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
    const body = await this.messages({
      model,
      max_tokens: 2048, // whole formatted paragraph/list — give it room
      temperature: 0,
      system: FORMAT_PROMPT,
      messages: [{ role: "user", content: formatMessage(text, language) }],
    });
    let out = (body.content ?? []).find((b: any) => b.type === "text")?.text ?? text;
    out = String(out).replace(/^```[a-z]*\n?|\n?```$/g, "").trim(); // strip stray code fences
    return { text: out };
  }
}
