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
const BOTH_KEYS = { PYAI_API_KEY: "k", DEEPGRAM_API_KEY: "d" };

describe("AppSettings resolver", () => {
  it("defaults to PyAI STT + PyAI correction in English", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      sttProvider: "pyai",
      correctionProvider: "pyai",
      language: "en",
      autoDetectLanguage: false,
    });
    const r = resolveProviders(DEFAULT_SETTINGS);
    expect(r.stt.id).toBe("pyai");
    expect(r.correction.id).toBe("pyai");
    expect(r.language).toBe("en");
  });

  it("resolves STT and correction independently (mix-and-match)", () => {
    const r = resolveProviders({
      sttProvider: "deepgram",
      correctionProvider: "pyai",
      language: "en",
    });
    expect(r.stt.id).toBe("deepgram");
    expect(r.correction.id).toBe("pyai");
  });

  it("falls back to 'en' when language is blank", () => {
    const r = resolveProviders({ sttProvider: "pyai", correctionProvider: "pyai", language: "" });
    expect(r.language).toBe("en");
  });
});

describe("capabilityErrors", () => {
  it("reports missing keys for both roles when env is empty", () => {
    const errs = capabilityErrors(DEFAULT_SETTINGS, NO_ENV);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => /STT 'pyai'.*PYAI_API_KEY/.test(e))).toBe(true);
    expect(errs.some((e) => /Correction 'pyai'.*PYAI_API_KEY/.test(e))).toBe(true);
  });

  it("passes when the one shared key satisfies both roles", () => {
    expect(capabilityErrors(DEFAULT_SETTINGS, PYAI_ONLY)).toEqual([]);
  });

  it("still flags the STT key when only the correction key is present", () => {
    const settings: AppSettings = {
      sttProvider: "deepgram",
      correctionProvider: "pyai",
      language: "en",
    };
    const errs = capabilityErrors(settings, PYAI_ONLY); // has PYAI but not DEEPGRAM
    expect(errs.some((e) => /STT 'deepgram'.*DEEPGRAM_API_KEY/.test(e))).toBe(true);
    expect(errs.some((e) => /Correction/.test(e))).toBe(false); // pyai correction is satisfied
  });

  it("blocks a non-English language on PyAI (English-only guard)", () => {
    const errs = capabilityErrors(
      { sttProvider: "pyai", correctionProvider: "pyai", language: "fr" },
      PYAI_ONLY,
    );
    expect(errs.some((e) => /English-only/.test(e))).toBe(true);
  });

  it("allows non-English when STT is a multilingual vendor", () => {
    const errs = capabilityErrors(
      { sttProvider: "deepgram", correctionProvider: "pyai", language: "fr" },
      BOTH_KEYS,
    );
    expect(errs).toEqual([]);
  });

  it("accepts English region tags (en-US) on PyAI", () => {
    const errs = capabilityErrors(
      { sttProvider: "pyai", correctionProvider: "pyai", language: "en-US" },
      PYAI_ONLY,
    );
    expect(errs).toEqual([]);
  });

  // 3.2 — auto-detect language relaxation + the preserved PyAI-English-only warning.
  it("auto-detect on + non-PyAI STT relaxes the fixed-language guard", () => {
    const errs = capabilityErrors(
      { sttProvider: "deepgram", correctionProvider: "pyai", language: "fr", autoDetectLanguage: true },
      BOTH_KEYS,
    );
    expect(errs).toEqual([]); // no language error for a multilingual vendor under auto-detect
  });

  it("auto-detect on + PyAI STT STILL warns English-only (never silenced)", () => {
    const errs = capabilityErrors(
      { sttProvider: "pyai", correctionProvider: "pyai", language: "fr", autoDetectLanguage: true },
      PYAI_ONLY,
    );
    expect(errs.some((e) => /English-only/.test(e))).toBe(true); // warning preserved
    expect(errs.some((e) => /Auto-detect doesn't apply/.test(e))).toBe(true); // distinct note added
  });

  it("surfaces a clear message for an unknown vendor id", () => {
    const errs = capabilityErrors(
      { sttProvider: "nope" as never, correctionProvider: "pyai", language: "en" },
      PYAI_ONLY,
    );
    expect(errs.some((e) => /Unknown STT provider 'nope'/.test(e))).toBe(true);
  });
});

describe("assertCapability", () => {
  it("throws one message listing problems when unsatisfied", () => {
    expect(() => assertCapability(DEFAULT_SETTINGS, NO_ENV)).toThrow(/PYAI_API_KEY/);
  });

  it("does not throw when the combination is runnable", () => {
    expect(() => assertCapability(DEFAULT_SETTINGS, PYAI_ONLY)).not.toThrow();
  });
});
