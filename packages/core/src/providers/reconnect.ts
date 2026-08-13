import type { STTProvider, STTSession, STTSessionConfig, TranscriptEvent } from "./types";
import { withRetry } from "../net/retry";

// M5.1 — auto-reconnecting live STT session.
//
// The product path is batch-on-stop: the live socket is only a rolling PREVIEW,
// while the authoritative transcript is the backend's batch transcription of the
// full buffered PCM on stop. So this wrapper's job is narrow but important — keep
// the live preview alive across a flaky network so a dropped socket mid-dictation
// never ends the session. Frames arriving during a reconnect gap are dropped from
// the PREVIEW only; the backend keeps buffering every frame for the batch, so no
// dictation is lost. finalize()/close() are user intent and never reconnect.

export type ReconnectStatus = "connecting" | "live" | "reconnecting" | "failed" | "closed";

export interface ReconnectOptions {
  /** Reconnect attempts after an unexpected drop, per drop-episode (default 5). */
  maxAttempts?: number;
  /** Attempts for the INITIAL connect before giving up and throwing (default 3). */
  connectAttempts?: number;
  /** Backoff base; delay for attempt i (0-based) is base*(i+1)^2 (default 500ms). */
  baseMs?: number;
  /** Status callback for the error-UX banner (connecting/live/reconnecting/failed/closed). */
  onStatus?: (s: ReconnectStatus) => void;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startReconnectingSession(
  provider: STTProvider,
  cfg: STTSessionConfig,
  opts: ReconnectOptions = {},
): Promise<STTSession> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  const connectAttempts = Math.max(1, opts.connectAttempts ?? 3);
  const baseMs = opts.baseMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  const status = (s: ReconnectStatus) => opts.onStatus?.(s);

  let tcb: ((e: TranscriptEvent) => void) | undefined;
  let ecb: ((err: Error) => void) | undefined;
  let ccb: (() => void) | undefined;
  let current: STTSession | null = null;
  let userClosed = false;
  let reconnecting = false;

  // Point a freshly-opened underlying session at our stored callbacks. `tcb`/`ecb`/`ccb`
  // are read at call time, so the consumer can still set them after we return.
  const wire = (s: STTSession) => {
    s.onTranscript((e) => tcb?.(e));
    s.onError((err) => ecb?.(err));
    s.onClose(() => { void handleClose(); });
  };

  const handleClose = async () => {
    if (userClosed) { ccb?.(); return; }      // intentional close → propagate
    if (reconnecting) return;                  // an episode is already in flight
    reconnecting = true;
    status("reconnecting");
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(baseMs * (i + 1) * (i + 1));
      if (userClosed) { reconnecting = false; ccb?.(); return; }
      try {
        const s = await provider.startSession(cfg);
        wire(s);
        current = s;
        reconnecting = false;
        status("live");
        return;
      } catch {
        // keep trying until the episode's attempts are exhausted
      }
    }
    // Exhausted — give up and propagate close so the backend finalizes with the
    // audio it has buffered (never a silent hang).
    reconnecting = false;
    status("failed");
    ccb?.();
  };

  // Initial connect, with a bounded retry for transient network at session start.
  status("connecting");
  current = await withRetry(() => provider.startSession(cfg), {
    attempts: connectAttempts,
    baseMs,
    label: "STT connect",
    sleep,
  });
  wire(current);
  status("live");

  return {
    sendAudio(frame) { if (!reconnecting && !userClosed) current?.sendAudio(frame); },
    async finalize() { userClosed = true; await current?.finalize().catch(() => {}); },
    close() { userClosed = true; status("closed"); try { current?.close(); } catch { /* ignore */ } },
    onTranscript(cb) { tcb = cb; },
    onError(cb) { ecb = cb; },
    onClose(cb) { ccb = cb; },
  };
}
