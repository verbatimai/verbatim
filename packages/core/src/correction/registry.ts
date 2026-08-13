import type { CorrectionProvider } from "./types";
import { PyAiCorrection } from "./pyai";
import { MockCorrection } from "./mock";
import { OpenAiCorrection } from "./openai";
// import { AnthropicCorrection } from "./anthropic";
import { AnthropicCorrection } from "./anthropic";
// import { OpenAiCorrection } from "./openai";

// All correction adapters share prompt.ts (system prompt + reconstruct), so a
// new vendor is just a wire-format mapping in one file, registered here.
const PROVIDERS: Record<string, () => CorrectionProvider> = {
  pyai: () => new PyAiCorrection(),
  openai: () => new OpenAiCorrection(), // /v1/chat/completions + Structured Outputs
  mock: () => new MockCorrection(), // offline canned/heuristic correction
  // anthropic: () => new AnthropicCorrection(),
  anthropic: () => new AnthropicCorrection(),
  // openai: () => new OpenAiCorrection(),
};

export function getCorrectionProvider(id: string = process.env.CORRECTION_PROVIDER ?? "pyai"): CorrectionProvider {
  const make = PROVIDERS[id];
  if (!make) {
    throw new Error(`Unknown correction provider '${id}'. Available: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return make();
}

/**
 * Fail fast if the selected correction provider's keys aren't present. Mirrors
 * the STT registry's `assertKeys` (named distinctly so the core barrel's
 * `export *` doesn't collide on the two registries). `assertCapability` in
 * settings.ts checks both roles at once; this stays for symmetry / direct use.
 */
export function assertCorrectionKeys(
  provider: CorrectionProvider,
  env: Record<string, string | undefined> = process.env,
): void {
  const missing = provider.requiredKeys.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `Correction provider '${provider.id}' needs: ${missing.join(", ")}. Set them via the keychain (app) or .env (dev).`,
    );
  }
}
