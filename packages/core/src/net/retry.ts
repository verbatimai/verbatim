// Shared transient-failure retry for vendor HTTP + streaming connects (M5.1).
//
// One place for "what counts as transient" and the backoff schedule, so every
// vendor adapter (correction + batch transcription + STT connect) degrades the
// same way: retry a few times on 408/425/429/5xx or a network error, then throw
// a clear terminal error. Correction adapters (pyai/openai) already had this
// inline; this module is the reusable version used by the batch paths, the
// Anthropic adapter, and the reconnecting STT session.

/** HTTP statuses worth retrying (rate-limit / transient upstream). */
export const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export interface RetryOptions {
  /** Total attempts (>=1). Default 3. */
  attempts?: number;
  /** Base delay; delay for attempt i (0-based) is base*(i+1)^2 → 300, 1200, 2700ms. */
  baseMs?: number;
  /** Label for the thrown error / logs. */
  label?: string;
  /** Decide if a thrown error is retryable. Default: everything (network errors). */
  isRetryable?: (err: unknown) => boolean;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True for an Error carrying a transient HTTP `status` (see `httpError`). */
export function isTransientHttp(err: unknown): boolean {
  const s = (err as { status?: number } | undefined)?.status;
  return typeof s === "number" && TRANSIENT_STATUS.has(s);
}

/** An Error tagged with an HTTP status so `isTransientHttp` can classify it. */
export function httpError(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

/**
 * Run `fn` with retry-on-transient + quadratic backoff. `fn` should throw on
 * failure; a thrown error tagged with a transient `status` (or, by default, any
 * error) is retried up to `attempts` times, then re-thrown.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseMs = opts.baseMs ?? 300;
  const sleep = opts.sleep ?? defaultSleep;
  // Default policy: retry network errors AND transient-HTTP errors; a non-transient
  // HTTP error (401/404/400…) is terminal and thrown immediately.
  const retryable =
    opts.isRetryable ??
    ((e: unknown) => {
      const s = (e as { status?: number } | undefined)?.status;
      return s === undefined || TRANSIENT_STATUS.has(s);
    });
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1 || !retryable(e)) throw e;
      await sleep(baseMs * (i + 1) * (i + 1));
    }
  }
  throw lastErr;
}

/**
 * `fetch` with retry-on-transient. Non-OK responses become an `httpError` carrying
 * the status (so non-transient statuses are thrown terminally, transient ones
 * retried). Network errors (fetch reject) are retried too. The caller gets a
 * settled, OK `Response`.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const label = opts.label ?? "request";
  return withRetry(async () => {
    const res = await fetch(url, init);
    if (!res.ok) throw httpError(res.status, `${label} ${res.status}: ${await res.text()}`);
    return res;
  }, opts);
}
