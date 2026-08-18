// Settings window — Phase 4.7: real controls (typed keys, provider/model
// dropdowns, hotkey capture, language, permission status), reading/writing
// through the Rust config store + keychain (4.3). This window is an ordinary
// focusable NSWindow (unlike the overlay's non-key panel), so — unlike the old
// inline panel — it can accept typed input and real keydown-based hotkey capture.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  acceptSuggestion,
  dismissSuggestion,
  EMPTY_GLOSSARY,
  newGlossaryId,
  type GlossaryEntry,
  type UserGlossary,
} from "./glossary";
import {
  sttModels,
  sttLanguages,
  sttSupportsAutoDetect,
  sttIsBroad,
  correctionModels,
} from "./capabilities";

type AppConfig = {
  sttProvider: string;
  correctionProvider: string;
  sttModel: string;
  correctionModel: string;
  language: string;
  hotkey: string;
  dockIcon: boolean;
  muteOthers?: boolean;
  launchAtLogin?: boolean;
  debug?: boolean;
  theme?: string;
  keyStorage?: string; // hidden (§1.6) — no UI; kept for type-completeness
  correct?: boolean; // 2.2 — run self-correction on finalize (default true)
  format?: boolean; // 2.3 — run formatting on finalize (default true)
  formatMode?: "prose" | "message" | "code" | "raw"; // 5.3 — formatting mode (default "prose")
  pasteLastHotkey?: string; // 2.1 — global accelerator to paste last transcript ("" = unset)
  revertRawHotkey?: string; // 5.4 — global accelerator to re-inject the RAW transcript ("" = unset)
  micDeviceId?: string; // 3.1 — chosen input device deviceId ("" = system default)
  autoDetectLanguage?: boolean; // 3.2 — auto-detect spoken language (Deepgram/OpenAI)
  telemetry?: boolean; // 3.3 — anonymous, metadata-only telemetry (default off; transport parked)
  fnPushToTalk?: boolean; // Wave 4 — hold a bare key (Fn) to dictate
  pttKey?: string; // Wave 4 — "fn" | "right_cmd" | "right_opt"
  commandHotkey?: string; // P-series — global accelerator to start/stop command mode ("" = unset)
  commandProvider?: string; // P-series — command provider (no UI; type-completeness)
  commandModel?: string; // P-series — command model (no UI; type-completeness)
  systemCommands?: boolean; // P-series — gate for launch/volume/shortcut delegation
  wakeWordEnabled?: boolean; // P-series — always-listening on-device wake word
  wakeWordHandler?: string; // P-series — "dictate" | "command"
  wakeWordThreshold?: number; // P-series — detection threshold 0..1
  wakeWordGreeting?: boolean; // P3 — speak a hardcoded reply when the wake word fires (default true)
  ttsProvider?: string; // P3 — text-to-speech vendor for the wake-word greeting: "pyai" | "deepgram" (default "pyai")
  showTranscript?: boolean; // Widget redesign — live-transcript/correction-reveal bubble (default true)
  showRemoved?: boolean; // Widget redesign — fade (vs. instantly cut) removed spans during the reveal (default true)
  historyLimit?: number; // dictation history — how many recent entries to show: 10 | 20 | 50
  setupState?: string; // first-run onboarding re-entry state: "unseen" | "skipped" | "done"
};

