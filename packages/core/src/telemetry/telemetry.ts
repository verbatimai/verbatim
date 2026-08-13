// 3.3 — Anonymous, opt-in telemetry. METADATA ONLY, never transcript/audio content.
//
// HARD SAFETY BOUNDARY (product-plan §14/§8):
//   1. A pure NO-OP unless `enabled` — `emit()` returns before any sink call, sanitize,
//      or allocation when the flag is off.
//   2. Content-free by construction — `sanitize()` is an ALLOW-LIST copy: only keys in
//      `ALLOWED_FIELDS` survive; anything else (transcript, text, audio, apiKey, …) is
//      dropped. It is NOT a deny-list, so a new field can't accidentally leak.
//
// TRANSPORT IS PARKED (settings-plan §10.1): the network sink/endpoint is UNDECIDED, so
// NO fetch/beacon lives here. The default sink is `NoopSink` (nothing leaves the device);
// the injectable `sink` constructor arg IS the seam a real transport plugs into later.

/**
 * The closed whitelist of metadata fields an event may carry. This is the single source
 * of truth for `sanitize()` — add a field here (and to `TelemetryEvent`) to allow it.
 * Note: `rawLen`/`cleanLen` are integer character COUNTS, never the text itself.
 */
export const ALLOWED_FIELDS = [
  "type",               // "session_start" | "session_finalize" | "error"
  "sttProvider",        // vendor id (e.g. "pyai")
  "correctionProvider", // vendor id
  "language",           // BCP-47 tag only (no content)
  "autoDetect",         // bool
  "correct",            // bool
  "format",             // bool
  "sttLatencyMs",       // number
  "correctionLatencyMs",// number
  "formatLatencyMs",    // number
  "rawLen",             // integer char count, NOT text
  "cleanLen",           // integer char count, NOT text
  "errorCode",          // short slug (e.g. "429"), NOT the message
  "errorPhase",         // short slug (e.g. "stt.stream")
  "appVersion",         // string
] as const;

export type TelemetryEventType = "session_start" | "session_finalize" | "error";

/** A telemetry event. All fields optional except `type`; anything outside ALLOWED_FIELDS
 *  is dropped by `sanitize()` and must never be transcript/audio content. */
export interface TelemetryEvent {
  type: TelemetryEventType;
  sttProvider?: string;
  correctionProvider?: string;
  language?: string;
  autoDetect?: boolean;
  correct?: boolean;
  format?: boolean;
  sttLatencyMs?: number;
  correctionLatencyMs?: number;
  formatLatencyMs?: number;
  rawLen?: number;
  cleanLen?: number;
  errorCode?: string;
  errorPhase?: string;
  appVersion?: string;
}

/** Where sanitized events go. The default is `NoopSink`; a real transport is PARKED. */
export interface TelemetrySink {
  send(event: Record<string, unknown>): void;
}

/** The DEFAULT sink — drops everything. Nothing leaves the device. */
export class NoopSink implements TelemetrySink {
  send(_event: Record<string, unknown>): void {
    /* no-op: transport parked (settings-plan §10.1) */
  }
}

const ALLOWED = new Set<string>(ALLOWED_FIELDS as readonly string[]);

/**
 * Allow-list copy: returns a NEW object containing ONLY keys in `ALLOWED_FIELDS`.
 * Any other key (transcript, text, audio, apiKey, …) is silently dropped. This is the
 * hard content-free boundary — keep it an allow-list, never a deny-list.
 */
export function sanitize(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ALLOWED_FIELDS) {
    if (raw[k] !== undefined) out[k] = raw[k];
  }
  // Defensive: ensure nothing outside the allow-list slipped through (it can't, but
  // the assertion documents the invariant for future readers).
  for (const k of Object.keys(out)) if (!ALLOWED.has(k)) delete out[k];
  return out;
}

/**
 * The reusable, unit-tested telemetry primitive. `emit()` is a provable no-op when
 * disabled and provably content-free (allow-list) when enabled.
 */
export class Telemetry {
  private readonly enabled: boolean;
  private readonly sink: TelemetrySink;

  constructor(opts: { enabled: boolean; sink?: TelemetrySink }) {
    this.enabled = opts.enabled;
    // TODO(telemetry-transport, settings-plan §10.1): endpoint UNDECIDED — wire a real
    // TelemetrySink here once the sink is chosen. Default stays NoopSink so nothing
    // leaves the device. Do NOT add fetch/beacon in this wave.
    this.sink = opts.sink ?? new NoopSink();
  }

  /** Emit one event. Returns immediately (no sink call, no sanitize, no allocation)
   *  when disabled; otherwise forwards the sanitized (allow-listed) event to the sink. */
  emit(event: TelemetryEvent): void {
    if (!this.enabled) return;
    this.sink.send(sanitize(event as unknown as Record<string, unknown>));
  }
}
