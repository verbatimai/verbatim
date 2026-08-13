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
}

export const DEFAULT_SETTINGS: AppSettings = {
  sttProvider: "pyai",
  correctionProvider: "pyai",
  language: "en",
};

export interface ResolvedProviders {
  stt: STTProvider;
  correction: CorrectionProvider;
  language: string;
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
  if (settings.sttProvider === "pyai" && !isEnglish(settings.language)) {
    errors.push(
      `PyAI Hear is English-only — choose Deepgram or OpenAI as the STT vendor for language '${settings.language}'.`,
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