// Mirrors packages/core's provider registries' `requiredKeys` and Rust's
// `vendor_key_name` — kept in sync manually, same as that Rust-side map (there's
// no shared runtime between this Vite app and @verbatim/core).
const VENDOR_ENV: Record<string, string> = {
  pyai: "PYAI_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};
const VENDOR_LABELS: Record<string, string> = {
  pyai: "PyAI",
  deepgram: "Deepgram",
  openai: "OpenAI",
  anthropic: "Anthropic",
};
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sttProviderEl = $<HTMLSelectElement>("sttProvider");
const correctionProviderEl = $<HTMLSelectElement>("correctionProvider");
const sttModelEl = $<HTMLSelectElement>("sttModel");
const correctionModelEl = $<HTMLSelectElement>("correctionModel");
const languageEl = $<HTMLSelectElement>("language");
const languageCustomEl = $<HTMLInputElement>("languageCustom");
const languageHintEl = $("languageHint");
const capabilityErrorsEl = $("capabilityErrors");
const vendorKeysEl = $("vendorKeys");
const dockIconEl = $<HTMLInputElement>("dockIcon");
const muteOthersEl = $<HTMLInputElement>("muteOthers");
const showTranscriptEl = $<HTMLInputElement>("showTranscript");
const showRemovedEl = $<HTMLInputElement>("showRemoved");
const launchAtLoginEl = $<HTMLInputElement>("launchAtLogin");
const debugEl = $<HTMLInputElement>("debugMode");
const resetBtnEl = $<HTMLButtonElement>("resetBtn");
const hotkeyCaptureEl = $<HTMLInputElement>("hotkeyCapture");
const hotkeyClearEl = $<HTMLButtonElement>("hotkeyClear");
const hotkeyPresetsEl = $("hotkeyPresets");
const selfCorrectEl = $<HTMLInputElement>("selfCorrect");
const formatToggleEl = $<HTMLInputElement>("formatToggle");
const formatModeEl = $<HTMLSelectElement>("formatMode");
const historyLimitEl = $<HTMLSelectElement>("historyLimit");
const pasteLastCaptureEl = $<HTMLInputElement>("pasteLastCapture");
const pasteLastClearEl = $<HTMLButtonElement>("pasteLastClear");
const revertRawCaptureEl = $<HTMLInputElement>("revertRawCapture");
const revertRawClearEl = $<HTMLButtonElement>("revertRawClear");
const micDeviceEl = $<HTMLSelectElement>("micDevice");
const micHintEl = $("micHint");
const autoDetectEl = $<HTMLInputElement>("autoDetect");
const autoDetectSwitchEl = () => autoDetectEl?.closest<HTMLElement>(".switch") ?? null;
const autoDetectHintEl = $("autoDetectHint");
const telemetryEl = $<HTMLInputElement>("telemetry");
const vocabListEl = $("glossaryList");
const vocabInputEl = $<HTMLInputElement>("glossaryTerm");
const vocabAddEl = $<HTMLButtonElement>("glossaryAdd");
const glossaryAliasesEl = $<HTMLInputElement>("glossaryAliases");
const suggestionBadgeEl = $<HTMLElement>("suggestionBadge");
const snipListEl = $("snipList");
const snipTriggerEl = $<HTMLInputElement>("snipTrigger");
const snipExpansionEl = $<HTMLInputElement>("snipExpansion");
const snipAddEl = $<HTMLButtonElement>("snipAdd");
const micStatusEl = $("micStatus");
const axStatusEl = $("axStatus");
const openMicEl = $<HTMLButtonElement>("openMic");
const openAxEl = $<HTMLButtonElement>("openAx");
const imStatusEl = $("imStatus");
const openImEl = $<HTMLButtonElement>("openIm");
const pttEnableEl = $<HTMLInputElement>("pttEnable");
const pttKeyEl = $<HTMLSelectElement>("pttKey");
const pttStatusEl = $("pttStatus");
const commandCaptureEl = $<HTMLInputElement>("commandCapture");
const commandClearEl = $<HTMLButtonElement>("commandClear");
const systemCommandsEl = $<HTMLInputElement>("systemCommands");
const wakeWordEnableEl = $<HTMLInputElement>("wakeWordEnable");
const wakeWordHandlerEl = $<HTMLSelectElement>("wakeWordHandler");
const wakeWordThresholdEl = $<HTMLInputElement>("wakeWordThreshold");
const wakeWordGreetingEl = $<HTMLInputElement>("wakeWordGreeting");
const ttsProviderEl = $<HTMLSelectElement>("ttsProvider");

let config: AppConfig = {
  sttProvider: "pyai",
  correctionProvider: "openai",
  sttModel: "",
  correctionModel: "",
  language: "en",
  hotkey: "alt-space",
  dockIcon: false,
};
const hasKey: Record<string, boolean> = { pyai: false, deepgram: false, openai: false, anthropic: false };

function isEnglish(language: string): boolean {
  const l = (language || "en").toLowerCase();
  return l === "en" || l.startsWith("en-") || l.startsWith("en_");
}

// Mirrors packages/core's registries (providers/registry.ts, correction/registry.ts) —
// kept in sync manually, same as VENDOR_ENV above. The internal `fixture`/`mock` ids are
// deliberately absent: they aren't user-selectable, so a stored config naming one is a
// fault to report, not a state to accept.
const STT_REGISTERED = new Set(["pyai", "deepgram", "openai"]);
const CORR_REGISTERED = new Set(["openai", "anthropic"]);

/** One role's problems. Asking `hasKey[id]` alone (as this did) conflates two failures
 * with a key check that answers neither:
 *   • an id NO registry resolves — core's `capabilityErrors` surfaces the registry's own
 *     throw, whereas here `correctionProvider: "pyai"` reported ZERO errors, because the
 *     PyAI *key* is saved even though nothing can run the correction pass with it;
 *   • a provider whose `requiredKeys` list is EMPTY — a shape core already supports
 *     (fixture.stt.ts) and both `assertKeys` variants pass — which would have read
 *     "needs undefined" here.
 * The "needs <ENV>" wording is unchanged, so nothing that passes today starts failing. */
function roleErrors(role: "STT" | "Correction", id: string, registered: Set<string>): string[] {
  if (!registered.has(id)) return [`${role} '${id}' isn't a provider Verbatim can use — pick another.`];
  const env = VENDOR_ENV[id];
  if (!env) return []; // zero-key provider: nothing can be missing, so the role is satisfied
  return hasKey[id] ? [] : [`${role} '${id}' needs ${env}.`];
}

/** Mirrors packages/core/src/settings.ts's `capabilityErrors` (can't be imported
 * into this standalone Vite app), using local `hasKey` in place of `process.env`. */
function capabilityErrors(): string[] {
  const errors: string[] = [
    ...roleErrors("STT", config.sttProvider, STT_REGISTERED),
    ...roleErrors("Correction", config.correctionProvider, CORR_REGISTERED),
  ];
  // 3.2 — auto-detect never silences the PyAI-English-only warning (PyAI ignores detect);
  // for non-PyAI vendors, auto-detect relaxes the fixed-language guard (mirrors core).
  if (config.sttProvider === "pyai" && !isEnglish(config.language)) {
    const note = config.autoDetectLanguage ? " (Auto-detect doesn't apply — PyAI Hear is English-only.)" : "";
    errors.push(`PyAI Hear is English-only — choose Deepgram or OpenAI as the STT vendor for language '${config.language}'.${note}`);
  }
  return errors;
}

function renderCapabilityErrors() {
  capabilityErrorsEl.innerHTML = "";
  for (const msg of capabilityErrors()) {
    const li = document.createElement("li");
    li.textContent = msg;
    capabilityErrorsEl.appendChild(li);
  }
}

async function patchConfig(patch: Partial<AppConfig>) {
  config = await invoke<AppConfig>("set_config", { patch });
  renderCapabilityErrors();
}

// ---- vendor keys (Keychain, via 4.3's set_key/has_key/delete_key) ----
// Two states per row:
//   • unset  → password field + Save
//   • locked → masked "•••• Saved" chip; a kebab (⋯) menu reveals Re-enter / Delete
// so the destructive/entry controls aren't shown inline until the user opens the menu.
function closeAllMenus() {
  document.querySelectorAll<HTMLElement>(".key-menu.open").forEach((m) => m.classList.remove("open"));
}
document.addEventListener("click", closeAllMenus);

function vendorRow(vendor: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "vendor-row";

  const render = () => {
    if (hasKey[vendor]) {
      row.innerHTML = `
        <div class="vendor-head"><span class="name">${VENDOR_LABELS[vendor]}</span><span class="status ok">Saved</span></div>
        <div class="row locked">
          <div class="locked-key"><svg viewBox="0 0 24 24" class="ico lock"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg><span>••••••••••••••••</span></div>
          <div class="key-menu">
            <button class="btn ghost kebab" data-kebab aria-label="Key options">⋯</button>
            <div class="menu-pop">
              <button data-reenter><svg viewBox="0 0 24 24" class="ico"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>Re-enter key</button>
              <button data-delete class="danger"><svg viewBox="0 0 24 24" class="ico"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>Delete key</button>
            </div>
          </div>
        </div>`;
      wireLocked();
    } else {
      row.innerHTML = `
        <div class="vendor-head"><span class="name">${VENDOR_LABELS[vendor]}</span><span class="status">not set</span></div>
        <div class="row">
          <input type="password" placeholder="${VENDOR_ENV[vendor]}" autocomplete="off" data-input />
          <button class="btn" data-save>Save</button>
        </div>`;
      wireUnset();
    }
  };

  const save = async (secret: string, statusEl?: HTMLElement) => {
    if (!secret) return;
    try {
      await invoke("set_key", { vendor, secret });
      hasKey[vendor] = true;
      render();
      renderCapabilityErrors();
    } catch (e) {
      if (statusEl) { statusEl.textContent = "save failed"; statusEl.classList.add("bad"); }
    }
  };

  function wireUnset() {
    const input = row.querySelector<HTMLInputElement>("[data-input]")!;
    const status = row.querySelector<HTMLElement>(".status")!;
    row.querySelector<HTMLButtonElement>("[data-save]")!.onclick = () => save(input.value.trim(), status);
    input.onkeydown = (e) => { if (e.key === "Enter") save(input.value.trim(), status); };
  }

  function wireLocked() {
    const menu = row.querySelector<HTMLElement>(".key-menu")!;
    row.querySelector<HTMLButtonElement>("[data-kebab]")!.onclick = (e) => {
      e.stopPropagation();
      const isOpen = menu.classList.contains("open");
      closeAllMenus();
      menu.classList.toggle("open", !isOpen);
    };
    row.querySelector<HTMLButtonElement>("[data-reenter]")!.onclick = () => {
      closeAllMenus();
      hasKey[vendor] = false; // drop to the entry state so a new key can be typed
      render();
      row.querySelector<HTMLInputElement>("[data-input]")?.focus();
    };
    row.querySelector<HTMLButtonElement>("[data-delete]")!.onclick = async () => {
      closeAllMenus();
      try {
        await invoke("delete_key", { vendor });
        hasKey[vendor] = false;
        render();
        renderCapabilityErrors();
      } catch {}
    };
  }

  render();
  return row;
}

async function initVendorKeys() {
  // Resolve key presence first so each row renders in its correct state once.
  await Promise.all(Object.keys(VENDOR_ENV).map(async (vendor) => {
    try { hasKey[vendor] = await invoke<boolean>("has_key", { vendor }); } catch { hasKey[vendor] = false; }
  }));
  vendorKeysEl.innerHTML = "";
  for (const vendor of Object.keys(VENDOR_ENV)) vendorKeysEl.appendChild(vendorRow(vendor));
  renderCapabilityErrors();
}

// ---- providers, models, language (capability-driven, Phase 8) ----
// The Dictation controls interlock via `capabilities.ts`:
//   1. Language options follow the selected STT provider/model.
//   2. Auto-detect is enabled only when the provider/model supports it (forced
//      off + greyed for PyAI).
//   3. When auto-detect is supported AND on, the language select is greyed (auto).
function fillSelect(sel: HTMLSelectElement, opts: { value: string; label: string }[], value: string) {
  sel.innerHTML = "";
  for (const o of opts) {
    const el = document.createElement("option");
    el.value = o.value;
    el.textContent = o.label;
    sel.appendChild(el);
  }
  sel.value = value;
}

// A stored provider id that isn't one of the <option>s (e.g. the `correctionProvider:
// "pyai"` older onboarding wrote) leaves `selectedIndex === -1`, i.e. a silently BLANK
// select that disagrees with the config — the user sees no vendor and no reason why.
// Surface it instead: a disabled option named after the id, selected, so the bad value
// is visible and can only be replaced by a real one. capabilityErrors() explains it.
// Idempotent, because initProviderControls() re-runs on every config-changed: the stale
// placeholder is dropped first, so an id that has since become valid loses the marker.
function selectProvider(sel: HTMLSelectElement, id: string) {
  sel.querySelectorAll("option[data-unavailable]").forEach((o) => o.remove());
  sel.value = id;
  if (!id || sel.selectedIndex !== -1) return; // an empty id is "unset", not "unavailable"
  const opt = document.createElement("option");
  opt.value = id;
  opt.textContent = `${id} (unavailable)`;
  opt.disabled = true;
  opt.dataset.unavailable = "1";
  sel.appendChild(opt);
  sel.value = id;
}

function initProviderControls() {
  selectProvider(sttProviderEl, config.sttProvider);
  selectProvider(correctionProviderEl, config.correctionProvider);

  sttProviderEl.onchange = async () => {
    await patchConfig({ sttProvider: sttProviderEl.value });
    await refreshSttCapabilities();
  };
  sttModelEl.onchange = async () => {
    await patchConfig({ sttModel: sttModelEl.value });
    await refreshSttCapabilities();
  };
  correctionProviderEl.onchange = async () => {
    await patchConfig({ correctionProvider: correctionProviderEl.value });
    refreshCorrectionModels();
  };
  correctionModelEl.onchange = async () => {
    await patchConfig({ correctionModel: correctionModelEl.value });
  };

  languageEl.onchange = async () => {
    if (languageEl.value === "other") {
      languageCustomEl.style.display = "block";
      languageCustomEl.focus();
      return; // wait for a real tag before persisting
    }
    languageCustomEl.style.display = "none";
    await patchConfig({ language: languageEl.value });
    updateLanguageHint();
  };
  languageCustomEl.onblur = async () => {
    const tag = languageCustomEl.value.trim();
    if (!tag) return;
    await patchConfig({ language: tag });
    updateLanguageHint();
  };

  void refreshSttCapabilities();
  refreshCorrectionModels();
}

// Repopulate the STT model + language selects and reconcile auto-detect whenever
// the STT provider or model changes. Persists any values it has to coerce (a
// model/language the new provider doesn't offer) through patchConfig — convergent,
// so the config-changed echo settles without looping.
async function refreshSttCapabilities() {
  const provider = config.sttProvider;

  // --- STT model select (disabled when the provider has a single fixed model) ---
  const models = sttModels(provider);
  const ids = models.map((m) => m.id);
  const model = ids.includes(config.sttModel) ? config.sttModel : ids[0] ?? "";
  fillSelect(sttModelEl, models.map((m) => ({ value: m.id, label: m.label })), model);
  sttModelEl.disabled = models.length <= 1;
  if (model !== config.sttModel) {
    await patchConfig({ sttModel: model });
  }

  // --- Language select (only languages this provider/model offers) ---
  const langs = sttLanguages(provider, model);
  const codes = langs.map((l) => l.code);
  const broad = sttIsBroad(provider);
  const opts = langs.map((l) => ({ value: l.code, label: `${l.name} (${l.code})` }));
  if (broad) opts.push({ value: "other", label: "Other… (custom BCP-47)" });

  let lang = config.language;
  let useCustom = false;
  if (codes.includes(lang)) {
    // offered as-is
  } else if (broad) {
    useCustom = true; // a custom BCP-47 tag on a broad provider — keep it
  } else {
    lang = codes[0] ?? "en"; // not offered here — coerce to the first supported
  }
  fillSelect(languageEl, opts, useCustom ? "other" : lang);
  languageCustomEl.style.display = useCustom ? "block" : "none";
  if (useCustom) languageCustomEl.value = lang;
  if (!useCustom && lang !== config.language) {
    await patchConfig({ language: lang });
  }

  // --- Auto-detect: enabled only when supported; forced off otherwise ---
  const canAuto = sttSupportsAutoDetect(provider, model);
  if (autoDetectEl) {
    autoDetectEl.disabled = !canAuto;
    autoDetectSwitchEl()?.classList.toggle("disabled", !canAuto);
    if (!canAuto) {
      autoDetectEl.checked = false;
      if (config.autoDetectLanguage) await patchConfig({ autoDetectLanguage: false });
    } else {
      autoDetectEl.checked = !!config.autoDetectLanguage;
    }
    if (autoDetectHintEl) {
      autoDetectHintEl.textContent = canAuto
        ? ""
        : "PyAI Hear is English-only — switch STT to Deepgram or OpenAI to auto-detect.";
    }
  }

  // --- Rule 3: grey the language selector while auto-detect is on ---
  const autoOn = canAuto && !!config.autoDetectLanguage;
  languageEl.disabled = autoOn;
  languageCustomEl.disabled = autoOn;
  updateLanguageHint();
}

// Repopulate the correction model select from the selected correction provider
// (disabled for PyAI, whose model is fixed / server-ignored).
function refreshCorrectionModels() {
  const provider = config.correctionProvider;
  const models = correctionModels(provider);
  const ids = models.map((m) => m.id);
  const model = ids.includes(config.correctionModel) ? config.correctionModel : ids[0] ?? "";
  fillSelect(correctionModelEl, models.map((m) => ({ value: m.id, label: m.label })), model);
  correctionModelEl.disabled = models.length <= 1;
  if (model !== config.correctionModel) {
    void patchConfig({ correctionModel: model });
  }
}

function updateLanguageHint() {
  if (config.sttProvider !== "pyai" && config.autoDetectLanguage) {
    languageHintEl.textContent = "Auto-detect is on — the spoken language is chosen automatically.";
    return;
  }
  languageHintEl.textContent = isEnglish(config.language)
    ? ""
    : "Non-English: PyAI Hear can't transcribe this — pick Deepgram or OpenAI as the STT provider above.";
}

// ---- hotkey: click-to-record (this window IS focusable, unlike the overlay) ----
const PRESET_LABELS: Record<string, string> = {
  "alt-space": "⌥Space", "ctrl-space": "⌃Space", "cmd-shift-d": "⌘⇧D",
  "ctrl-alt-d": "⌃⌥D", "alt-grave": "⌥`",
};
const MODIFIER_CODES = new Set([
  "AltLeft", "AltRight", "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight",
]);

function describeHotkey(id: string): string {
  if (PRESET_LABELS[id]) return PRESET_LABELS[id];
  // A captured accelerator, e.g. "Alt+Shift+KeyD" -> "⌥⇧D".
  const parts = id.split("+");
  const code = parts.pop() ?? "";
  const glyphs: Record<string, string> = { Alt: "⌥", Control: "⌃", Shift: "⇧", Meta: "⌘", Super: "⌘", Cmd: "⌘" };
  const mods = parts.map((p) => glyphs[p] ?? p).join("");
  const key = code.startsWith("Key") ? code.slice(3) : code.startsWith("Digit") ? code.slice(5) : code;
  return mods + key;
}

function refreshHotkeyUI() {
  hotkeyCaptureEl.value = describeHotkey(config.hotkey);
  hotkeyPresetsEl.querySelectorAll<HTMLButtonElement>("button").forEach((b) =>
    b.classList.toggle("active", b.dataset.hk === config.hotkey));
}

// Reusable click-to-record hotkey capture. Each instance owns its own recording flag +
// keydown listener, so the toggle and paste-last inputs never clash. `onAccel` receives a
// captured accelerator (e.g. "Alt+Shift+KeyD") on a valid combo; the caller persists it and
// refreshes its own display. `onCancel` re-renders the input when capture is aborted (Esc).
function makeHotkeyCapture(
  inputEl: HTMLInputElement,
  onAccel: (accel: string) => void | Promise<void>,
  onCancel: () => void,
) {
  if (!inputEl) return;
  let rec = false;
  const cancel = () => {
    rec = false;
    inputEl.classList.remove("recording");
    window.removeEventListener("keydown", onKeydown, true);
  };
  async function onKeydown(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === "Escape") { cancel(); onCancel(); return; }
    if (MODIFIER_CODES.has(e.code)) return; // wait for the real key
    const mods: string[] = [];
    if (e.altKey) mods.push("Alt");
    if (e.ctrlKey) mods.push("Control");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Meta");
    if (!mods.length) {
      inputEl.value = "Add a modifier (⌥/⌃/⌘/⇧) + a key…";
      return; // keep listening — a bare key isn't a safe global shortcut
    }
    const accel = [...mods, e.code].join("+");
    cancel();
    await onAccel(accel);
  }
  inputEl.onclick = () => {
    if (rec) return;
    rec = true;
    inputEl.classList.add("recording");
    inputEl.value = "Press a key combo… (Esc to cancel)";
    window.addEventListener("keydown", onKeydown, true);
  };
}

