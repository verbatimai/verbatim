import type { CorrectionProvider, CorrectionResult, CorrectionContext } from "./types";
import { SYSTEM_PROMPT, userMessage, parseJson, reconstruct, validate, formatPromptFor, formatMessage } from "./prompt";
import type { FormatMode } from "./prompt";

const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// PyAI correction adapter. PyAI's text LLM is Anthropic-Messages-style at
// POST /v1/messages (model gpt-5.6-sol). NOTE (finding F1): forced tool-use
// currently 503s, so we use JSON-in-text mode, which works reliably.
// PyAI is being stress-tested and returns intermittent 5xx/429, so every call
// goes through a small retry-with-backoff (PYAI_RETRIES, default 3).
// PYAI_BASE overrides the API base (used by integration tests / self-host).
export class PyAiCorrection implements CorrectionProvider {
  readonly id = "pyai";
  readonly requiredKeys = ["PYAI_API_KEY"];

  constructor(private apiKey = process.env.PYAI_API_KEY ?? "") {}

  /** POST /v1/messages with retry on transient errors; returns the parsed body. */
  private async messages(body: unknown, label: string): Promise<any> {
    const base = process.env.PYAI_BASE ?? "https://api.pyai.com/v1"; // read at call time (testable)
    const url = `${base}/messages`;
    const attempts = Math.max(1, Number(process.env.PYAI_RETRIES ?? 3));
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) return await res.json();
        const detail = `PyAI ${label} ${res.status}: ${await res.text()}`;
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
    // Phase 7 — per-request override wins; empty never overrides. NOTE (F4): the PyAI
    // server currently IGNORES `model` (always gpt-5.6-sol), but we send the resolved
    // value on the wire for uniform threading — a documented no-op, not a regression.
    const model = (ctx?.model && ctx.model.trim()) ? ctx.model : (process.env.PYAI_MODEL ?? "gpt-5.6-sol");
    const t0 = Date.now();
    const body = await this.messages(
      {
        model,
        max_tokens: 1024,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage(raw, ctx?.priorContext, ctx?.language, ctx?.vocabulary) }],
      },
      "correction",
    );
    const latencyMs = Date.now() - t0;
    const text = (body.content ?? []).find((b: any) => b.type === "text")?.text ?? "";
    const parsed = parseJson(text);
    const edits = parsed?.edits ?? [];
    const { cleanText, ops } = reconstruct(raw, edits);
    const valid = validate(cleanText, parsed?.clean_text ?? cleanText);
    return { cleanText: valid ? cleanText : parsed?.clean_text ?? raw, edits, ops, latencyMs, valid };
  }

  async format(text: string, language?: string, vocabulary?: string[], model?: string, mode?: FormatMode): Promise<{ text: string }> {
    // Phase 7 — same prefer-override resolution as correct() (F4: server ignores it).
    const resolvedModel = (model && model.trim()) ? model : (process.env.PYAI_MODEL ?? "gpt-5.6-sol");
    const body = await this.messages(
      {
        model: resolvedModel,
        max_tokens: 2048, // whole formatted paragraph/list — give it room
        temperature: 0,
        system: formatPromptFor(mode),
        messages: [{ role: "user", content: formatMessage(text, language, vocabulary) }],
      },
      "format",
    );
    let out = (body.content ?? []).find((b: any) => b.type === "text")?.text ?? text;
    out = String(out).replace(/^```[a-z]*\n?|\n?```$/g, "").trim(); // strip stray code fences
    return { text: out };
  }
}
