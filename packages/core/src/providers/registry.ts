import type { STTProvider } from "./types";
import { PyAiSTT } from "./pyai.stt";
import { DeepgramSTT } from "./deepgram.stt";
import { OpenAiSTT } from "./openai.stt";
import { FixtureSTT } from "./fixture.stt";

// Add a vendor by adding one line here — no core changes needed elsewhere.
const STT_PROVIDERS: Record<string, () => STTProvider> = {
  pyai: () => new PyAiSTT(),
  deepgram: () => new DeepgramSTT(),
  openai: () => new OpenAiSTT(), // Realtime WS transcription + batch Whisper
  fixture: () => new FixtureSTT(), // offline replay of a real capture
};

export function getSTTProvider(
  id: string = process.env.STT_PROVIDER ?? "pyai",
): STTProvider {
  const make = STT_PROVIDERS[id];
  if (!make) {
    throw new Error(
      `Unknown STT provider '${id}'. Available: ${Object.keys(STT_PROVIDERS).join(", ")}`,
    );
  }
  return make();
}

/** Fail fast at startup if the selected provider's keys aren't present. */
export function assertKeys(provider: STTProvider): void {
  const missing = provider.requiredKeys.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Provider '${provider.id}' needs: ${missing.join(", ")}. Set them via the keychain (app) or .env (dev).`,
    );
  }
}