// ---- toggle hotkey capture (re-expressed through the factory) ----
makeHotkeyCapture(hotkeyCaptureEl, async (accel) => {
  try {
    await invoke("set_toggle_hotkey", { id: accel });
    config = { ...config, hotkey: accel };
  } catch (err) {
    hotkeyCaptureEl.value = "Unsupported key — try another";
    setTimeout(refreshHotkeyUI, 1400);
    return;
  }
  refreshHotkeyUI();
}, refreshHotkeyUI);

// ---- paste last transcript hotkey (2.1) — a second capture row; persisted as
// config.pasteLastHotkey (Rust registers a global accelerator that re-injects the last
// finalized transcript). "" = unset. A soft collision guard rejects the dictation toggle
// and the reserved ⌥⇧V paste-test combo. ----
const TEST_PASTE_ACCEL = "Alt+Shift+KeyV"; // reserved demo/paste-test hotkey (main.rs)
const PRESET_ACCEL: Record<string, string> = {
  "alt-space": "Alt+Space",
  "ctrl-space": "Control+Space",
  "cmd-shift-d": "Meta+Shift+KeyD",
  "ctrl-alt-d": "Control+Alt+KeyD",
  "alt-grave": "Alt+Backquote",
};
// Canonical "MOD+…+CODE" (mods normalized + sorted) from a preset id OR a captured accel,
// so collisions compare regardless of modifier order / preset-vs-accel form.
function canonHotkey(id: string): string {
  if (!id) return "";
  const accel = PRESET_ACCEL[id] ?? id;
  const parts = accel.split("+").map((p) => p.trim()).filter(Boolean);
  const code = parts.pop() ?? "";
  const mods = parts.map((m) => (m === "Super" || m === "Cmd" ? "Meta" : m)).sort();
  return [...mods, code].join("+");
}
function pasteLastCollision(accel: string): string | null {
  const c = canonHotkey(accel);
  if (c && c === canonHotkey(config.hotkey)) return "That's your dictation toggle — pick another.";
  if (c && c === canonHotkey(TEST_PASTE_ACCEL)) return "⌥⇧V is reserved — pick another.";
  if (c && config.commandHotkey && c === canonHotkey(config.commandHotkey)) return "That's your command mode hotkey — pick another.";
  return null;
}
// P-series — the command-mode capture's guard: like pasteLastCollision but keyed off the
// OTHER combos (toggle, reserved paste-test, paste-last, revert-raw) so the command hotkey
// can't duplicate any of them. Excludes config.commandHotkey itself so re-picking the same
// combo isn't reported as a self-collision.
function commandCollision(accel: string): string | null {
  const c = canonHotkey(accel);
  if (c && c === canonHotkey(config.hotkey)) return "That's your dictation toggle — pick another.";
  if (c && c === canonHotkey(TEST_PASTE_ACCEL)) return "⌥⇧V is reserved — pick another.";
  if (c && config.pasteLastHotkey && c === canonHotkey(config.pasteLastHotkey)) return "That's your paste-last hotkey — pick another.";
  if (c && config.revertRawHotkey && c === canonHotkey(config.revertRawHotkey)) return "That's your revert-to-raw hotkey — pick another.";
  return null;
}
function refreshPasteLastUI() {
  if (!pasteLastCaptureEl) return;
  const hk = config.pasteLastHotkey;
  pasteLastCaptureEl.value = hk ? describeHotkey(hk) : "Click, then press a combo";
}
makeHotkeyCapture(pasteLastCaptureEl, async (accel) => {
  const conflict = pasteLastCollision(accel);
  if (conflict) {
    pasteLastCaptureEl.value = conflict;
    setTimeout(refreshPasteLastUI, 1600);
    return;
  }
  await patchConfig({ pasteLastHotkey: accel });
  refreshPasteLastUI();
}, refreshPasteLastUI);
if (pasteLastClearEl) {
  pasteLastClearEl.onclick = async () => {
    await patchConfig({ pasteLastHotkey: "" });
    refreshPasteLastUI();
  };
}

