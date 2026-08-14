export * from "./providers/types";
export * from "./providers/registry";
export * from "./correction/types";
export * from "./correction/registry";
export * from "./correction/prompt";
export * from "./segmenter";
export * from "./pipeline";
export * from "./audio/wav";
export * from "./settings";
export * from "./snippets";
export * from "./telemetry/telemetry";
export * from "./meetings/types";
export * from "./meetings/transcript";
export * from "./meetings/prompt";
export * from "./meetings/registry";
export * from "./meetings/stereo";
export * from "./meetings/pyai.jobs";
export * from "./net/retry";
export * from "./providers/reconnect";
// Command mode (platform P1). Barrel-safe subset ONLY: `./command/prompt` is deliberately
// NOT exported — it collides with `./correction/prompt` on SYSTEM_PROMPT/userMessage
// (TS2308). The backend consumes getIntentProvider (registry) + the CommandIntent type.
export * from "./command/types";
export * from "./command/registry";
export * from "./command/grammar";
// P3 — text-to-speech (its own vendor-agnostic role, distinct from correction). First
// consumer: the wake-word listener's spoken greeting (apps/backend/src/server.ts's
// "speak" message).
export * from "./tts/types";
export * from "./tts/registry";
