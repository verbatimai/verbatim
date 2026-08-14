import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  resolveProviders,
  capabilityErrors,
  assertCapability,
  type AppSettings,
} from "./settings";

const NO_ENV: Record<string, string | undefined> = {};
const PYAI_ONLY = { PYAI_API_KEY: "k" };
const PYAI_AND_OPENAI = { PYAI_API_KEY: "k", OPENAI_API_KEY: "o" };
const DEEPGRAM_AND_OPENAI = { DEEPGRAM_API_KEY: "d", OPENAI_API_KEY: "o" };
const BOTH_KEYS = { PYAI_API_KEY: "k", DEEPGRAM_API_KEY: "d" };

describe("AppSettings resolver", () => {
  it("defaults to PyAI STT + OpenAI correction in English", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      sttProvider: "pyai",
      correctionProvider: "openai",
      language: "en",
      autoDetectLanguage: false,
    });
    const r = resolveProviders(DEFAULT_SETTINGS);
    expect(r.stt.id).toBe("pyai");
    expect(r.correction.id).toBe("openai");
    expect(r.language).toBe("en");
  });

  it("resolves STT and correction independently (mix-and-match)", () => {
    // PyAI remains valid for STT; correction is openai/anthropic only (PyAI was
    // removed as a correction vendor — it stays the STT + TTS default).
    const r = resolveProviders({
      sttProvider: "deepgram",
      correctionProvider: "anthropic",
      language: "en",
    });
    expect(r.stt.id).toBe("deepgram");
    expect(r.correction.id).toBe("anthropic");
  });

  it("falls back to 'en' when language is blank", () => {
    const r = resolveProviders({ sttProvider: "pyai", correctionProvider: "openai", language: "" });
    expect(r.language).toBe("en");
  });
});

describe("capabilityErrors", () => {
  it("reports missing keys for both roles when env is empty", () => {
    const errs = capabilityErrors(DEFAULT_SETTINGS, NO_ENV);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => /STT 'pyai'.*PYAI_API_KEY/.test(e))).toBe(true);
    expect(errs.some((e) => /Correction 'openai'.*OPENAI_API_KEY/.test(e))).toBe(true);
  });

  it("passes when both STT and correction keys are present", () => {
    expect(capabilityErrors(DEFAULT_SETTINGS, PYAI_AND_OPENAI)).toEqual([]);
  });

  it("still flags the STT key when only the correction key is present", () => {
    const settings: AppSettings = {
      sttProvider: "deepgram",
      correctionProvider: "openai",
      language: "en",
    };
    const errs = capabilityErrors(settings, PYAI_AND_OPENAI); // has OPENAI but not DEEPGRAM
    expect(errs.some((e) => /STT 'deepgram'.*DEEPGRAM_API_KEY/.test(e))).toBe(true);
    expect(errs.some((e) => /Correction/.test(e))).toBe(false); // openai correction is satisfied
  });

  it("blocks a non-English language on PyAI (English-only guard)", () => {
    const errs = capabilityErrors(
      { sttProvider: "pyai", correctionProvider: "openai", language: "fr" },
      PYAI_AND_OPENAI,
    );
    expect(errs.some((e) => /English-only/.test(e))).toBe(true);
  });

  it("allows non-English when STT is a multilingual vendor", () => {
    const errs = capabilityErrors(
      { sttProvider: "deepgram", correctionProvider: "openai", language: "fr" },
      DEEPGRAM_AND_OPENAI,
    );
    expect(errs).toEqual([]);
  });

  it("accepts English region tags (en-US) on PyAI", () => {
    const errs = capabilityErrors(
      { sttProvider: "pyai", correctionProvider: "openai", language: "en-US" },
      PYAI_AND_OPENAI,
    );
    expect(errs).toEqual([]);
  });

  // 3.2 — auto-detect language relaxation + the preserved PyAI-English-only warning.
  it("auto-detect on + non-PyAI STT relaxes the fixed-language guard", () => {
    const errs = capabilityErrors(
      { sttProvider: "deepgram", correctionProvider: "openai", language: "fr", autoDetectLanguage: true },
      DEEPGRAM_AND_OPENAI,
    );
    expect(errs).toEqual([]); // no language error for a multilingual vendor under auto-detect
  });

  it("auto-detect on + PyAI STT STILL warns English-only (never silenced)", () => {
    const errs = capabilityErrors(
      { sttProvider: "pyai", correctionProvider: "openai", language: "fr", autoDetectLanguage: true },
      PYAI_AND_OPENAI,
    );
    expect(errs.some((e) => /English-only/.test(e))).toBe(true); // warning preserved
    expect(errs.some((e) => /Auto-detect doesn't apply/.test(e))).toBe(true); // distinct note added
  });

  it("surfaces a clear message for an unknown vendor id", () => {
    const errs = capabilityErrors(
      { sttProvider: "nope" as never, correctionProvider: "openai", language: "en" },
      PYAI_ONLY,
    );
    expect(errs.some((e) => /Unknown STT provider 'nope'/.test(e))).toBe(true);
  });

  it("surfaces a clear message for a removed correction vendor id (pyai)", () => {
    // PyAI was removed as a correction option (it stays STT + TTS only) — selecting
    // it as correctionProvider must fail the same way any other unknown id does,
    // not silently resolve to something else.
    const errs = capabilityErrors(
      { sttProvider: "pyai", correctionProvider: "pyai" as never, language: "en" },
      BOTH_KEYS,
    );
    expect(errs.some((e) => /Unknown correction provider 'pyai'/.test(e))).toBe(true);
  });
});

describe("assertCapability", () => {
  it("throws one message listing problems when unsatisfied", () => {
    expect(() => assertCapability(DEFAULT_SETTINGS, NO_ENV)).toThrow(/PYAI_API_KEY|OPENAI_API_KEY/);
  });

  it("does not throw when the combination is runnable", () => {
    expect(() => assertCapability(DEFAULT_SETTINGS, PYAI_AND_OPENAI)).not.toThrow();
  });
});
