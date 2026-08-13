import type { CorrectionProvider, CorrectionResult, CorrectionContext } from "./types";
import {
  SYSTEM_PROMPT,
  userMessage,
  parseJson,
  reconstruct,
  validate,
  FORMAT_PROMPT,
  formatMessage,
} from "./prompt";

const TRANSIENT = new Set([408, 409, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// JSON Schema for the compact-edits correction output. `strict: true` +
// additionalProperties:false + every property required is what makes OpenAI's
// Structured Outputs reliably return exactly this shape (vendor-apis.md §3).
const CORRECTION_SCHEMA = {
  name: "correction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["clean_text", "edits"],
    properties: {
      clean_text: { type: "string" },
      edits: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["raw", "replacement", "reason"],
          properties: {
            raw: { type: "string" },
            replacement: { type: "string" },
            reason: {
              type: "string",
              enum: ["filler", "false_start", "self_correction", "repetition", "grammar"],
            },
          },
        },
      },
    },
  },
} as const;

// OpenAI correction adapter. Uses Chat Completions with Structured Outputs
// (`response_format: json_schema`, strict) for the compact-edits schema, then
// reuses the SAME shared prompt + reconstructor + validator as every other
// vendor — only the wire format differs. OPENAI_BASE / OPENAI_CORRECTION_MODEL
// override the endpoint/model (tests, self-host, and the 4.7 model dropdown).
export class OpenAiCorrection implements CorrectionProvider {
  readonly id = "openai";
  readonly requiredKeys = ["OPENAI_API_KEY"];

  constructor(private apiKey = process.env.OPENAI_API_KEY ?? "") {}

  /** POST /v1/chat/completions with retry on transient errors; returns the parsed body. */
  private async chat(body: unknown, label: string): Promise<any> {
    const base = process.env.OPENAI_BASE ?? "https://api.openai.com/v1"; // read at call time (testable)
    const url = `${base}/chat/completions`;
    const attempts = Math.max(1, Number(process.env.OPENAI_RETRIES ?? 3));
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) return await res.json();
        const detail = `OpenAI ${label} ${res.status}: ${await res.text()}`;
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

  async correct(raw: string, ctx?: CorrectionContext): Promise<CorrectionResult> {
    // Phase 7 — per-request override wins; empty never overrides (env then default).
    const model = (ctx?.model && ctx.model.trim()) ? ctx.model : (process.env.OPENAI_CORRECTION_MODEL ?? "gpt-4o-mini");
    const t0 = Date.now();
    const body = await this.chat(
      {
        model,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage(raw, ctx?.priorContext, ctx?.language, ctx?.vocabulary) },
        ],
        response_format: { type: "json_schema", json_schema: CORRECTION_SCHEMA },
      },
      "correction",
    );
    const latencyMs = Date.now() - t0;
    const msg = body.choices?.[0]?.message ?? {};
    // Structured Outputs can hard-refuse (safety) — surface it rather than parsing junk.
    if (msg.refusal) throw new Error(`OpenAI correction refused: ${msg.refusal}`);
    const parsed = parseJson(String(msg.content ?? ""));
    const edits = parsed?.edits ?? [];
    const { cleanText, ops } = reconstruct(raw, edits);
    const valid = validate(cleanText, parsed?.clean_text ?? cleanText);
    return { cleanText: valid ? cleanText : parsed?.clean_text ?? raw, edits, ops, latencyMs, valid };
  }

  async format(text: string, language?: string, vocabulary?: string[], model?: string): Promise<{ text: string }> {
    // Phase 7 — same prefer-override resolution as correct().
    const resolvedModel = (model && model.trim()) ? model : (process.env.OPENAI_CORRECTION_MODEL ?? "gpt-4o-mini");
    const body = await this.chat(
      {
        model: resolvedModel,
        temperature: 0,
        messages: [
          { role: "system", content: FORMAT_PROMPT },
          { role: "user", content: formatMessage(text, language, vocabulary) },
        ],
      },
      "format",
    );
    let out = body.choices?.[0]?.message?.content ?? text;
    out = String(out).replace(/^```[a-z]*\n?|\n?```$/g, "").trim(); // strip stray code fences
    return { text: out };
  }
}
