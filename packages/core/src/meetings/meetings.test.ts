import { describe, it, expect, afterEach } from "vitest";
import { MeetingTranscript, renderTranscript, speakerLabel, locateQuote, renderMarkdown, stamp } from "./transcript";
import { meetingUserMessage, templateById, TEMPLATES } from "./prompt";
import { OpenAiSummarizer } from "./openai.summarize";
import { getSummarizer } from "./registry";
import type { MeetingSession, TranscriptSegment } from "./types";

const seg = (atMs: number, stream: "me" | "them", text: string, speaker?: string): TranscriptSegment => ({
  atMs, stream, text, ...(speaker ? { speaker } : {}),
});

describe("MeetingTranscript", () => {
  it("keeps both streams in one timeline ordered by time", () => {
    const t = new MeetingTranscript(0);
    t.push("them", "how is the migration going", { atMs: 1000 });
    t.push("me", "mostly done", { atMs: 3000 });
    t.push("them", "great", { atMs: 5000 });
    expect(t.all().map((s) => s.stream)).toEqual(["them", "me", "them"]);
    expect(t.all().map((s) => s.atMs)).toEqual([1000, 3000, 5000]);
  });

  it("ignores empty and exactly-repeated pushes", () => {
    const t = new MeetingTranscript(0);
    expect(t.push("me", "  ", { atMs: 0 })).toBeNull();
    t.push("me", "hello", { atMs: 100 });
    expect(t.push("me", "hello", { atMs: 200 })).toBeNull();
    expect(t.all()).toHaveLength(1);
  });

  it("replaces rather than duplicates when a stream extends its last commit", () => {
    // Hear re-sends a growing revision of the same window (STATUS.md stitch caveat).
    const t = new MeetingTranscript(0);
    t.push("them", "we should ship", { atMs: 1000 });
    t.push("them", "we should ship on friday", { atMs: 1200 });
    expect(t.all()).toHaveLength(1);
    expect(t.all()[0].text).toBe("we should ship on friday");
  });

  it("does not merge across streams even when text extends", () => {
    const t = new MeetingTranscript(0);
    t.push("me", "we should ship", { atMs: 1000 });
    t.push("them", "we should ship on friday", { atMs: 1200 });
    expect(t.all()).toHaveLength(2);
  });
});

describe("speakerLabel", () => {
  it("prefers a resolved name, then a diarized id, then the stream", () => {
    expect(speakerLabel(seg(0, "me", "x"))).toBe("Me");
    expect(speakerLabel(seg(0, "them", "x"))).toBe("Them");
    expect(speakerLabel(seg(0, "them", "x", "spk_1"))).toBe("Speaker 1");
    expect(speakerLabel({ ...seg(0, "them", "x", "spk_1"), speakerName: "Priya" })).toBe("Priya");
  });
});

describe("renderTranscript", () => {
  it("merges consecutive turns from the same speaker and stamps the turn start", () => {
    const out = renderTranscript([
      seg(0, "them", "hi there"),
      seg(2000, "them", "thanks for joining"),
      seg(65000, "me", "no problem"),
    ]);
    expect(out).toBe("[00:00] Them: hi there thanks for joining\n[01:05] Me: no problem");
  });

  it("splits turns when a diarized speaker changes within the them stream", () => {
    const out = renderTranscript([
      seg(0, "them", "i can take that", "spk_0"),
      seg(3000, "them", "actually i will", "spk_1"),
    ]);
    expect(out.split("\n")).toHaveLength(2);
  });
});

describe("stamp", () => {
  it("uses mm:ss under an hour and h:mm:ss over", () => {
    expect(stamp(0)).toBe("00:00");
    expect(stamp(65_000)).toBe("01:05");
    expect(stamp(3_725_000)).toBe("1:02:05");
  });
});

describe("locateQuote", () => {
  const segs = [seg(1000, "them", "can you send the pricing deck by friday"), seg(9000, "me", "yes i will")];

  it("finds an exact substring", () => {
    expect(locateQuote(segs, "send the pricing deck")).toBe(1000);
  });

  it("tolerates light paraphrase via token overlap", () => {
    expect(locateQuote(segs, "send the pricing deck friday")).toBe(1000);
  });

  it("returns -1 for a fabricated quote — this is the hallucination guard", () => {
    expect(locateQuote(segs, "we agreed to a fifty percent discount")).toBe(-1);
    expect(locateQuote(segs, "")).toBe(-1);
  });
});

