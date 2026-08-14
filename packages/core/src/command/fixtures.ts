import type { CommandIntent } from "./types";

// Shared serde contract fixture (platform P1, D6). One object of EVERY CommandIntent
// variant — including BOTH `insert` shapes (newline + literal). A TS test asserts each
// passes `validateIntent`; a Rust `#[cfg(test)]` in src-tauri/src/command.rs deserializes
// the SAME JSON strings. Keeping the two in sync is the whole point: the frontend
// `invoke("run_command",{intent})` payload must round-trip through both enum definitions,
// so if either side drifts, one of the two tests fails.
//
// ⚠ When you add/change a variant here, update the JSON block in command.rs's test to match.
export const INTENT_FIXTURES: CommandIntent[] = [
  { action: "format", style: "bold", target: "selection" },
  { action: "format", style: "italic", target: "last-word" },
  { action: "format", style: "underline", target: "last-sentence" },
  { action: "delete", target: "all" },
  { action: "delete", target: "last-word" },
  { action: "case", mode: "upper", target: "selection" },
  { action: "case", mode: "lower", target: "last-word" },
  { action: "case", mode: "title", target: "all" },
  { action: "select", target: "all" },
  { action: "select", target: "selection" },
  { action: "insert", what: "newline" },
  { action: "insert", what: "literal", text: "hello world" },
  // P1c — free-form rewrite (mirrored in command.rs's FIXTURES).
  { action: "rewrite", instruction: "make this more formal", target: "selection" },
  // P2 — one of each system-command variant (mirrored in command.rs's FIXTURES).
  { action: "launch", app: "Slack" },
  { action: "volume", direction: "up" },
  { action: "shortcut", name: "Start Standup" },
  { action: "noop", reason: "not an editing command" },
];
