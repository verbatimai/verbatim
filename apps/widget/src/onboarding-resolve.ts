// Verbatim — onboarding resolver: the single source of truth for "what did the
// user give us, what do we write, and what do we say". Screen 1 of onboarding
// asks for one API key; everything downstream of that paste (which provider ids
// land in settings.json, whether self-correction can be switched on, which
// second key is still missing, and every line of copy that explains it) is
// decided here rather than scattered through the render functions.
//
// This file has ZERO imports, deliberately. No @tauri-apps/*, no DOM types, no
// other repo module. That is what lets the whole resolution table be executed
// directly on a machine with no test runner (`node --experimental-strip-types`
// against a scratch driver), which is the only automated gate this logic has —
// vitest cannot run in the authoring environment. Keep it pure: no I/O, no
// globals, no side effects.
//
// Vendor capabilities mirror packages/core's registries (providers/registry.ts's
// STT_PROVIDERS and correction/registry.ts's PROVIDERS) and are duplicated here
// rather than imported, the same way settings.ts duplicates VENDOR_ENV from
// Rust — this app has no shared runtime between its Vite pages and core.

export type Vendor = "openai" | "pyai" | "deepgram" | "anthropic";
export type Role = "stt" | "correction";
export type Mode = "full" | "raw" | "needStt";

export type VendorInfo = {
  name: string;
  stt: boolean;
  correction: boolean;
  url: string;
  blurb: string;
};

export const VENDORS: Record<Vendor, VendorInfo> = {
  openai: {
    name: "OpenAI", stt: true, correction: true,
    url: "platform.openai.com", blurb: "Speech-to-text + cleanup",
  },
  pyai: {
    name: "PyAI", stt: true, correction: false,
    url: "pyai.com", blurb: "Speech-to-text (Verbatim default)",
  },
  deepgram: {
    name: "Deepgram", stt: true, correction: false,
    url: "console.deepgram.com", blurb: "Speech-to-text, 30+ languages",
  },
  anthropic: {
    name: "Anthropic", stt: false, correction: true,
    url: "console.anthropic.com", blurb: "Cleanup only — needs a speech key",
  },
};

/** Render order for the vendor picker and the "where to get a key" list. */
export const VENDOR_ORDER: Vendor[] = ["openai", "pyai", "deepgram", "anthropic"];

/** camelCase keys only — this object is handed straight to set_config, whose
    shallow merge silently drops any key that isn't a serde camelCase field. */
export type ConfigPatch = {
  sttProvider?: string;
  correctionProvider?: string;
  correct?: boolean;
  format?: boolean;
};

export type Resolution = {
  mode: Mode;
  headline: string;
  patch: ConfigPatch;
  sttVendor: Vendor | null;
  corrVendor: Vendor | null;
};

/**
 * Guess the vendor from a key's shape. This is only ever a *hint*: it is shown
 * as an editable chip the user can override, and key_verify is the real gate —
 * so a wrong guess costs a click, never a broken setup.
 *
 * Order matters: "sk-ant-" must be tested before "sk-", since Anthropic keys
 * also start with "sk-". The trailing length check is the catch-all for PyAI,
 * whose key prefix is not documented yet (onboarding-plan §9 #1).
 */
export function detect(key: string): Vendor | null {
  const s = key.trim();
  if (!s) return null;
  if (/^sk-ant-/i.test(s)) return "anthropic";
  if (/^sk-/i.test(s)) return "openai";
  if (/^[0-9a-f]{32,48}$/i.test(s)) return "deepgram";
  return s.length >= 8 ? "pyai" : null;
}

export function roleOk(v: Vendor, role: Role): boolean {
  return role === "stt" ? VENDORS[v].stt : VENDORS[v].correction;
}

/**
 * What a single key gets you, before any second key is considered. `chip` is the
 * short role note rendered next to the detected-vendor chip.
 */
export function resolveFirst(
  v: Vendor | null,
): { mode: Mode; headline: string; chip: string } | null {
  if (!v) return null;
  const d = VENDORS[v];
  if (d.stt && d.correction) {
    return { mode: "full", headline: "You're fully set up.", chip: "covers speech + cleanup" };
  }
  if (d.stt) {
    return {
      mode: "raw",
      headline: `${d.name} covers speech-to-text. Self-correction stays off until you add an OpenAI or Anthropic key.`,
      chip: "speech-to-text only",
    };
  }
  return {
    mode: "needStt",
    headline: `${d.name} does the cleanup. Verbatim also needs a speech-to-text key.`,
    chip: "cleanup only",
  };
}

/**
 * Whether Screen 1 needs a second key, and for which role. A key that covers
 * only speech gets an *optional* cleanup slot (dictation already works without
 * it); a key that covers only cleanup gets a *required* speech slot, because a
 * setup that cannot transcribe is not a setup.
 */