// 5.4 — revert-to-raw accelerator (re-inject the RAW/uncorrected transcript). Mirrors
// paste-last: same collision guard, "" = unset. Rust registers the global shortcut.
function refreshRevertRawUI() {
  if (!revertRawCaptureEl) return;
  const hk = config.revertRawHotkey;
  revertRawCaptureEl.value = hk ? describeHotkey(hk) : "Click, then press a combo";
}
if (revertRawCaptureEl) {
  makeHotkeyCapture(revertRawCaptureEl, async (accel) => {
    const conflict = pasteLastCollision(accel);
    if (conflict) { revertRawCaptureEl.value = conflict; setTimeout(refreshRevertRawUI, 1600); return; }
    await patchConfig({ revertRawHotkey: accel });
    refreshRevertRawUI();
  }, refreshRevertRawUI);
}
if (revertRawClearEl) {
  revertRawClearEl.onclick = async () => {
    await patchConfig({ revertRawHotkey: "" });
    refreshRevertRawUI();
  };
}

// P-series — command-mode accelerator (start/stop voice command mode; edits + system
// commands). Mirrors paste-last/revert-raw: click-to-record, "" = unset, its own collision
// guard (commandCollision) so it can't duplicate the toggle/paste-last/revert-raw. Rust
// registers the global shortcut.
function refreshCommandUI() {
  if (!commandCaptureEl) return;
  commandCaptureEl.value = config.commandHotkey ? describeHotkey(config.commandHotkey) : "Click, then press a combo";
}
if (commandCaptureEl) {
  makeHotkeyCapture(commandCaptureEl, async (accel) => {
    const conflict = commandCollision(accel);
    if (conflict) { commandCaptureEl.value = conflict; setTimeout(refreshCommandUI, 1600); return; }
    await patchConfig({ commandHotkey: accel });
    refreshCommandUI();
  }, refreshCommandUI);
}
if (commandClearEl) {
  commandClearEl.onclick = async () => {
    await patchConfig({ commandHotkey: "" });
    refreshCommandUI();
  };
}
hotkeyClearEl.onclick = async () => {
  try {
    await invoke("set_toggle_hotkey", { id: "alt-space" });
    config = { ...config, hotkey: "alt-space" };
    refreshHotkeyUI();
  } catch {}
};
hotkeyPresetsEl.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-hk]");
  if (!btn?.dataset.hk) return;
  try {
    await invoke("set_toggle_hotkey", { id: btn.dataset.hk });
    config = { ...config, hotkey: btn.dataset.hk };
  } catch {}
  refreshHotkeyUI();
});

