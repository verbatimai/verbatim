// Verbatim — capability map (v1, not exhaustive — edit here to add languages/models).
//
// Single source of truth for the settings UI's capability-driven interlock:
//   • which languages an STT provider/model offers,
//   • whether it supports auto-detect,
//   • which models each STT/correction provider exposes.
//
// Model value contract (matches Phase 7): "" (empty string) = "provider default".
// An empty model must NEVER override the server-side default, so the "default"
// option always carries value "".

export type Language = { code: string; name: string };
export type Model = { id: string; label: string; recommended?: boolean };

// Language catalog — the superset any broad provider can offer. UI adds an
// "Other… (custom BCP-47)" affordance on top of this for broad providers.
export const LANGUAGES: Language[] = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "hi", name: "Hindi" },
  { code: "pt", name: "Portuguese" },
  { code: "it", name: "Italian" },
  { code: "nl", name: "Dutch" },
  { code: "ru", name: "Russian" },
  { code: "ja", name: "Japanese" },
  { code: "zh", name: "Chinese" },
  { code: "ko", name: "Korean" },
  { code: "ar", name: "Arabic" },
  { code: "tr", name: "Turkish" },
  { code: "pl", name: "Polish" },
  { code: "sv", name: "Swedish" },
  { code: "id", name: "Indonesian" },
  { code: "uk", name: "Ukrainian" },
  { code: "vi", name: "Vietnamese" },
];

const ALL_LANGS = LANGUAGES.map((l) => l.code);

// Per-model overrides for languages / auto-detect. Falls back to the provider
// default when a model isn't listed here.
type SttModelCap = { languages?: string[]; supportsAutoDetect?: boolean };

type SttCap = {
  label: string;
  models: Model[];
  supportsAutoDetect: boolean; // provider default
  languages: string[]; // provider default
  broad: boolean; // true → offer the "Other… (custom BCP-47)" affordance
  byModel?: Record<string, SttModelCap>;
};

export const STT: Record<string, SttCap> = {
  pyai: {
    label: "PyAI Hear",
    models: [{ id: "pyai-hear", label: "Hear" }], // single — model select DISABLED
    supportsAutoDetect: false,
    languages: ["en"], // English-only
    broad: false,
  },
  deepgram: {
    label: "Deepgram",
    // nova-3 is recommended for multilingual; nova-2's live preview is es/en,
    // but its batch final detects broadly.
    models: [
      { id: "nova-2", label: "Nova-2" },
      { id: "nova-3", label: "Nova-3 (multilingual)", recommended: true },
    ],
    supportsAutoDetect: true,
    languages: ALL_LANGS,
    broad: true,
  },
  openai: {
    label: "OpenAI",
    models: [
      { id: "", label: "Default (gpt-4o-mini-transcribe)" },
      { id: "gpt-4o-transcribe", label: "gpt-4o-transcribe" },
    ],
    supportsAutoDetect: true,
    languages: ALL_LANGS, // Whisper is broad
    broad: true,
  },
  nemotron: {
    label: "Nemotron (local)",
    models: [
      { id: "q8_0", label: "Streaming 0.6B Q8 (recommended)", recommended: true },
    ],
    supportsAutoDetect: false,
    languages: ["en"],
    broad: false,
  },
};

type CorrectionCap = {
  label: string;
  models: Model[];
};

// PyAI was REMOVED as a correction vendor (packages/core/src/correction/registry.ts) —
// it stays the STT + TTS default, but no longer backs the cleanup/format/rewrite pass.
export const CORRECTION: Record<string, CorrectionCap> = {
  openai: {
    label: "OpenAI",
    models: [
      { id: "", label: "Default (gpt-4o-mini)" },
      { id: "gpt-4o", label: "gpt-4o" },
    ],
  },
  anthropic: {
    label: "Anthropic",
    models: [
      { id: "", label: "Default (claude-sonnet-4-5)" },
      { id: "claude-opus-4-1", label: "claude-opus-4-1" },
    ],
  },
};

// ---- helpers ----

export function sttModels(provider: string): Model[] {
  return STT[provider]?.models ?? [{ id: "", label: "Default" }];
}

export function sttLanguages(provider: string, model?: string): Language[] {
  const cap = STT[provider];
  if (!cap) return LANGUAGES;
  const codes =
    (model && cap.byModel?.[model]?.languages) || cap.languages;
  const set = new Set(codes);
  return LANGUAGES.filter((l) => set.has(l.code));
}

export function sttSupportsAutoDetect(provider: string, model?: string): boolean {
  const cap = STT[provider];
  if (!cap) return false;
  const perModel = model ? cap.byModel?.[model]?.supportsAutoDetect : undefined;
  return perModel ?? cap.supportsAutoDetect;
}

// Broad providers get the "Other… (custom BCP-47)" affordance in the UI.
export function sttIsBroad(provider: string): boolean {
  return STT[provider]?.broad ?? false;
}

export function correctionModels(provider: string): Model[] {
  return CORRECTION[provider]?.models ?? [{ id: "", label: "Default" }];
}

export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}
