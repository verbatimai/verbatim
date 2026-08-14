import { describe, it, expect } from "vitest";
import { validateIntent, localParse } from "./grammar";

describe("validateIntent (closed grammar)", () => {
  it("accepts every well-formed action shape", () => {
    expect(validateIntent({ action: "format", style: "bold", target: "selection" }))
      .toEqual({ action: "format", style: "bold", target: "selection" });
    expect(validateIntent({ action: "delete", target: "last-sentence" }))
      .toEqual({ action: "delete", target: "last-sentence" });
    expect(validateIntent({ action: "case", mode: "title", target: "all" }))
      .toEqual({ action: "case", mode: "title", target: "all" });
    expect(validateIntent({ action: "select", target: "all" }))
      .toEqual({ action: "select", target: "all" });
    expect(validateIntent({ action: "insert", what: "newline" }))
      .toEqual({ action: "insert", what: "newline" });
    expect(validateIntent({ action: "insert", what: "literal", text: "hi@x.com" }))
      .toEqual({ action: "insert", what: "literal", text: "hi@x.com" });
  });

  it("accepts the P2 system-command shapes", () => {
    expect(validateIntent({ action: "launch", app: "Slack" }))
      .toEqual({ action: "launch", app: "Slack" });
    expect(validateIntent({ action: "volume", direction: "up" }))
      .toEqual({ action: "volume", direction: "up" });
    expect(validateIntent({ action: "volume", direction: "mute" }))
      .toEqual({ action: "volume", direction: "mute" });
    expect(validateIntent({ action: "shortcut", name: "Start Standup" }))
      .toEqual({ action: "shortcut", name: "Start Standup" });
  });

  it("rejects malformed P2 system commands", () => {
    expect(validateIntent({ action: "launch", app: "" })).toBeNull(); // empty app
    expect(validateIntent({ action: "launch", app: "   " })).toBeNull(); // whitespace-only app
    expect(validateIntent({ action: "launch" })).toBeNull(); // no app
    expect(validateIntent({ action: "volume", direction: "louder" })).toBeNull(); // bad dir
    expect(validateIntent({ action: "volume" })).toBeNull(); // no direction
    expect(validateIntent({ action: "shortcut", name: "" })).toBeNull(); // empty name
    expect(validateIntent({ action: "shortcut" })).toBeNull(); // no name
  });

  it("normalizes a noop and defaults a missing reason", () => {
    expect(validateIntent({ action: "noop", reason: "not a command" }))
      .toEqual({ action: "noop", reason: "not a command" });
    expect(validateIntent({ action: "noop" }))
      .toEqual({ action: "noop", reason: "unspecified" });
  });

  it("rejects out-of-range enum values", () => {
    expect(validateIntent({ action: "format", style: "strike", target: "selection" })).toBeNull();
    expect(validateIntent({ action: "delete", target: "everything" })).toBeNull();
    expect(validateIntent({ action: "case", mode: "sentence", target: "all" })).toBeNull();
  });

  it("rejects unknown actions and missing required fields", () => {
    expect(validateIntent({ action: "translate", target: "all" })).toBeNull();
    expect(validateIntent({ action: "format", target: "selection" })).toBeNull(); // no style
    expect(validateIntent({ action: "insert", what: "literal" })).toBeNull(); // no text
    expect(validateIntent({ action: "insert", what: "literal", text: "" })).toBeNull(); // empty text
    expect(validateIntent({ action: "delete" })).toBeNull(); // no target
  });

  it("rejects non-objects", () => {
    expect(validateIntent(null)).toBeNull();
    expect(validateIntent("format")).toBeNull();
    expect(validateIntent(42)).toBeNull();
  });
});

describe("localParse (deterministic fast-path)", () => {
  it("maps exact phrases, ignoring case and trailing punctuation", () => {
    expect(localParse("New line.")).toEqual({ action: "insert", what: "newline" });
    expect(localParse("select all")).toEqual({ action: "select", target: "all" });
    expect(localParse("Scratch that!")).toEqual({ action: "delete", target: "selection" });
    expect(localParse("make that bold")).toEqual({ action: "format", style: "bold", target: "selection" });
    expect(localParse("delete the last sentence")).toEqual({ action: "delete", target: "last-sentence" });
  });

  it("fast-paths the exact P2 volume phrases", () => {
    expect(localParse("Volume up.")).toEqual({ action: "volume", direction: "up" });
    expect(localParse("volume down")).toEqual({ action: "volume", direction: "down" });
    expect(localParse("Mute!")).toEqual({ action: "volume", direction: "mute" });
    expect(localParse("unmute")).toEqual({ action: "volume", direction: "unmute" });
  });

  it("returns null for anything not on the fast-path (caller asks the model)", () => {
    expect(localParse("make the second paragraph a heading")).toBeNull();
    expect(localParse("what time is it")).toBeNull();
    expect(localParse("")).toBeNull();
  });
});
