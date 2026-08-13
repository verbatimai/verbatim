// 3.5 — Snippets: deterministic post-transcript text expansion (spoken trigger →
// replacement). NO LLM — this is the acceptance criterion: given the same input and
// snippet list, the output is byte-identical every time.
//
// Semantics (documented so behaviour is predictable):
//   - Case-INSENSITIVE match of the trigger.
//   - WHOLE-PHRASE / word-boundary: a trigger only matches when flanked by
//     non-word characters (or string ends), so "sign" never fires inside "assignment".
//   - LONGEST trigger wins on overlap (e.g. "sig block" beats "sig").
//   - Triggers are treated LITERALLY — any regex metacharacters ("." "(" …) are escaped,
//     so a user trigger can't inject a pattern.
//   - Runs on the FINAL formatted text (see Pipeline/backend), so the expansion is
//     inserted verbatim and isn't re-punctuated by the formatter.

export interface Snippet {
  trigger: string;
  expansion: string;
}

/** Escape regex metacharacters so a trigger is matched as a literal string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Expand every snippet trigger found in `text` with its expansion. Deterministic and
 * pure (no I/O). Empty/whitespace triggers are ignored (belt-and-suspenders — the CRUD
 * layer also rejects them). Longest triggers are applied first so a shorter trigger
 * can't shadow a longer overlapping one.
 */
export function expandSnippets(text: string, snippets: Snippet[]): string {
  if (!text || !snippets || !snippets.length) return text;
  // Longest trigger first (avoids "sig" shadowing "sig block"); skip blank triggers.
  const active = snippets
    .filter((s) => s && s.trigger && s.trigger.trim().length > 0)
    .slice()
    .sort((a, b) => b.trigger.length - a.trigger.length);

  let out = text;
  for (const s of active) {
    const trigger = s.trigger.trim();
    // Word-boundary flanks WITHOUT consuming surrounding characters (lookaround), so
    // adjacent triggers still both fire. \b is unreliable for triggers that start/end
    // with a non-word char, so we assert a non-word (or string edge) on each side.
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escapeRegex(trigger)})(?=$|[^\\p{L}\\p{N}_])`, "giu");
    out = out.replace(re, (_m, pre) => `${pre}${s.expansion}`);
  }
  return out;
}
