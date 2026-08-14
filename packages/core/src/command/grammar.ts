import type { CommandIntent, Target, FormatStyle, CaseMode, VolumeDir } from "./types";

// The closed enums. Kept here (not just in the type) so validation and the prompt
// can enumerate them at runtime — the single source of truth for "what's legal".
export const TARGETS: readonly Target[] = ["selection", "last-word", "last-sentence", "all"];
export const FORMAT_STYLES: readonly FormatStyle[] = ["bold", "italic", "underline"];
export const CASE_MODES: readonly CaseMode[] = ["upper", "lower", "title"];
// P2 — the closed volume directions (mirrors the Rust `VolumeDir` serde enum).
export const VOLUME_DIRS: readonly VolumeDir[] = ["up", "down", "mute", "unmute"];

const inSet = <T extends string>(set: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (set as readonly string[]).includes(v);

/**
 * Validate an arbitrary parsed object against the closed CommandIntent grammar.
 * Returns the typed intent, or `null` if it isn't a well-formed, in-range command
 * (the caller then falls back to `noop`). This is the command analogue of the
 * correction pipeline's `validate()` — never trust raw model output.
 */
export function validateIntent(o: unknown): CommandIntent | null {
  if (!o || typeof o !== "object") return null;
  const a = o as Record<string, unknown>;
  switch (a.action) {
    case "format":
      return inSet(FORMAT_STYLES, a.style) && inSet(TARGETS, a.target)
        ? { action: "format", style: a.style, target: a.target }
        : null;
    case "delete":
      return inSet(TARGETS, a.target) ? { action: "delete", target: a.target } : null;
    case "case":
      return inSet(CASE_MODES, a.mode) && inSet(TARGETS, a.target)
        ? { action: "case", mode: a.mode, target: a.target }
        : null;
    case "select":
      return inSet(TARGETS, a.target) ? { action: "select", target: a.target } : null;
    case "insert":
      if (a.what === "newline") return { action: "insert", what: "newline" };
      if (a.what === "literal" && typeof a.text === "string" && a.text.length > 0)
        return { action: "insert", what: "literal", text: a.text };
      return null;
    case "rewrite":
      // P1c — free-form instruction; require a non-empty instruction AND an in-range
      // target (same requiredness as format/delete/case above — a rewrite with no
      // instruction or an out-of-enum target is not well-formed, so it falls to noop).
      return typeof a.instruction === "string" && a.instruction.trim().length > 0 && inSet(TARGETS, a.target)
        ? { action: "rewrite", instruction: a.instruction, target: a.target }
        : null;
    case "launch":
      // P2 — free app name; require a non-empty string (the executor passes it as an
      // `open -a` arg, never through a shell).
      return typeof a.app === "string" && a.app.trim().length > 0
        ? { action: "launch", app: a.app }
        : null;
    case "volume":
      return inSet(VOLUME_DIRS, a.direction)
        ? { action: "volume", direction: a.direction }
        : null;
    case "shortcut":
      // P2 — free Shortcut name; require a non-empty string (passed as a `shortcuts run` arg).
      return typeof a.name === "string" && a.name.trim().length > 0
        ? { action: "shortcut", name: a.name }
        : null;
    case "noop":
      return { action: "noop", reason: typeof a.reason === "string" ? a.reason : "unspecified" };
    default:
      return null;
  }
}

/**
 * A tiny deterministic parser for a handful of exact, unambiguous phrases, so the
 * most common commands never need an LLM round-trip (latency + cost). Returns null
 * if there's no exact match — the caller then asks the model. Case- and
 * trailing-punctuation-insensitive.
 */
export function localParse(transcript: string): CommandIntent | null {
  const t = transcript.toLowerCase().replace(/[.,!?;:]+$/g, "").trim();
  switch (t) {
    case "new line":
    case "newline":
    case "new paragraph":
      return { action: "insert", what: "newline" };
    case "select all":
    case "select everything":
      return { action: "select", target: "all" };
    case "delete that":
    case "scratch that":
    case "delete selection":
      return { action: "delete", target: "selection" };
    case "delete the last word":
    case "delete last word":
      return { action: "delete", target: "last-word" };
    case "delete the last sentence":
    case "delete last sentence":
      return { action: "delete", target: "last-sentence" };
    case "bold that":
    case "make that bold":
      return { action: "format", style: "bold", target: "selection" };
    case "italic that":
    case "make that italic":
      return { action: "format", style: "italic", target: "selection" };
    case "underline that":
    case "underline that text":
      return { action: "format", style: "underline", target: "selection" };
    case "uppercase that":
    case "make that uppercase":
      return { action: "case", mode: "upper", target: "selection" };
    case "lowercase that":
    case "make that lowercase":
      return { action: "case", mode: "lower", target: "selection" };
    // P2 — exact, unambiguous system-volume phrases (launch/shortcut carry a free name
    // and stay model-only).
    case "volume up":
      return { action: "volume", direction: "up" };
    case "volume down":
      return { action: "volume", direction: "down" };
    case "mute":
      return { action: "volume", direction: "mute" };
    case "unmute":
      return { action: "volume", direction: "unmute" };
    default:
      return null;
  }
}