// ---- permission status ----
async function refreshMicStatus() {
  try {
    const perm = await (navigator as any).permissions?.query?.({ name: "microphone" as PermissionName });
    if (perm) {
      const map: Record<string, string> = { granted: "✓ Granted", denied: "Denied — dictation needs mic access", prompt: "Not yet requested" };
      micStatusEl.textContent = map[perm.state] ?? perm.state;
      micStatusEl.classList.toggle("ok", perm.state === "granted");
      micStatusEl.classList.toggle("bad", perm.state === "denied");
      return;
    }
  } catch {}
  micStatusEl.textContent = "Unknown — grant access when prompted";
}

async function refreshAxStatus() {
  try {
    const ok = await invoke<boolean>("ax_trusted");
    axStatusEl.textContent = ok ? "✓ Granted — text can be inserted into other apps" : "Not granted — text will be copied to the clipboard";
    axStatusEl.classList.toggle("ok", ok);
    axStatusEl.classList.toggle("bad", !ok);
  } catch (e) {
    axStatusEl.textContent = "Couldn't check: " + String(e);
  }
}
// Wave 4 — Input Monitoring status (mirrors refreshAxStatus). Powers the Permissions row.
async function refreshImStatus() {
  if (!imStatusEl) return;
  try {
    const ok = await invoke<boolean>("input_monitoring_trusted");
    imStatusEl.textContent = ok
      ? "✓ Granted — push-to-talk can watch the key"
      : "Not granted — push-to-talk is disabled until you allow it (then relaunch)";
    imStatusEl.classList.toggle("ok", ok);
    imStatusEl.classList.toggle("bad", !ok);
  } catch (e) {
    imStatusEl.textContent = "Couldn't check: " + String(e);
  }
}
openMicEl.onclick = () => { void invoke("open_mic_settings").catch(() => {}); setTimeout(() => void refreshMicStatus(), 1200); };
openAxEl.onclick = () => { void invoke("open_accessibility_settings").catch(() => {}); setTimeout(() => void refreshAxStatus(), 1200); };
if (openImEl) openImEl.onclick = () => { void invoke("open_input_monitoring_settings").catch(() => {}); setTimeout(() => void refreshImStatus(), 1200); };

