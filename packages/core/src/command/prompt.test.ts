import { describe, it, expect } from "vitest";
import { parseIntent } from "./prompt";

describe("parseIntent (extract first JSON object + validate)", () => {
  it("parses a clean JSON command", () => {
    expect(parseIntent('{"action":"delete","target":"selection"}'))
      .toEqual({ action: "delete", target: "selection" });
  });

  it("extracts JSON embedded in stray prose / fences", () => {
    const wrapped = 'Sure!\n```json\n{"action":"insert","what":"newline"}\n```';
    expect(parseIntent(wrapped)).toEqual({ action: "insert", what: "newline" });
  });

  it("returns null (→ caller noop) on non-JSON output", () => {
    expect(parseIntent("I can't do that")).toBeNull();
    expect(parseIntent("")).toBeNull();
  });

  it("parses a P1c rewrite command", () => {
    expect(parseIntent('{"action":"rewrite","instruction":"make this more formal","target":"selection"}'))
      .toEqual({ action: "rewrite", instruction: "make this more formal", target: "selection" });
  });

  it("parses the P2 system-command shapes", () => {
    expect(parseIntent('{"action":"launch","app":"Slack"}'))
      .toEqual({ action: "launch", app: "Slack" });
    expect(parseIntent('{"action":"volume","direction":"up"}'))
      .toEqual({ action: "volume", direction: "up" });
    expect(parseIntent('{"action":"shortcut","name":"Start Standup"}'))
      .toEqual({ action: "shortcut", name: "Start Standup" });
  });

  it("returns null when the JSON is out of grammar (validate rejects it)", () => {
    expect(parseIntent('{"action":"format","style":"rainbow","target":"all"}')).toBeNull();
    expect(parseIntent('{"action":"volume","direction":"louder"}')).toBeNull(); // bad dir
    expect(parseIntent('{"action":"launch","app":""}')).toBeNull(); // empty app
    expect(parseIntent('{"action":"rewrite","instruction":"","target":"selection"}')).toBeNull(); // empty instruction
    expect(parseIntent('{"action":"teleport","to":"mars"}')).toBeNull(); // unknown action
  });

  it("returns null on malformed JSON", () => {
    expect(parseIntent('{"action":"delete", target:}')).toBeNull();
  });
});
