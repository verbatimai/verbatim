// Local Nemotron Speech Streaming ASR via the Rust persistent worker (NeMo-Speech.cpp + Metal).
//
// Audio path: webview or native cpal capture → IPC (127.0.0.1:8788) → persistent ASR worker.
// No cloud dependency; no API key required.

import * as net from "node:net";
import type {
  STTProvider,
  STTSession,
  STTSessionConfig,
  TranscriptEvent,
} from "./types";

const DEFAULT_IPC_HOST = process.env.NEMOTRON_IPC_HOST ?? "127.0.0.1";
const DEFAULT_IPC_PORT = Number(process.env.NEMOTRON_IPC_PORT ?? 8788);

function pcmToF32(pcm: Uint8Array): Float32Array {
  const out = new Float32Array(pcm.length / 2);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

export class NemotronSTT implements STTProvider {
  readonly id = "nemotron";
  readonly requiredKeys: string[] = [];
  readonly audio = { sampleRate: 16000, encoding: "pcm_s16le", channels: 1 } as const;

  async startSession(cfg: STTSessionConfig): Promise<STTSession> {
    const host = process.env.NEMOTRON_IPC_HOST ?? DEFAULT_IPC_HOST;
    const port = Number(process.env.NEMOTRON_IPC_PORT ?? DEFAULT_IPC_PORT);
    return NemotronSession.connect(host, port, cfg.language ?? "en");
  }

  async transcribeBatch(
    pcm: Uint8Array,
    cfg: { sampleRate?: number; language?: string },
  ): Promise<string> {
    const host = process.env.NEMOTRON_IPC_HOST ?? DEFAULT_IPC_HOST;
    const port = Number(process.env.NEMOTRON_IPC_PORT ?? DEFAULT_IPC_PORT);
    const session = await NemotronSession.connect(host, port, cfg.language ?? "en");
    const chunk = 3200; // 100 ms @ 16 kHz mono s16le
    for (let i = 0; i < pcm.length; i += chunk) {
      session.sendAudio(pcm.subarray(i, i + chunk));
    }
    await session.finalize();
    session.close();
    return session.lastFinal;
  }
}

class NemotronSession implements STTSession {
  lastFinal = "";
  private transcriptCb: ((e: TranscriptEvent) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private buffer = "";
  private closed = false;

  private constructor(
    private socket: net.Socket,
    private acc: string,
  ) {
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("error", (e) => this.errorCb?.(e));
    this.socket.on("close", () => {
      if (!this.closed) this.closeCb?.();
    });
  }

  static connect(host: string, port: number, language: string): Promise<NemotronSession> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        socket.write(JSON.stringify({ type: "sessionStart", language }) + "\n");
      });
      const session = new NemotronSession(socket, "");
      const onData = (chunk: Buffer) => {
        session.acc += chunk.toString("utf8");
        while (true) {
          const i = session.acc.indexOf("\n");
          if (i < 0) break;
          const line = session.acc.slice(0, i);
          session.acc = session.acc.slice(i + 1);
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as any;
            if (msg.type === "ready") {
              socket.off("data", onData);
              session.socket.on("data", (c) => session.onData(c));
              resolve(session);
              return;
            }
            if (msg.type === "error") {
              reject(new Error(msg.message ?? "nemotron session start failed"));
              return;
            }
          } catch {
            /* wait for more */
          }
        }
      };
      socket.on("data", onData);
      socket.once("error", reject);
      setTimeout(() => reject(new Error("nemotron IPC timeout — is the widget running with stt_provider=nemotron?")), 5000);
    });
  }

  private onData(chunk: Buffer) {
    this.acc += chunk.toString("utf8");
    while (true) {
      const i = this.acc.indexOf("\n");
      if (i < 0) break;
      const line = this.acc.slice(0, i);
      this.acc = this.acc.slice(i + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "live") {
        this.emitPartial(msg.transcript ?? "", msg.active ?? "");
      } else if (msg.type === "transcript") {
        const e = msg.event ?? msg;
        this.emitPartial(e.stableText ?? e.text ?? "", e.activeText ?? "");
        if (e.isFinal || e.endpoint) {
          this.emitFinal(e.text ?? e.stableText ?? "");
        }
      } else if (msg.type === "final") {
        this.lastFinal = String(msg.text ?? "").trim();
        this.emitFinal(this.lastFinal);
      } else if (msg.type === "error") {
        this.errorCb?.(new Error(msg.message ?? "nemotron error"));
      }
    }
  }

  private emitPartial(stable: string, active: string) {
    const text = [stable, active].filter(Boolean).join(" ").trim();
    if (!text) return;
    this.buffer = text;
    this.transcriptCb?.({
      type: "partial",
      utteranceId: "u1",
      text,
      stableText: stable,
      activeText: active,
    });
  }

  private emitFinal(text: string) {
    const t = text.trim();
    if (!t) return;
    this.buffer = t;
    this.transcriptCb?.({
      type: "final",
      utteranceId: "u1",
      text: t,
      stableText: t,
      activeText: "",
      endpoint: true,
    });
  }

  sendAudio(frame: ArrayBufferView | ArrayBuffer): void {
    const buf =
      frame instanceof ArrayBuffer
        ? new Uint8Array(frame)
        : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(buf.length, 0);
    this.socket.write(len);
    this.socket.write(buf);
  }

  async finalize(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.socket.off("data", waiter);
        resolve();
      };
      const waiter = () => {
        if (this.lastFinal || this.buffer) done();
      };
      this.socket.on("data", waiter);
      this.socket.write(JSON.stringify({ type: "sessionStop" }) + "\n");
      setTimeout(done, 10000);
    });
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }

  onTranscript(cb: (e: TranscriptEvent) => void): void {
    this.transcriptCb = cb;
  }
  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
}

export { pcmToF32 };
