import { describe, it, expect } from "vitest";
import { getIntentProvider } from "./registry";
import type { CommandIntent } from "./types";

// D3 — end-to-end classification through the registry-resolved provider, the same call
// the backend makes: `getIntentProvider(cmdId).interpret(raw, {model})`. Uses the offline
// "mock" provider (deterministic fast-path + canned phrases + noop fallback) so the table
// is a fixed contract with no network. Includes a noop row: an utterance that isn't an
// editing command must resolve to `{action:"noop"}`, never a guessed edit.
const CASES: Array<{ utterance: string; expected: CommandIntent }> = [
  { utterance: "new line", expected: { action: "insert", what: "newline" } },
  { utterance: "select all", expected: { action: "select", target: "all" } },
  { utterance: "delete that", expected: { action: "delete", target: "selection" } },
  { utterance: "delete the last word", expected: { action: "delete", target: "last-word" } },
  { utterance: "delete the last sentence", expected: { action: "delete", target: "last-sentence" } },
  { utterance: "make that bold", expected: { action: "format", style: "bold", target: "selection" } },
  { utterance: "italic that", expected: { action: "format", style: "italic", target: "selection" } },
  { utterance: "underline that", expected: { action: "format", style: "underline", target: "selection" } },
  { utterance: "uppercase that", expected: { action: "case", mode: "upper", target: "selection" } },
  { utterance: "lowercase that", expected: { action: "case", mode: "lower", target: "selection" } },
  { utterance: "make the last sentence bold", expected: { action: "format", style: "bold", target: "last-sentence" } },
  { utterance: "delete everything", expected: { action: "delete", target: "all" } },
  // P2 — volume fast-path rows (localParse, no model round-trip).
  { utterance: "volume up", expected: { action: "volume", direction: "up" } },
  { utterance: "volume down", expected: { action: "volume", direction: "down" } },
  { utterance: "mute", expected: { action: "volume", direction: "mute" } },
  { utterance: "unmute", expected: { action: "volume", direction: "unmute" } },
];

describe("command pipeline — getIntentProvider('mock').interpret", () => {
  const provider = getIntentProvider("mock");

  for (const { utterance, expected } of CASES) {
    it(`"${utterance}" → ${expected.action}`, async () => {
      const { intent, valid } = await provider.interpret(utterance, { model: "test-model" });
      expect(intent).toEqual(expected);
      expect(valid).toBe(true);
    });
  }

  it("an unrecognized utterance resolves to noop (never a guessed edit)", async () => {
    const { intent, valid } = await provider.interpret("please summarize this thread for me");
    expect(intent.action).toBe("noop");
    expect(valid).toBe(true);
  });
});