// ---- nav: sidebar sections ↔ content panes ----
function initNav() {
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"));
  const panes = Array.from(document.querySelectorAll<HTMLElement>(".pane"));
  const show = (id: string) => {
    items.forEach((b) => b.classList.toggle("active", b.dataset.pane === id));
    panes.forEach((p) => p.classList.toggle("active", p.dataset.pane === id));
    document.querySelector(".content")?.scrollTo({ top: 0 });
  };
  items.forEach((b) => (b.onclick = () => b.dataset.pane && show(b.dataset.pane)));
  show("preferences"); // consolidated home for dictation + correction

  // Sidebar search filters nav items by label.
  const search = $<HTMLInputElement>("navSearch");
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    items.forEach((b) => {
      const label = b.textContent?.toLowerCase() ?? "";
      b.classList.toggle("hidden", q.length > 0 && !label.includes(q));
    });
  };
}

// ---- theme: light / dark / system — config is the source of truth; localStorage is a
// synchronous fast-path so the window doesn't flash the wrong theme before get_config. ----
const THEME_ORDER = ["system", "light", "dark"] as const;
type Theme = (typeof THEME_ORDER)[number];
function applyThemeUI(t: Theme) {
  document.body.dataset.theme = t;
  const labelEl = document.getElementById("themeLabel");
  if (labelEl) labelEl.textContent = t[0].toUpperCase() + t.slice(1);
  document.querySelectorAll<HTMLButtonElement>("[data-theme-opt]")
    .forEach((b) => b.classList.toggle("active", b.dataset.themeOpt === t));
  try { localStorage.setItem("verbatim.theme", t); } catch {}
}
function cachedTheme(): Theme {
  try { return (localStorage.getItem("verbatim.theme") as Theme) || "system"; } catch { return "system"; }
}
function currentTheme(): Theme {
  const t = (config.theme as Theme) || cachedTheme();
  return (THEME_ORDER as readonly string[]).includes(t) ? t : "system";
}
function initTheme() {
  applyThemeUI(currentTheme());
  const set = (t: Theme) => { applyThemeUI(t); void patchConfig({ theme: t }); };
  const toggle = document.getElementById("themeToggle") as HTMLButtonElement | null;
  if (toggle) toggle.onclick = () => {
    const cur = currentTheme();
    set(THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length]);
  };
  document.querySelectorAll<HTMLButtonElement>("[data-theme-opt]")
    .forEach((b) => (b.onclick = () => b.dataset.themeOpt && set(b.dataset.themeOpt as Theme)));
}

// ---- dock icon toggle (real config field) ----
function initDockIcon() {
  if (!dockIconEl) return;
  dockIconEl.checked = !!config.dockIcon;
  dockIconEl.onchange = async () => { await patchConfig({ dockIcon: dockIconEl.checked }); };
}

// ---- mute-others toggle (1.1) — Rust field/behaviour already exist; this is the UI ----
function initMuteOthers() {
  if (!muteOthersEl) return;
  muteOthersEl.checked = !!config.muteOthers;
  muteOthersEl.onchange = () => { void patchConfig({ muteOthers: muteOthersEl.checked }); };
}

// ---- Widget redesign — live-transcript bubble + removed-span fade. Rust field/behaviour
// already exist (config.rs); this is the UI. Mirrors initMuteOthers(). ----
function initShowTranscript() {
  if (!showTranscriptEl) return;
  showTranscriptEl.checked = config.showTranscript !== false;
  showTranscriptEl.onchange = () => { void patchConfig({ showTranscript: showTranscriptEl.checked }); };
}
function initShowRemoved() {
  if (!showRemovedEl) return;
  showRemovedEl.checked = config.showRemoved !== false;
  showRemovedEl.onchange = () => { void patchConfig({ showRemoved: showRemovedEl.checked }); };
}

// ---- P-series — allow system commands gate (launch/volume/shortcut delegation). Rust
// field/behaviour already exist; this is the UI. Mirrors initMuteOthers(). ----
function initSystemCommands() {
  if (!systemCommandsEl) return;
  systemCommandsEl.checked = !!config.systemCommands;
  systemCommandsEl.onchange = () => { void patchConfig({ systemCommands: systemCommandsEl.checked }); };
}

// ---- P-series — wake word (beta): always-listening, on-device. Persists enable +
// handler ("dictate"|"command") + detection threshold (0..1). Rust field/behaviour exist. ----
function initWakeWord() {
  if (!wakeWordEnableEl || !wakeWordHandlerEl || !wakeWordThresholdEl) return;
  wakeWordEnableEl.checked = !!config.wakeWordEnabled;
  wakeWordHandlerEl.value = config.wakeWordHandler ?? "dictate";
  wakeWordThresholdEl.value = String(config.wakeWordThreshold ?? 0.3);
  wakeWordEnableEl.onchange = () => { void patchConfig({ wakeWordEnabled: wakeWordEnableEl.checked }); };
  wakeWordHandlerEl.onchange = () => { void patchConfig({ wakeWordHandler: wakeWordHandlerEl.value }); };
  wakeWordThresholdEl.onchange = () => { void patchConfig({ wakeWordThreshold: Number(wakeWordThresholdEl.value) }); };
  // P3 — spoken greeting on wake ("Hello Mayank, how can I help you?", hardcoded for now)
  // + which TTS vendor synthesizes it. Mirrors the three controls above.
  if (wakeWordGreetingEl) {
    wakeWordGreetingEl.checked = config.wakeWordGreeting !== false; // default on
    wakeWordGreetingEl.onchange = () => { void patchConfig({ wakeWordGreeting: wakeWordGreetingEl.checked }); };
  }
  if (ttsProviderEl) {
    ttsProviderEl.value = config.ttsProvider ?? "pyai";
    ttsProviderEl.onchange = () => { void patchConfig({ ttsProvider: ttsProviderEl.value }); };
  }
}

// ---- launch at login (1.2) — Rust syncs the macOS login item as a set_config side-effect ----
function initLaunchAtLogin() {
  if (!launchAtLoginEl) return;
  launchAtLoginEl.checked = !!config.launchAtLogin;
  launchAtLoginEl.onchange = async () => { await patchConfig({ launchAtLogin: launchAtLoginEl.checked }); };
}

// ---- debug mode (1.4) — Rust restarts the sidecar with HEAR_DEBUG when this flips ----
function initDebug() {
  if (!debugEl) return;
  debugEl.checked = !!config.debug;
  debugEl.onchange = async () => { await patchConfig({ debug: debugEl.checked }); };
}

