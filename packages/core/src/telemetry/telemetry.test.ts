import { describe, it, expect, vi } from "vitest";
import { Telemetry, NoopSink, sanitize, type TelemetrySink } from "./telemetry";

// A spy sink that records every event it's handed.
function spySink(): TelemetrySink & { events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  return { events, send: (e) => void events.push(e) };
}

describe("Telemetry (3.3 — no-op unless enabled, content-free when enabled)", () => {
  it("is a NO-OP when disabled — the sink is never called", () => {
    const sink = spySink();
    const send = vi.spyOn(sink, "send");
    const t = new Telemetry({ enabled: false, sink });
    t.emit({ type: "session_finalize", sttProvider: "pyai", rawLen: 11 });
    expect(send).not.toHaveBeenCalled();
    expect(sink.events).toEqual([]);
  });

  it("when enabled, forwards ONLY whitelisted fields (drops transcript/text content)", () => {
    const sink = spySink();
    const t = new Telemetry({ enabled: true, sink });
    // Intentionally include content-y fields that MUST be dropped. Cast through `any`
    // because transcript/text are NOT TelemetryEvent fields — the point is sanitize()
    // strips them even if a caller smuggles them in.
    t.emit({
      type: "session_finalize",
      sttProvider: "pyai",
      sttLatencyMs: 120,
      rawLen: 11,
      transcript: "secret words",
      text: "secret",
    } as any);
    expect(sink.events.length).toBe(1);
    const ev = sink.events[0];
    // whitelisted metadata present
    expect(ev.type).toBe("session_finalize");
    expect(ev.sttProvider).toBe("pyai");
    expect(ev.sttLatencyMs).toBe(120);
    expect(ev.rawLen).toBe(11);
    // content-y fields dropped
    expect("transcript" in ev).toBe(false);
    expect("text" in ev).toBe(false);
  });

  it("sanitize() drops any non-whitelisted key (allow-list, not deny-list)", () => {
    const out = sanitize({ audio: [1, 2, 3], apiKey: "x", type: "error", errorCode: "429" });
    expect(Object.keys(out).sort()).toEqual(["errorCode", "type"]);
    expect(out.type).toBe("error");
    expect(out.errorCode).toBe("429");
  });

  it("default sink is NoopSink — emit does not throw and performs no network", () => {
    const t = new Telemetry({ enabled: true }); // no sink → NoopSink
    expect(() => t.emit({ type: "session_start", sttProvider: "pyai" })).not.toThrow();
    // NoopSink.send is a no-op by construction.
    expect(() => new NoopSink().send({ type: "session_start" })).not.toThrow();
  });
});
