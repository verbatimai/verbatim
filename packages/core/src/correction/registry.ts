import type { CorrectionProvider } from "./types";
import { PyAiCorrection } from "./pyai";
import { MockCorrection } from "./mock";
// import { AnthropicCorrection } from "./anthropic";
// import { OpenAiCorrection } from "./openai";

// All correction adapters share prompt.ts (system prompt + reconstruct), so a
// new vendor is just a wire-format mapping in one file, registered here.
const PROVIDERS: Record<string, () => CorrectionProvider> = {
  pyai: () => new PyAiCorrection(),
  mock: () => new MockCorrection(), // offline canned/heuristic correction
  // anthropic: () => new AnthropicCorrection(),
  // openai: () => new OpenAiCorrection(),
};

export function getCorrectionProvider(id: string = process.env.CORRECTION_PROVIDER ?? "pyai"): CorrectionProvider {
  const make = PROVIDERS[id];
  if (!make) {
    throw new Error(`Unknown correction provider '${id}'. Available: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return make();
}
