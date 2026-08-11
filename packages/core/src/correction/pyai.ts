import type { CorrectionProvider, CorrectionResult, CorrectionContext } from "./types";
import { SYSTEM_PROMPT, userMessage, parseJson, reconstruct, validate, FORMAT_PROMPT, formatMessage } from "./prompt";

// PyAI correction adapter. PyAI's text LLM is Anthropic-Messages-style at
// POST /v1/messages (model gpt-5.6-sol). NOTE (finding F1): forced tool-use
// currently 503s, so we use JSON-in-text mode, which works reliably.
// PYAI_BASE overrides the API base (used by integration tests / self-host).
export class PyAiCorrection implements CorrectionProvider {
  readonly id = "pyai";
  readonly requiredKeys = ["PYAI_API_KEY"];

  constructor(private apiKey = process.env.PYAI_API_KEY ?? "") {}

  async correct(raw: string, ctx?: CorrectionContext): Promise<CorrectionResult> {
    const base = process.env.PYAI_BASE ?? "https://api.pyai.com/v1"; // read at call time (testable)
    const url = `${base}/messages`;
    const model = process.env.PYAI_MODEL ?? "gpt-5.6-sol";
    const t0 = Date.now();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage(raw, ctx?.priorContext) }],
      }),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) throw new Error(`PyAI correction ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as any;
    const text = (body.content ?? []).find((b: any) => b.type === "text")?.text ?? "";
    const parsed = parseJson(text);
    const edits = parsed?.edits ?? [];
    const { cleanText, ops } = reconstruct(raw, edits);
    const valid = validate(cleanText, parsed?.clean_text ?? cleanText);
    return { cleanText: valid ? cleanText : parsed?.clean_text ?? raw, edits, ops, latencyMs, valid };
  }

  async format(text: string): Promise<{ text: string }> {
    const base = process.env.PYAI_BASE ?? "https://api.pyai.com/v1";
    const model = process.env.PYAI_MODEL ?? "gpt-5.6-sol";
    const res = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        temperature: 0,
        system: FORMAT_PROMPT,
        messages: [{ role: "user", content: formatMessage(text) }],
      }),
    });
    if (!res.ok) throw new Error(`PyAI format ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as any;
    const out = (body.content ?? []).find((b: any) => b.type === "text")?.text ?? text;
    return { text: out.trim() };
  }
}
