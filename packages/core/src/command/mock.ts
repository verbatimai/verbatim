import type { IntentProvider, IntentResult, CommandContext, CommandIntent } from "./types";
import { localParse } from "./grammar";

/**
 * Offline intent provider for demos/tests — no network. Uses the deterministic
 * fast-path parser, then a few extra canned phrases; anything unrecognized becomes
 * a `noop`. Mirrors correction/mock.ts (canned table + a heuristic fallback).
 */
export class MockIntent implements IntentProvider {
  readonly id = "mock";
  readonly requiredKeys: string[] = [];

  async interpret(transcript: string, _ctx?: CommandContext): Promise<IntentResult> {
    const t0 = Date.now();
    const intent: CommandIntent =
      localParse(transcript) ??
      canned(transcript) ?? { action: "noop", reason: `mock: no rule for "${transcript.trim()}"` };
    return { intent, valid: true, latencyMs: Date.now() - t0 };
  }
}

/** A couple of multi-word phrases beyond the deterministic fast-path, for tests. */
function canned(transcript: string): CommandIntent | null {
  const t = transcript.toLowerCase().replace(/[.,!?;:]+$/g, "").trim();
  if (t === "make the last sentence bold")
    return { action: "format", style: "bold", target: "last-sentence" };
  if (t === "capitalize that" || t === "title case that")
    return { action: "case", mode: "title", target: "selection" };
  if (t === "delete everything") return { action: "delete", target: "all" };
  return null;
}