export function secondSlot(
  first: Vendor | null,
):
  | { need: "none" }
  | { need: "optional" | "required"; role: Role; label: string; okList: string } {
  if (!first) return { need: "none" };
  const d = VENDORS[first];
  if (d.stt && d.correction) return { need: "none" };
  if (d.stt) {
    return { need: "optional", role: "correction", label: "Cleanup key", okList: "OpenAI or Anthropic" };
  }
  return { need: "required", role: "stt", label: "Speech-to-text key", okList: "PyAI, Deepgram or OpenAI" };
}

/**
 * The full resolution: first key plus (where the slot is in use) the second one.
 *
 * A `second` value is ignored whenever the slot is not in use. That matters
 * because state can go stale in a way the user cannot see: paste a Deepgram key,
 * open the cleanup slot, paste an Anthropic key, then replace the first key with
 * an OpenAI one. The slot disappears but `second` is still set — and if the
 * resolver kept judging it, Continue would stay disabled with nothing on screen
 * to explain why. Every function here reads `second` through `usedSecond()`.
 */
function usedSecond(first: Vendor | null, second: Vendor | null): Vendor | null {
  if (!first) return null;
  return secondSlot(first).need === "none" ? null : second;
}

export function combo(first: Vendor | null, second: Vendor | null): Resolution | null {
  const r1 = resolveFirst(first);
  if (!first || !r1) return null;
  const s = usedSecond(first, second);

  if (r1.mode === "full") {
    return {
      mode: "full",
      headline: r1.headline,
      patch: { sttProvider: first, correctionProvider: first, correct: true, format: true },
      sttVendor: first,
      corrVendor: first,
    };
  }

  if (r1.mode === "raw") {
    if (s && roleOk(s, "correction")) {
      return {
        mode: "full",
        headline: "Fully set up — speech and cleanup both covered.",
        patch: { sttProvider: first, correctionProvider: s, correct: true, format: true },
        sttVendor: first,
        corrVendor: s,
      };
    }
    // correct/format are written as explicit `false`, never omitted: the stored
    // config may already have them on (from an earlier setup or a hand-edit),
    // and leaving them on with no correction key is what banners the overlay.
    // correctionProvider is left alone so the config default ("openai" —
    // valid but keyless, which server.ts handles silently) survives; writing an
    // id we have no key for would be a louder wrong answer than writing nothing.
    return {
      mode: "raw",
      headline: r1.headline,
      patch: { sttProvider: first, correct: false, format: false },
      sttVendor: first,
      corrVendor: null,
    };
  }

  if (s && roleOk(s, "stt")) {
    // Roles swap here: the *second* key is the speech key, the first is cleanup.
    return {
      mode: "full",
      headline: "Fully set up.",
      patch: { sttProvider: s, correctionProvider: first, correct: true, format: true },
      sttVendor: s,
      corrVendor: first,
    };
  }
  // needStt writes nothing and names no vendor to save. Continue is blocked in
  // this state, so nothing should reach a save path at all — reporting null for
  // both vendors makes a caller that tries anyway fail loudly instead of
  // half-configuring an install that cannot transcribe.
  return { mode: "needStt", headline: r1.headline, patch: {}, sttVendor: null, corrVendor: null };
}

/** The role complaint under the second field, or null when there is nothing to say. */
export function slotError(first: Vendor | null, second: Vendor | null): string | null {
  const slot = secondSlot(first);
  const s = usedSecond(first, second);
  if (slot.need === "none" || !s) return null;
  if (roleOk(s, slot.role)) return null;
  const asked = slot.role === "stt" ? "speech-to-text" : "cleanup";
  return `${VENDORS[s].name} can't do ${asked}. Use ${slot.okList}.`;
}

/**
 * Continue is blocked only for reasons the user can see on screen. A wrong-role
 * key blocks even in the *optional* slot: silently discarding a key someone just
 * pasted is worse than stopping to explain that it belongs elsewhere. An
 * optional slot left empty never blocks.
 */
export function continueBlocked(first: Vendor | null, second: Vendor | null): boolean {
  if (!first) return true;
  if (slotError(first, second) !== null) return true;
  const slot = secondSlot(first);
  const s = usedSecond(first, second);
  if (slot.need === "required") return !(s && roleOk(s, slot.role));
  return false;
}

/**
 * Repairs a stored correctionProvider that no registry can resolve — in
 * practice an install poisoned with "pyai" by the previous version of this
 * onboarding, which then reports "Correction 'pyai' is invalid" on every
 * dictation. Returns undefined for anything already valid, so a normal setup
 * writes nothing.
 */
export function sanitizeCorrection(current: string): string | undefined {
  return current === "openai" || current === "anthropic" ? undefined : "openai";
}
