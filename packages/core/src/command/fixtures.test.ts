import { describe, it, expect } from "vitest";
import { INTENT_FIXTURES } from "./fixtures";
import { validateIntent } from "./grammar";

// D6 — the shared serde contract fixture. Every fixture must survive `validateIntent`
// unchanged (it's already a well-formed, in-range CommandIntent). The mirror Rust test in
// command.rs deserializes the same JSON, so a drift in either enum definition fails a test.
describe("INTENT_FIXTURES (shared TS↔Rust serde contract)", () => {
  it("covers every action variant, including both inserts", () => {
    const actions = new Set(INTENT_FIXTURES.map((i) => i.action));
    expect(actions).toEqual(
      new Set([
        "format",
        "delete",
        "case",
        "select",
        "insert",
        "rewrite",
        "launch",
        "volume",
        "shortcut",
        "noop",
      ]),
    );
    const inserts = INTENT_FIXTURES.filter((i) => i.action === "insert");
    expect(inserts.some((i) => i.action === "insert" && i.what === "newline")).toBe(true);
    expect(inserts.some((i) => i.action === "insert" && i.what === "literal")).toBe(true);
  });

  it("each fixture is a valid CommandIntent (round-trips validateIntent unchanged)", () => {
    for (const intent of INTENT_FIXTURES) {
      const validated = validateIntent(intent);
      expect(validated).toEqual(intent);
    }
  });
});
