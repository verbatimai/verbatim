import type { TtsProvider } from "./types";
import { PyAiTts } from "./pyai";
import { DeepgramTts } from "./deepgram";

// TTS registry — mirrors correction/registry.ts and providers/registry.ts. PyAI is the
// default (it already offers STT + TTS); Deepgram (Aura) is the second vendor, matching
// the "pyai/deepgram" pairing already established for STT.
const PROVIDERS: Record<string, () => TtsProvider> = {
  pyai: () => new PyAiTts(),
  deepgram: () => new DeepgramTts(),
};

export function getTtsProvider(id: string = process.env.TTS_PROVIDER ?? "pyai"): TtsProvider {
  const make = PROVIDERS[id];
  if (!make) {
    throw new Error(`Unknown TTS provider '${id}'. Available: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return make();
}

/**
 * Fail fast if the selected TTS provider's keys aren't present. Mirrors
 * assertCorrectionKeys/assertIntentKeys (named distinctly so the core barrel's
 * `export *` doesn't collide across the registries).
 */
export function assertTtsKeys(
  provider: TtsProvider,
  env: Record<string, string | undefined> = process.env,
): void {
  const missing = provider.requiredKeys.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `TTS provider '${provider.id}' needs: ${missing.join(", ")}. Set them via the keychain (app) or .env (dev).`,
    );
  }
}
