import type { CommandIntent } from "./types";
import { validateIntent } from "./grammar";

// Shared across every intent adapter — the vendor only maps this to its own chat
// wire format (JSON-in-text for PyAI, json_object for OpenAI, forced tool-use for
// Anthropic). Mirrors correction/prompt.ts's SYSTEM_PROMPT + parseJson discipline.
export const SYSTEM_PROMPT = `You convert a short spoken command into ONE editing action on the user's current text field OR ONE system command. Output ONLY a JSON object — no prose, no code fences.

The ONLY valid editing actions (use exactly these shapes and enum values):
{"action":"format","style":"bold|italic|underline","target":"selection|last-word|last-sentence|all"}
{"action":"delete","target":"selection|last-word|last-sentence|all"}
{"action":"case","mode":"upper|lower|title","target":"selection|last-word|last-sentence|all"}
{"action":"select","target":"selection|last-word|last-sentence|all"}
{"action":"insert","what":"newline"}
{"action":"insert","what":"literal","text":"<verbatim text to type>"}

The ONLY valid system commands:
{"action":"launch","app":"<app name, e.g. Slack>"}
{"action":"volume","direction":"up|down|mute|unmute"}
{"action":"shortcut","name":"<macOS Shortcut name>"}

If the utterance is NOT clearly one of the actions above, return:
{"action":"noop","reason":"<short why>"}

Rules:
- Never invent an action, style, mode, target, direction, or "what" outside the lists above.
- Prefer "noop" when unsure — a wrong action edits the user's document or runs a system command.
- "this" / "that" / an unspecified target means "target":"selection".
- An EDIT acts on the current text (e.g. "make that bold" → {"action":"format","style":"bold","target":"selection"}). A LAUNCH opens an app (e.g. "open Slack" → {"action":"launch","app":"Slack"}). Don't confuse the two.
- A dictation-like sentence with no clear command intent is a noop (e.g. "let's open the meeting with a quick recap" → {"action":"noop","reason":"dictation, not a command"}).
- Output the JSON object and nothing else.`;

export function userMessage(transcript: string): string {
  return `Spoken command:\n${transcript}`;
}

/**
 * Extract the first JSON object from an LLM text response and validate it against
 * the grammar. Returns a valid CommandIntent, or `null` (caller → noop). Mirrors
 * correction/prompt.ts `parseJson` + `validate`, folded into one step because the
 * command output is a single small object, not a compact-edits list to reconstruct.
 */
export function parseIntent(text: string): CommandIntent | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return validateIntent(JSON.parse(m[0]));
  } catch {
    return null;
  }
}
