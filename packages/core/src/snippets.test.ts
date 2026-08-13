import { describe, it, expect } from "vitest";
import { expandSnippets, type Snippet } from "./snippets";
import { Pipeline } from "./pipeline";
import { MockCorrection } from "./correction/mock";
import { FixtureSTT } from "./providers/fixture.stt";

describe("expandSnippets (3.5 — deterministic trigger → replacement)", () => {
  it("replaces a trigger with its expansion", () => {
    const out = expandSnippets("please insert sig block here", [
      { trigger: "sig block", expansion: "Best,\nMayank" },
    ]);
    expect(out).toContain("Best,");
    expect(out).not.toContain("sig block");
  });

  it("is case-insensitive and whole-phrase (no mid-word matches)", () => {
    // "Sig Block" (different case) matches.
    expect(
      expandSnippets("Sig Block please", [{ trigger: "sig block", expansion: "SIGNATURE" }]),
    ).toContain("SIGNATURE");
    // "sign" must NOT match inside "assignment".
    const out = expandSnippets("finish the assignment", [{ trigger: "sign", expansion: "X" }]);
    expect(out).toBe("finish the assignment");
  });

  it("longest trigger wins on overlap", () => {
    const snippets: Snippet[] = [
      { trigger: "sig", expansion: "SHORT" },
      { trigger: "sig block", expansion: "LONG" },
    ];
    const out = expandSnippets("my sig block done", snippets);
    expect(out).toContain("LONG");
    expect(out).not.toContain("SHORT");
    expect(out).not.toContain("sig block");
  });

  it("no snippets / empty list is identity", () => {
    expect(expandSnippets("nothing to do here", [])).toBe("nothing to do here");
  });

  it("special-regex triggers are treated literally", () => {
    // A trigger containing regex metacharacters matches literally, not as a pattern.
    const out = expandSnippets("call foo() now", [{ trigger: "foo()", expansion: "BAR" }]);
    expect(out).toContain("BAR");
    // A dot in the trigger must not act as "any char".
    const dot = expandSnippets("ping a.b there", [{ trigger: "a.b", expansion: "HIT" }]);
    expect(dot).toContain("HIT");
    const noMatch = expandSnippets("ping axb there", [{ trigger: "a.b", expansion: "HIT" }]);
    expect(noMatch).toBe("ping axb there"); // "axb" is not a literal "a.b"
  });

  it("ignores blank/whitespace triggers", () => {
    expect(expandSnippets("leave me be", [{ trigger: "   ", expansion: "X" }])).toBe("leave me be");
  });
});

describe("Pipeline applies snippets to the final output (3.5)", () => {
  it("expands a trigger in the finalized formatted text", async () => {
    // One clean utterance whose final text contains the trigger phrase.
    const events = [
      {
        type: "final" as const,
        utteranceId: "u1",
        stableText: "please insert sig block",
        activeText: "",
        text: "please insert sig block",
        endpoint: true,
      },
    ];
    let formatted = "";
    const pipeline = new Pipeline(
      new FixtureSTT(events, 10),
      new MockCorrection(),
      { onFormatted: (u) => (formatted = u.text) },
      { snippets: [{ trigger: "sig block", expansion: "Best regards" }] },
    );
    await pipeline.run();
    expect(formatted).toContain("Best regards");
    expect(formatted.toLowerCase()).not.toContain("sig block");
  });
});