describe("prompt", () => {
  it("falls back to the general template for an unknown id", () => {
    expect(templateById("nope").id).toBe("general");
    expect(templateById("standup").id).toBe("standup");
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(5);
  });

  it("includes the notes, the transcript and the template guidance", () => {
    const msg = meetingUserMessage([seg(0, "them", "pricing came up")], "pricing?", {
      template: templateById("customer"),
    });
    expect(msg).toContain("Customer call");
    expect(msg).toContain("pricing?");
    expect(msg).toContain("Them: pricing came up");
  });

  it("says so explicitly when the user typed nothing", () => {
    const msg = meetingUserMessage([seg(0, "me", "hello")], "   ");
    expect(msg).toContain("the user typed nothing");
  });

  it("asks for the transcript's language when it is not English", () => {
    const msg = meetingUserMessage([seg(0, "me", "hola")], "", { language: "es" });
    expect(msg).toContain("es");
    expect(meetingUserMessage([seg(0, "me", "hi")], "")).not.toContain("LANGUAGE:");
  });
});

describe("registry", () => {
  it("resolves openai and rejects unknown vendors", () => {
    expect(getSummarizer("openai").id).toBe("openai");
    expect(() => getSummarizer("nope")).toThrow(/unknown summary provider/);
  });
});

// ── OpenAiSummarizer against a mock server (same style as the vendor adapters) ──
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockOpenAi(payload: unknown) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

describe("OpenAiSummarizer", () => {
  const segments = [
    seg(1000, "them", "can you send the pricing deck by friday"),
    seg(9000, "me", "yes i will send it thursday"),
  ];

  it("maps the structured response and anchors action items to timestamps", async () => {
    mockOpenAi({
      title: "Pricing follow-up",
      summary: "They asked for the deck.",
      key_points: ["Deck requested", ""],
      decisions: [],
      action_items: [{ text: "Send the pricing deck", owner: "Me", quote: "send the pricing deck by friday" }],
      open_questions: [],
      from_user_notes: [],
    });
    const note = await new OpenAiSummarizer("k").summarize({ segments, notes: "deck" });
    expect(note.title).toBe("Pricing follow-up");
    expect(note.keyPoints).toEqual(["Deck requested"]); // blank dropped
    expect(note.actionItems).toHaveLength(1);
    expect(note.actionItems[0].atMs).toBe(1000);
    expect(note.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("DROPS an action item whose quote is not in the transcript", async () => {
    mockOpenAi({
      title: "T", summary: "", key_points: [], decisions: [],
      action_items: [
        { text: "Send the deck", owner: "", quote: "send the pricing deck by friday" },
        { text: "Give a 50% discount", owner: "Me", quote: "we agreed to fifty percent off the annual plan" },
      ],
      open_questions: [], from_user_notes: [],
    });
    const note = await new OpenAiSummarizer("k").summarize({ segments, notes: "" });
    expect(note.actionItems.map((a) => a.text)).toEqual(["Send the deck"]);
  });

  it("throws a clear error on non-JSON content", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 })) as typeof fetch;
    await expect(new OpenAiSummarizer("k").summarize({ segments, notes: "" })).rejects.toThrow(/not valid JSON/);
  });

  it("surfaces a non-transient HTTP error", async () => {
    globalThis.fetch = (async () => new Response("bad key", { status: 401 })) as typeof fetch;
    await expect(new OpenAiSummarizer("k").summarize({ segments, notes: "" })).rejects.toThrow(/401/);
  });
});

describe("renderMarkdown", () => {
  it("produces a self-contained note with transcript and provenance footer", () => {
    const session: MeetingSession = {
      id: "m1",
      startedAt: new Date(0).toISOString(),
      durationMs: 9000,
      title: "Sync",
      segments: [seg(1000, "them", "send the deck")],
      notes: "deck",
      templateId: "general",
      sttProvider: "pyai",
      summaryProvider: "openai",
      note: {
        title: "Pricing follow-up",
        summary: "They asked for the deck.",
        keyPoints: ["Deck requested"],
        decisions: [],
        actionItems: [{ text: "Send the deck", owner: "Me", quote: "send the deck", atMs: 1000 }],
        openQuestions: [],
        fromUserNotes: [],
        latencyMs: 10,
      },
    };
    const md = renderMarkdown(session);
    expect(md).toContain("# Pricing follow-up");
    expect(md).toContain("- [ ] **Me** — Send the deck *(00:01)*");
    expect(md).toContain("## My notes");
    expect(md).toContain("Them: send the deck");
    expect(md).toContain("stored locally on this device");
    expect(md).not.toContain("## Decisions"); // empty sections omitted
  });
});
