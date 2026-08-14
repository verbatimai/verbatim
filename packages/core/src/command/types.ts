// Command mode (platform P1) — the third provider role, beside STTProvider
// (providers/types.ts) and CorrectionProvider (correction/types.ts).
//
// Dictation turns speech into TEXT injected into the focused field. Command mode
// turns speech into ONE structured editing ACTION on that same field. The model
// only classifies; a deterministic executor (Rust, on the Mac) performs the action.
// See docs/product/p1-command-mode-plan.md.

/** What an action operates on. "selection" is the default for "this"/"that". */
export type Target = "selection" | "last-word" | "last-sentence" | "all";
export type FormatStyle = "bold" | "italic" | "underline";
export type CaseMode = "upper" | "lower" | "title";
/** P2 — the closed volume directions (system command family). */
export type VolumeDir = "up" | "down" | "mute" | "unmute";

/**
 * A CLOSED set of intents the model may emit. Two families share one classifier:
 * field-scoped EDITING actions (P1) that a deterministic executor performs on the
 * focused field, and macOS-delegated SYSTEM commands (P2 — launch / volume /
 * run-shortcut) the executor hands to `open`/`osascript`/`shortcuts`. The model must
 * map an utterance to exactly one of these (or to `noop`); anything outside the
 * union/enums fails validation and becomes a `noop` — a wrong action edits the user's
 * document or fires a system command, so the design biases to doing nothing when unsure.
 */
export type CommandIntent =
  | { action: "format"; style: FormatStyle; target: Target }
  | { action: "delete"; target: Target }
  | { action: "case"; mode: CaseMode; target: Target }
  | { action: "select"; target: Target }
  | { action: "insert"; what: "newline" }
  | { action: "insert"; what: "literal"; text: string }
  // P1c — free-form rewrite of the target text, driven by a spoken instruction (e.g.
  // "make this more formal", "make that shorter"). Unlike the fixed actions above, the
  // TRANSFORMATION itself is open-ended — `instruction` carries it verbatim-ish — so
  // execution is a two-phase round trip (read the target text -> one LLM call using
  // whichever vendor/model is already selected as the correction provider -> paste the
  // result back), not a single deterministic keystroke like the other actions.
  | { action: "rewrite"; instruction: string; target: Target }
  // P2 — system commands (delegated to macOS, gated behind config.system_commands).
  | { action: "launch"; app: string }
  | { action: "volume"; direction: VolumeDir }
  | { action: "shortcut"; name: string }
  | { action: "noop"; reason: string };

export interface CommandContext {
  /** BCP-47 tag of the utterance (default "en"). Reserved for future localization. */
  language?: string;
  /** Per-request model override (mirrors CorrectionContext.model). */
  model?: string;
}

export interface IntentResult {
  intent: CommandIntent;
  /** false when the model output failed schema validation and we fell back to noop. */
  valid: boolean;
  latencyMs: number;
}

/**
 * One adapter per vendor, all sharing prompt.ts (system prompt + parseIntent) and
 * grammar.ts (validation), so adding a vendor is one wire-format file. Mirrors the
 * STTProvider / CorrectionProvider shape (readonly id + requiredKeys + one method).
 */
export interface IntentProvider {
  readonly id: string;
  readonly requiredKeys: string[];
  /** Map one command-mode utterance to a validated CommandIntent. */
  interpret(transcript: string, ctx?: CommandContext): Promise<IntentResult>;
}
