import type { CorrectionProvider, CorrectionResult, CorrectionContext, CorrectionEdit } from "./types";
import { reconstruct, validate } from "./prompt";

// Offline correction for demos/tests — no network. Returns canned compact edits
// for known fixtures; otherwise strips standalone filler words heuristically.
const CANNED: Record<string, CorrectionEdit[]> = {
  "let's schedule a meeting at eightpm no no make it ninepm r i think that that works for me": [
    { raw: "eightpm no no make it ", replacement: "", reason: "self_correction" },
    { raw: "ninepm", replacement: "9 pm", reason: "grammar" },
    { raw: "r ", replacement: "", reason: "filler" },
    { raw: "that ", replacement: "", reason: "repetition" },
  ],
};

const FILLERS = new Set(["um", "umm", "uh", "ahh", "ah", "like", "er", "r"]);

function heuristicEdits(raw: string): CorrectionEdit[] {
  const edits: CorrectionEdit[] = [];
  const re = /\b(\w+)\b/g;
  let m: RegExpExecArray | null;
  let prev: string | null = null;
  while ((m = re.exec(raw))) {
    const word = m[1];
    const lower = word.toLowerCase();
    if (FILLERS.has(lower)) {
      edits.push({ raw: word + " ", replacement: "", reason: "filler" });
    } else if (prev && lower === prev.toLowerCase()) {
      edits.push({ raw: word + " ", replacement: "", reason: "repetition" });
    }
    prev = word;
  }
  return edits;
}

export class MockCorrection implements CorrectionProvider {
  readonly id = "mock";
  readonly requiredKeys: string[] = [];

  async correct(raw: string, _ctx?: CorrectionContext): Promise<CorrectionResult> {
    const t0 = Date.now();
    const edits = CANNED[raw.trim()] ?? heuristicEdits(raw);
    const { cleanText, ops } = reconstruct(raw, edits);
    // Small synthetic latency so the demo shows a realistic "correcting…" beat.
    await new Promise((r) => setTimeout(r, 120));
    return { cleanText, edits, ops, latencyMs: Date.now() - t0, valid: validate(cleanText, cleanText) };
  }

  // Offline formatting: light polish (capitalization, "i" -> "I", trailing period)
  // plus a simple spoken/numeric enumeration -> numbered list. The real quality
  // comes from the live LLM formatter; this just exercises the format pass offline.
  async format(text: string): Promise<{ text: string }> {
    let t = text.trim().replace(/\bi\b/g, "I");
    const enun = t.match(/^(.*?\bto do\b|.*?\bfollowing\b|.*?:)\s*(?:1\.?\s+|one\s+)(.+)$/i);
    if (enun) {
      const items = enun[2].split(/\s*(?:\d+\.?\s+|and\s+(?=(?:two|three|four|\d)\b)|,\s*)?\b(?:two|three|four|five)\b\s+|\s*(?:,|and)?\s*\b\d+\.?\s+/i)
        .map((s) => s.trim()).filter(Boolean);
      if (items.length >= 2) {
        const lead = enun[1].replace(/:$/, "").trim();
        const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
        return { text: `${cap(lead)}:\n\n` + items.map((it, i) => `${i + 1}. ${cap(it)}`).join("\n") };
      }
    }
    t = t.replace(/(^\s*|[.!?]\s+)([a-z])/g, (_m, p, c) => p + c.toUpperCase());
    if (t && !/[.!?]$/.test(t)) t += ".";
    return { text: t };
  }
}
