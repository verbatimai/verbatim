import type { IntentProvider } from "./types";
import { PyAiIntent } from "./pyai";
import { OpenAiIntent } from "./openai";
import { AnthropicIntent } from "./anthropic";
import { MockIntent } from "./mock";

// All intent adapters share prompt.ts (system prompt + parseIntent) and grammar.ts
// (validation), so a new vendor is one wire-format file, registered here. Mirrors
// correction/registry.ts and providers/registry.ts.
const PROVIDERS: Record<string, () => IntentProvider> = {
  pyai: () => new PyAiIntent(),
  openai: () => new OpenAiIntent(),
  anthropic: () => new AnthropicIntent(),
  mock: () => new MockIntent(), // offline, no network — demos/tests
};

export function getIntentProvider(
  id: string = process.env.COMMAND_PROVIDER ?? "pyai",
): IntentProvider {
  const make = PROVIDERS[id];
  if (!make) {
    throw new Error(`Unknown command provider '${id}'. Available: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return make();
}

/**
 * Fail fast if the selected command provider's keys aren't present. Mirrors the
 * STT/correction registries' assert*Keys (named distinctly so the core barrel's
 * `export *` doesn't collide across the three registries).
 */
export function assertIntentKeys(
  provider: IntentProvider,
  env: Record<string, string | undefined> = process.env,
): void {
  const missing = provider.requiredKeys.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `Command provider '${provider.id}' needs: ${missing.join(", ")}. Set them via the app's key store or a dev .env.`,
    );
  }
}