// ---- self-correction toggle (2.2) — travels on the WS start frame; backend skips the
// correction pass when off (raw STT-only final, no diff). Default on. ----
function initSelfCorrect() {
  if (!selfCorrectEl) return;
  selfCorrectEl.checked = config.correct !== false; // default on
  selfCorrectEl.onchange = () => void patchConfig({ correct: selfCorrectEl.checked });
}

// ---- formatting toggle (2.3) — travels on the WS start frame; backend skips BOTH the LLM
// formatter and the localFormat fallback when off. Default on. ----
function initFormat() {
  if (!formatToggleEl) return;
  formatToggleEl.checked = config.format !== false; // default on
  formatToggleEl.onchange = () => void patchConfig({ format: formatToggleEl.checked });
}

// ---- 5.3 formatting mode — prose | message | code | raw. Travels on the WS start frame;
// "raw" makes the backend skip the format pass (cleanup only). Default "prose". ----
function initFormatMode() {
  if (!formatModeEl) return;
  formatModeEl.value = config.formatMode ?? "prose";
  formatModeEl.onchange = () => void patchConfig({ formatMode: formatModeEl.value as AppConfig["formatMode"] });
}

// ---- dictation history — how many recent entries the History tab shows (10/20/50, default
// 20). Storage always keeps up to 50 regardless of this setting (see history.rs) — lowering
// it here only narrows what's displayed, never deletes older entries. ----
function initHistoryLimit() {
  if (!historyLimitEl) return;
  historyLimitEl.value = String(config.historyLimit ?? 20);
  historyLimitEl.onchange = () => void patchConfig({ historyLimit: Number(historyLimitEl.value) });
}

// ---- 3.1 microphone device picker — enumerate audioinput devices, persist micDeviceId
// ("" = system default). enumerateDevices() returns BLANK labels until getUserMedia has
// been granted once, so we show fallback names + a hint in that state. Enumerate ONCE
// (avoid flicker on every config-changed); syncSelection() just re-selects the saved id. ----
let micEnumerated = false;
async function initMicDevice() {
  if (!micDeviceEl) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    let anyBlank = false;
    micDeviceEl.innerHTML = "";
    const sysOpt = document.createElement("option");
    sysOpt.value = "";
    sysOpt.textContent = "System Default";
    micDeviceEl.appendChild(sysOpt);
    inputs.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      if (!d.label) anyBlank = true;
      opt.textContent = d.label || `Microphone ${i + 1}`;
      micDeviceEl.appendChild(opt);
    });
    if (micHintEl) {
      micHintEl.textContent = anyBlank
        ? "Grant microphone access (and reopen Settings) to see device names."
        : "";
    }
    micEnumerated = true;
    syncMicSelection();
  } catch {
    if (micHintEl) micHintEl.textContent = "Couldn't list input devices.";
  }
  micDeviceEl.onchange = () => void patchConfig({ micDeviceId: micDeviceEl.value });
  // Refresh the list on hot-plug (labels may also fill in after a permission grant).
  try { navigator.mediaDevices.ondevicechange = () => { micEnumerated = false; void initMicDevice(); }; } catch {}
}
// Re-select the saved device without re-enumerating (a missing id silently falls back
// to "" / System Default, matching the `ideal` capture constraint in main.ts).
function syncMicSelection() {
  if (!micDeviceEl) return;
  micDeviceEl.value = config.micDeviceId ?? "";
}

// ---- 3.2 auto-detect language — travels on the WS start frame. Enable/disable and
// forced-off state are driven by capabilities in refreshSttCapabilities(); toggling it
// re-runs that to grey the language selector (rule 3). ----
function initAutoDetect() {
  if (!autoDetectEl) return;
  autoDetectEl.checked = !!config.autoDetectLanguage;
  autoDetectEl.onchange = async () => {
    await patchConfig({ autoDetectLanguage: autoDetectEl.checked });
    await refreshSttCapabilities();
  };
}

// ---- 3.3 anonymous telemetry — default OFF. Metadata only; transport is PARKED (NoopSink),
// so an ON toggle persists the preference but sends nothing yet. Copy stays honest. ----
function initTelemetry() {
  if (!telemetryEl) return;
  telemetryEl.checked = !!config.telemetry;
  telemetryEl.onchange = () => void patchConfig({ telemetry: telemetryEl.checked });
}

// ---- Wave 4 push-to-talk — enable toggle + bare-key picker. Rust starts/stops the
// listen-only CGEventTap as a set_config side-effect; this only persists the two fields
// and prompts for Input Monitoring the first time PTT is turned on. ----
async function initPtt() {
  if (!pttEnableEl || !pttKeyEl) return;
  pttEnableEl.checked = !!config.fnPushToTalk;
  pttKeyEl.value = config.pttKey ?? "fn";
  pttKeyEl.disabled = !pttEnableEl.checked;
  pttEnableEl.onchange = async () => {
    // Prompt for Input Monitoring the first time PTT is turned on (proactive TCC dialog).
    if (pttEnableEl.checked) { try { await invoke("request_input_monitoring"); } catch {} }
    await patchConfig({ fnPushToTalk: pttEnableEl.checked });
    pttKeyEl.disabled = !pttEnableEl.checked;
    await refreshImStatus();
    await refreshPttStatus();
  };
  pttKeyEl.onchange = async () => { await patchConfig({ pttKey: pttKeyEl.value }); };
  await refreshPttStatus();
}

async function refreshPttStatus() {
  if (!pttStatusEl) return;
  const granted = await invoke<boolean>("input_monitoring_trusted").catch(() => false);
  if (config.fnPushToTalk && !granted)
    pttStatusEl.textContent = "Grant Input Monitoring in Permissions, then quit & relaunch.";
  else pttStatusEl.textContent = "";
}

// ---- 3.4 Names & Jargon — glossary.json via glossary_get / glossary_save. Entries carry
// written form + heard-as aliases; suggested entries come from auto-learn in the overlay. ----
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function loadGlossary(): Promise<UserGlossary> {
  try {
    return await invoke<UserGlossary>("glossary_get");
  } catch {
    return EMPTY_GLOSSARY;
  }
}

async function saveGlossary(glossary: UserGlossary) {
  await invoke("glossary_save", { glossary });
}

