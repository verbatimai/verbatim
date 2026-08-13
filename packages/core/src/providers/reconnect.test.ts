import { describe, it, expect, vi } from "vitest";
import { startReconnectingSession, type ReconnectStatus } from "./reconnect";
import type { STTProvider, STTSession, STTSessionConfig, TranscriptEvent } from "./types";

// A controllable fake session: tests drive its close/transcript by hand.
class FakeSession implements STTSession {
  tcb?: (e: TranscriptEvent) => void;
  ecb?: (err: Error) => void;
  ccb?: () => void;
  sent: unknown[] = [];
  finalized = false;
  closed = false;
  sendAudio(frame: ArrayBufferView | ArrayBuffer) { this.sent.push(frame); }
  async finalize() { this.finalized = true; }
  close() { this.closed = true; }
  onTranscript(cb: (e: TranscriptEvent) => void) { this.tcb = cb; }
  onError(cb: (err: Error) => void) { this.ecb = cb; }
  onClose(cb: () => void) { this.ccb = cb; }
  /** simulate the socket dropping */
  drop() { this.ccb?.(); }
}

function fakeProvider(sessions: FakeSession[], failFirst = 0): STTProvider {
  let calls = 0;
  return {
    id: "fake",
    requiredKeys: [],
    audio: { sampleRate: 16000, encoding: "pcm_s16le", channels: 1 },
    async startSession(_cfg: STTSessionConfig): Promise<STTSession> {
      const n = calls++;
      if (n < failFirst) throw new Error("connect fail");
      const s = sessions[Math.min(n - failFirst, sessions.length - 1)];
      return s;
    },
  };
}

const noSleep = async () => {};
const cfg: STTSessionConfig = { apiKey: "k" };

describe("startReconnectingSession (5.1)", () => {
  it("reconnects after an unexpected drop and stays alive", async () => {
    const s1 = new FakeSession(), s2 = new FakeSession();
    const status: ReconnectStatus[] = [];
    const session = await startReconnectingSession(fakeProvider([s1, s2]), cfg, {
      sleep: noSleep,
      onStatus: (s) => status.push(s),
    });
    // transcript flows from the first socket
    const events: string[] = [];
    session.onTranscript((e) => events.push(e.text));
    let closedPropagated = false;
    session.onClose(() => { closedPropagated = true; });
    s1.tcb?.({ type: "partial", utteranceId: "u0", text: "hello", stableText: "", activeText: "hello" });

    // socket drops unexpectedly → wrapper reconnects to s2, does NOT propagate close
    s1.drop();
    await Promise.resolve(); await Promise.resolve();
    expect(closedPropagated).toBe(false);
    expect(status).toContain("reconnecting");
    expect(status).toContain("live");

    // the NEW socket now carries transcript
    s2.tcb?.({ type: "final", utteranceId: "u1", text: "world", stableText: "world", activeText: "", endpoint: true });
    expect(events).toEqual(["hello", "world"]);
  });

  it("gives up after maxAttempts and propagates close so the backend can finalize", async () => {
    const s1 = new FakeSession();
    // provider that always throws on reconnect (only the initial session succeeds)
    let calls = 0;
    const provider: STTProvider = {
      id: "fake", requiredKeys: [], audio: { sampleRate: 16000, encoding: "pcm_s16le", channels: 1 },
      async startSession() { if (calls++ === 0) return s1; throw new Error("down"); },
    };
    const status: ReconnectStatus[] = [];
    const session = await startReconnectingSession(provider, cfg, {
      sleep: noSleep, maxAttempts: 3, onStatus: (s) => status.push(s),
    });
    let closed = false;
    session.onClose(() => { closed = true; });
    s1.drop();
    await new Promise((r) => setTimeout(r, 0));
    expect(status).toContain("failed");
    expect(closed).toBe(true);
  });

  it("finalize()/close() are intentional and never reconnect", async () => {
    const s1 = new FakeSession(), s2 = new FakeSession();
    const session = await startReconnectingSession(fakeProvider([s1, s2]), cfg, { sleep: noSleep });
    let closed = false;
    session.onClose(() => { closed = true; });
    await session.finalize();
    expect(s1.finalized).toBe(true);
    // the underlying session closing after a user finalize must just propagate, not reconnect
    s1.drop();
    await Promise.resolve();
    expect(closed).toBe(true);
    expect(s2.sent.length).toBe(0); // s2 was never opened
  });

  it("retries the INITIAL connect on transient failure", async () => {
    const s1 = new FakeSession();
    const session = await startReconnectingSession(fakeProvider([s1], /*failFirst*/ 2), cfg, {
      sleep: noSleep, connectAttempts: 3,
    });
    // if we got a session back, the 2 initial failures were retried through
    session.onTranscript(() => {});
    s1.tcb?.({ type: "partial", utteranceId: "u0", text: "ok", stableText: "", activeText: "ok" });
    expect(s1).toBeTruthy();
  });

  it("drops preview frames during a reconnect gap (backend still buffers for batch)", async () => {
    const s1 = new FakeSession();
    // never reconnects successfully → stays in the reconnecting window briefly
    let calls = 0;
    const provider: STTProvider = {
      id: "fake", requiredKeys: [], audio: { sampleRate: 16000, encoding: "pcm_s16le", channels: 1 },
      async startSession() { if (calls++ === 0) return s1; throw new Error("down"); },
    };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const session = await startReconnectingSession(provider, cfg, {
      maxAttempts: 1, sleep: () => gate, // hold inside the reconnect backoff
    });
    session.onClose(() => {});
    s1.drop(); // enters reconnecting, awaiting our gated sleep
    await Promise.resolve();
    session.sendAudio(new Uint8Array([1, 2, 3])); // should be dropped from preview
    expect(s1.sent.length).toBe(0);
    release();
  });
});
