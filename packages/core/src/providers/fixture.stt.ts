import type { STTProvider, STTSession, STTSessionConfig, TranscriptEvent } from "./types";

// Replays a REAL captured PyAI Hear stream (from experiments/test_hear_stt.py) so
// the whole pipeline can be run and tested offline, with no network. The final
// event carries endpoint:true so the segmenter finalizes and correction runs.
const RECORDED: TranscriptEvent[] = [
  { type: "partial", utteranceId: "u1", stableText: "", activeText: "okay", text: "okay", tMs: 590 },
  { type: "partial", utteranceId: "u1", stableText: "let's schedule", activeText: "a meeting", text: "let's schedule a meeting", tMs: 2724 },
  { type: "partial", utteranceId: "u1", stableText: "let's schedule a meeting at", activeText: "eightpm no no", text: "let's schedule a meeting at eightpm no no", tMs: 3786 },
  { type: "partial", utteranceId: "u1", stableText: "let's schedule a meeting at eightpm no no make it ninepm", activeText: "r i think", text: "let's schedule a meeting at eightpm no no make it ninepm r i think", tMs: 6983 },
  {
    type: "final",
    utteranceId: "u1",
    stableText: "let's schedule a meeting at eightpm no no make it ninepm r i think that that works for me",
    activeText: "",
    text: "let's schedule a meeting at eightpm no no make it ninepm r i think that that works for me",
    endpoint: true,
    tMs: 8100,
  },
];

export class FixtureSTT implements STTProvider {
  readonly id = "fixture";
  readonly requiredKeys: string[] = [];
  readonly audio = { sampleRate: 16000, encoding: "pcm_s16le", channels: 1 } as const;

  constructor(private events: TranscriptEvent[] = RECORDED, private speedMs = 350) {}

  async startSession(_cfg: STTSessionConfig): Promise<STTSession> {
    return new FixtureSession(this.events, this.speedMs);
  }
}

class FixtureSession implements STTSession {
  private tcb?: (e: TranscriptEvent) => void;
  private ccb?: () => void;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(events: TranscriptEvent[], speedMs: number) {
    // Emit on a compressed schedule so a demo doesn't take 8 real seconds.
    events.forEach((e, i) => {
      this.timers.push(setTimeout(() => this.tcb?.(e), i * speedMs));
    });
    this.timers.push(setTimeout(() => this.ccb?.(), events.length * speedMs));
  }
  sendAudio(): void {/* fixture ignores audio */}
  async finalize(): Promise<void> {/* self-drives */}
  close(): void { this.timers.forEach(clearTimeout); }
  onTranscript(cb: (e: TranscriptEvent) => void) { this.tcb = cb; }
  onError(_cb: (e: Error) => void) {/* none */}
  onClose(cb: () => void) { this.ccb = cb; }
}