async function initVocabulary() {
  if (!vocabListEl) return;
  const render = async () => {
    const glossary = await loadGlossary();
    const suggestions = glossary.entries.filter((e) => e.source === "suggested");
    if (suggestionBadgeEl) {
      if (suggestions.length) {
        suggestionBadgeEl.hidden = false;
        suggestionBadgeEl.textContent = `${suggestions.length} suggested`;
      } else {
        suggestionBadgeEl.hidden = true;
      }
    }
    vocabListEl.innerHTML = "";
    if (!glossary.entries.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "No terms yet — add names and jargon below, or accept suggestions after dictation.";
      vocabListEl.appendChild(empty);
      return;
    }
    for (const entry of glossary.entries) {
      const row = document.createElement("div");
      row.className = "list-row glossary-row";
      const label = document.createElement("div");
      label.className = "glossary-entry";
      const aliases = (entry.aliases ?? []).join(", ");
      const meta = aliases
        ? `heard as: ${aliases}`
        : entry.source === "suggested"
          ? "suggested from your edit"
          : entry.source === "learned"
            ? "learned"
            : "";
      label.innerHTML = `<span class="list-term">${esc(entry.term)}</span>${meta ? `<span class="glossary-meta">${esc(meta)}</span>` : ""}`;
      const actions = document.createElement("div");
      actions.className = "glossary-actions";
      if (entry.source === "suggested") {
        const accept = document.createElement("button");
        accept.className = "btn primary";
        accept.textContent = "Accept";
        accept.onclick = async () => { await saveGlossary(acceptSuggestion(glossary, entry.id)); await render(); };
        const dismiss = document.createElement("button");
        dismiss.className = "btn ghost";
        dismiss.textContent = "Dismiss";
        dismiss.onclick = async () => { await saveGlossary(dismissSuggestion(glossary, entry.id)); await render(); };
        actions.append(accept, dismiss);
      } else {
        const del = document.createElement("button");
        del.className = "btn ghost";
        del.textContent = "Delete";
        del.onclick = async () => {
          await saveGlossary({ ...glossary, entries: glossary.entries.filter((e) => e.id !== entry.id) });
          await render();
        };
        actions.append(del);
      }
      row.append(label, actions);
      vocabListEl.appendChild(row);
    }
  };
  const add = async () => {
    const term = vocabInputEl?.value.trim() ?? "";
    if (!term) return;
    const aliases = (glossaryAliasesEl?.value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const glossary = await loadGlossary();
    const entry: GlossaryEntry = {
      id: newGlossaryId(),
      term,
      aliases: aliases.length ? aliases : undefined,
      source: "manual",
      createdAt: Date.now(),
    };
    await saveGlossary({ ...glossary, entries: [...glossary.entries, entry] });
    if (vocabInputEl) vocabInputEl.value = "";
    if (glossaryAliasesEl) glossaryAliasesEl.value = "";
    await render();
  };
  if (vocabAddEl) vocabAddEl.onclick = add;
  if (vocabInputEl) vocabInputEl.onkeydown = (e) => { if (e.key === "Enter") void add(); };
  if (glossaryAliasesEl) glossaryAliasesEl.onkeydown = (e) => { if (e.key === "Enter") void add(); };
  await render();
}

// ---- 3.5 snippets — a separate store (snippets.json) via snip_* commands. Deterministic
// trigger→expansion applied to the final text (post-format). ----
async function initSnippets() {
  if (!snipListEl) return;
  const render = async () => {
    let snips: Array<{ trigger: string; expansion: string }> = [];
    try { snips = await invoke("snip_list"); } catch { snips = []; }
    snipListEl.innerHTML = "";
    if (!snips.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "No snippets yet.";
      snipListEl.appendChild(empty);
    }
    for (const s of snips) {
      const row = document.createElement("div");
      row.className = "list-row";
      const label = document.createElement("span");
      label.className = "list-term";
      label.textContent = `${s.trigger} → ${s.expansion}`;
      const del = document.createElement("button");
      del.className = "btn ghost";
      del.textContent = "Delete";
      del.onclick = async () => { try { await invoke("snip_delete", { trigger: s.trigger }); await render(); } catch {} };
      row.append(label, del);
      snipListEl.appendChild(row);
    }
  };
  const add = async () => {
    const trigger = snipTriggerEl?.value.trim() ?? "";
    const expansion = snipExpansionEl?.value.trim() ?? "";
    if (!trigger || !expansion) return;
    try {
      await invoke("snip_add", { trigger, expansion });
      if (snipTriggerEl) snipTriggerEl.value = "";
      if (snipExpansionEl) snipExpansionEl.value = "";
      await render();
    } catch {}
  };
  if (snipAddEl) snipAddEl.onclick = add;
  await render();
}

// Refresh every simple control from the current `config` (used on load, after Reset, and
// on external config-changed writes).
function refreshControls() {
  initProviderControls();
  initDockIcon();
  initMuteOthers();
  initShowTranscript();
  initShowRemoved();
  initSystemCommands();
  initWakeWord();
  initLaunchAtLogin();
  initDebug();
  initSelfCorrect();
  initFormat();
  initFormatMode();
  initHistoryLimit();
  initAutoDetect();
  initTelemetry();
  if (micEnumerated) syncMicSelection(); else void initMicDevice();
  applyThemeUI(currentTheme());
  refreshHotkeyUI();
  refreshPasteLastUI();
  refreshRevertRawUI();
  refreshCommandUI();
  void initPtt();
  renderCapabilityErrors();
}

// ---- reset settings (1.3) — restore defaults, keep API keys, live-update the form ----
function initReset() {
  if (!resetBtnEl) return;
  resetBtnEl.onclick = async () => {
    if (!confirm("Reset all settings to defaults? Your API keys are kept.")) return;
    try {
      // clear_config also emits config-changed (which refreshes the form); re-read the
      // return value and refresh directly too, for immediacy.
      config = await invoke<AppConfig>("clear_config");
      refreshControls();
    } catch {}
  };
}

// `config-changed` fires from ANY writer (this window, or a future overlay/sidecar
// listener) — keep the form in sync if the store changes from elsewhere.
void listen<AppConfig>("config-changed", (e) => {
  config = e.payload;
  refreshControls();
});

window.addEventListener("DOMContentLoaded", async () => {
  // Fast-path: apply the cached theme immediately so the window doesn't flash before the
  // config store resolves; initTheme() below re-applies from config (source of truth).
  applyThemeUI(cachedTheme());
  initNav();
  try { config = await invoke<AppConfig>("get_config"); } catch {}
  initTheme();
  initProviderControls();
  initDockIcon();
  initMuteOthers();
  initShowTranscript();
  initShowRemoved();
  initSystemCommands();
  initWakeWord();
  initLaunchAtLogin();
  initDebug();
  initSelfCorrect();
  initFormat();
  initFormatMode();
  initHistoryLimit();
  initAutoDetect();
  initTelemetry();
  initReset();
  refreshHotkeyUI();
  refreshPasteLastUI();
  refreshRevertRawUI();
  refreshCommandUI();
  void initMicDevice();
  void initVocabulary();
  void initSnippets();
  void initVendorKeys();
  void refreshMicStatus();
  void refreshAxStatus();
  void refreshImStatus();
  void initPtt();
});
