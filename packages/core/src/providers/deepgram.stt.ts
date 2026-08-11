import WebSocket from "ws";
import type {
  STTProvider,
  STTSession,
  STTSessionConfig,
  TranscriptEvent,
} from "./types";

// Deepgram streaming adapter.
// Deepgram sends interim + is_final results but NOT a stable/active split, so we
// derive it: everything from finalized results is `stableText`; the current
// interim tail is `activeText`. This is how any interim/final-only vendor maps
// onto our contract.
const WS_URL = "wss://api.deepgram.com/v1/listen";

export class DeepgramSTT implements STTProvider {
  readonly id = "deepgram";
  readonly requiredKeys = ["DEEPGRAM_API_KEY"];
  readonly audio = { sampleRate: 16000, encoding: "pcm_s16le", channels: 1 } as const;

  async startSession(cfg: STTSessionConfig): Promise<STTSession> {
    const url =
      `${WS_URL}?encoding=linear16&sample_rate=${this.audio.sampleRate}` +
      `&channels=1&interim_results=true&vad_events=true` +
      (cfg.language ? `&language=${cfg.language}` : "");
    const ws = new WebSocket(url, {
      headers: { Authorization: `Token ${cfg.apiKey}` },
    });
    return new DeepgramSession(ws);
  }
}

class DeepgramSession implements STTSession {
  private tcb?: (e: TranscriptEvent) => void;
  private ecb?: (e: Error) => void;
  private ccb?: () => void;
  private stable = "";           // accumulated finalized text (current utterance)
  private utteranceId = "u0";
  private uCounter = 0;

  constructor(private ws: WebSocket) {
    ws.on("message", (d) => this.onMessage(d.toString()));
    ws.on("error", (e) => this.ecb?.(e as Error));
    ws.on("close", () => this.ccb?.());
  }

  private onMessage(raw: string) {
    const m = JSON.parse(raw);
    if (m.type === "UtteranceEnd") {
      this.tcb?.({
        type: "final",
        utteranceId: this.utteranceId,
        text: this.stable.trim(),
        stableText: this.stable.trim(),
        activeText: "",
        endpoint: true,
      });
      this.stable = "";
      this.utteranceId = `u${++this.uCounter}`;
      return;
    }
    const alt = m.channel?.alternatives?.[0];
    if (!alt) return;
    const piece = alt.transcript ?? "";
    if (m.is_final) {
      this.stable = (this.stable + " " + piece).trim();
      this.emit("", true);
    } else {
      this.emit(piece, false); // interim tail = active
    }
  }

  private emit(active: string, isFinalPiece: boolean) {
    const stable = this.stable;
    this.tcb?.({
      type: "partial",
      utteranceId: this.utteranceId,
      text: (stable + " " + active).trim(),
      stableText: stable,
      activeText: active,
    });
    void isFinalPiece;
  }

  sendAudio(frame: ArrayBufferView | ArrayBuffer) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame as Buffer);
  }
  async finalize() {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "CloseStream" })); // Deepgram flush
    }
  }
  close() { this.ws.close(); }
  onTranscript(cb: (e: TranscriptEvent) => void) { this.tcb = cb; }
  onError(cb: (e: Error) => void) { this.ecb = cb; }
  onClose(cb: () => void) { this.ccb = cb; }
}
