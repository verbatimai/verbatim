// App-level configuration: which vendors power STT and correction, and the
// dictation language. This is the single source of truth for provider selection,
// shared by the resolver (here), the Rust key hand-off, and the settings UI.
//
// SECRETS ARE NOT HERE. API keys live in the OS Keychain (Phase 3.5), keyed by
// each provider's `requiredKeys[]` name (e.g. PYAI_API_KEY). At runtime the Rust
// sidecar host injects the selected keys into the process env (see
// docs/architecture/vendor-transport.md), so capability checks read `process.env`.
import type { STTProvider } from "./providers/types";
import type { CorrectionProvider } from "./correction/types";
import { getSTTProvider } from "./providers/registry";
import { getCorrectionProvider } from "./correction/registry";

/** User-selectable STT vendors (demo/`fixture` is internal, not offered here). */
export type SttVendor = "pyai" | "deepgram" | "openai";
/** User-selectable correction vendors (`mock` is internal, not offered here). */
export type CorrectionVendor = "pyai" | "openai" | "anthropic";

export interface AppSettings {
  /** Streaming speech-to-text vendor. */
  sttProvider: SttVendor;
  /** Cleanup + format vendor. Resolved independently → mix-and-match. */
  correctionProvider: CorrectionVendor;
  /** BCP-47 / ISO-639-1 language tag. Default "en". */
  language: string;
  /**
   * 3.2 — let the STT vendor auto-detect the spoken language (Deepgram/OpenAI).
   * Default false. PyAI Hear ignores this (English-only) and the guard below keeps
   * warning; the UI greys the toggle when STT = pyai.
   */
  autoDetectLanguage?: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  sttProvider: "pyai",
  correctionProvider: "openai",
  language: "en",
  autoDetectLanguage: false,
};

export interface ResolvedProviders {
  stt: STTProvider;
  correction: CorrectionProvider;
  language: string;
  /**
   * Platform P1 — command-mode classifier vendor. Optional; when unset (or ""), the
   * backend follows `correctionProvider` (resolved lazily in server.ts, not here — a
   * missing value must NOT throw). Mirrors the correction vendor set.
   */
  commandProvider?: CorrectionVendor;
  /** Platform P1 — per-vendor model override for command mode ("" ⇒ provider default). */
  commandModel?: string;
  /**
   * Platform P3 — always-on on-device wake-word listener. Optional, off by default.
   * FLAT camelCase (must-fix 3): the store is a superset of AppSettings with same-key
   * camelCase fields, and set_config's shallow merge is one level deep, so a nested
   * object would NOT round-trip into the flat Rust `wake_word_*` fields.
   */
  wakeWordEnabled?: boolean;
  /** Platform P3 — which handler a detection fires: "dictate" | "command" (default "dictate"). */
  wakeWordHandler?: "dictate" | "command";
  /** Platform P3 — detection score threshold 0..1 (default 0.5; live-tunable, no listener restart). */
  wakeWordThreshold?: number;
  /** Platform P3 — wake-word model asset id under resources/wakeword/ (default stock "hey_jarvis"). */
  wakeWordModel?: string;
}

/**
 * Build the STT and correction providers from settings. The two roles are
 * resolved independently, so any valid pair works (e.g. Deepgram STT +
 * Anthropic correction). Throws (via the registries) on an unknown vendor id.
 */
export function resolveProviders(settings: AppSettings): ResolvedProviders {
  return {
    stt: getSTTProvider(settings.sttProvider),
    correction: getCorrectionProvider(settings.correctionProvider),
    language: settings.language || "en",
  };
}

/** True for "en" and any English region tag ("en-US", "en-GB", …). */
function isEnglish(language: string): boolean {
  const l = (language || "en").toLowerCase();
  return l === "en" || l.startsWith("en-") || l.startsWith("en_");
}

/**
 * Validate the selected combination WITHOUT throwing: returns a list of
 * human-readable problems (empty = good to go). Checks that every required key
 * for both chosen providers is present in `env`, plus the multilingual guard
 * (PyAI Hear is English-only). Callers can render these inline in Settings.
 */
export function capabilityErrors(
  settings: AppSettings,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const errors: string[] = [];

  let stt: STTProvider | undefined;
  try {
    stt = getSTTProvider(settings.sttProvider);
  } catch (e) {
    errors.push((e as Error).message);
  }
  let correction: CorrectionProvider | undefined;
  try {
    correction = getCorrectionProvider(settings.correctionProvider);
  } catch (e) {
    errors.push((e as Error).message);
  }

  if (stt) {
    const missing = stt.requiredKeys.filter((k) => !env[k]);
    if (missing.length) errors.push(`STT '${stt.id}' needs: ${missing.join(", ")}.`);
  }
  if (correction) {
    const missing = correction.requiredKeys.filter((k) => !env[k]);
    if (missing.length) errors.push(`Correction '${correction.id}' needs: ${missing.join(", ")}.`);
  }

  // Multilingual guard: PyAI Hear only accepts English (docs/architecture/multilingual.md).
  // 3.2 — auto-detect NEVER silences the PyAI-English-only warning: PyAI Hear ignores
  // detect and stays English-only, so the fixed-language error still fires (with an extra
  // note that auto-detect doesn't apply). For non-PyAI vendors, auto-detect relaxes the
  // fixed-language mismatch (there is no such error today — this is forward-safety + the
  // shared helper the widget mirrors).
  if (settings.sttProvider === "pyai" && !isEnglish(settings.language)) {
    const note = settings.autoDetectLanguage
      ? " (Auto-detect doesn't apply — PyAI Hear is English-only.)"
      : "";
    errors.push(
      `PyAI Hear is English-only — choose Deepgram or OpenAI as the STT vendor for language '${settings.language}'.${note}`,
    );
  }

  return errors;
}

/**
 * Fail-fast variant: throws one clear message listing every problem, or returns
 * cleanly if the combination is runnable. Call before starting a session.
 */
export function assertCapability(
  settings: AppSettings,
  env: Record<string, string | undefined> = process.env,
): void {
  const errors = capabilityErrors(settings, env);
  if (errors.length) {
    throw new Error(
      "Can't start dictation with the current settings:\n  - " +
        errors.join("\n  - ") +
        "\nAdd the missing keys in the widget's Settings (⚙), or a repo .env (dev).",
    );
  }
}
