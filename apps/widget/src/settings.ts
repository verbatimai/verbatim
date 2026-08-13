// Settings window — Phase 4.7: real controls (typed keys, provider/model
// dropdowns, hotkey capture, language, permission status), reading/writing
// through the Rust config store + keychain (4.3). This window is an ordinary
// focusable NSWindow (unlike the overlay's non-key panel), so — unlike the old
// inline panel — it can accept typed input and real keydown-based hotkey capture.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type AppConfig = {
  sttProvider: string;
  correctionProvider: string;
  sttModel: string;
  correctionModel: string;
  language: string;
  hotkey: string;
  dockIcon: boolean;
  muteOthers?: boolean;
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
const KNOWN_LANGUAGES = new Set(["en", "es", "fr", "de", "hi", "ja", "zh"]);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sttProviderEl = $<HTMLSelectElement>("sttProvider");
const correctionProviderEl = $<HTMLSelectElement>("correctionProvider");
const sttModelEl = $<HTMLInputElement>("sttModel");
const correctionModelEl = $<HTMLInputElement>("correctionModel");
const languageEl = $<HTMLSelectElement>("language");
const languageCustomEl = $<HTMLInputElement>("languageCustom");
const languageHintEl = $("languageHint");
const capabilityErrorsEl = $("capabilityErrors");
const vendorKeysEl = $("vendorKeys");
const muteOthersEl = $<HTMLInputElement>("muteOthers");
const hotkeyCaptureEl = $<HTMLInputElement>("hotkeyCapture");
const hotkeyClearEl = $<HTMLButtonElement>("hotkeyClear");
const hotkeyPresetsEl = $("hotkeyPresets");
const micStatusEl = $("micStatus");
const axStatusEl = $("axStatus");
const openMicEl = $<HTMLButtonElement>("openMic");
const openAxEl = $<HTMLButtonElement>("openAx");

let config: AppConfig = {
  sttProvider: "pyai",
  correctionProvider: "pyai",
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

/** Mirrors packages/core/src/settings.ts's `capabilityErrors` (can't be imported
 * into this standalone Vite app), using local `hasKey` in place of `process.env`. */
function capabilityErrors(): string[] {
  const errors: string[] = [];
  if (!hasKey[config.sttProvider]) {
    errors.push(`STT '${config.sttProvider}' needs ${VENDOR_ENV[config.sttProvider]}.`);
  }
  if (!hasKey[config.correctionProvider]) {
    errors.push(`Correction '${config.correctionProvider}' needs ${VENDOR_ENV[config.correctionProvider]}.`);
  }
  if (config.sttProvider === "pyai" && !isEnglish(config.language)) {
    errors.push(`PyAI Hear is English-only — choose Deepgram or OpenAI as the STT vendor for language '${config.language}'.`);
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
function vendorRow(vendor: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "vendor-row";
  row.innerHTML = `
    <div class="vendor-label"><span>${VENDOR_LABELS[vendor]}</span><span class="status" data-status></span></div>
    <div class="row">
      <input type="password" placeholder="${VENDOR_ENV[vendor]}" autocomplete="off" data-input />
      <button data-save>Save</button>
      <button data-clear>Clear</button>
    </div>`;
  const input = row.querySelector<HTMLInputElement>("[data-input]")!;
  const status = row.querySelector<HTMLElement>("[data-status]")!;
  const saveBtn = row.querySelector<HTMLButtonElement>("[data-save]")!;
  const clearBtn = row.querySelector<HTMLButtonElement>("[data-clear]")!;

  const refresh = () => {
    status.textContent = hasKey[vendor] ? "✓ saved" : "not set";
    status.classList.toggle("ok", hasKey[vendor]);
  };
  refresh();

  saveBtn.onclick = async () => {
    const secret = input.value.trim();
    if (!secret) return;
    status.textContent = "saving…";
    try {
      await invoke("set_key", { vendor, secret });
      hasKey[vendor] = true;
      input.value = "";
      refresh();
      renderCapabilityErrors();
    } catch (e) {
      status.textContent = "save failed: " + String(e);
      status.classList.remove("ok");
    }
  };
  clearBtn.onclick = async () => {
    try {
      await invoke("delete_key", { vendor });
      hasKey[vendor] = false;
      refresh();
      renderCapabilityErrors();
    } catch (e) {
      status.textContent = "clear failed: " + String(e);
    }
  };
  return row;
}

async function initVendorKeys() {
  for (const vendor of Object.keys(VENDOR_ENV)) {
    vendorKeysEl.appendChild(vendorRow(vendor));
    try { hasKey[vendor] = await invoke<boolean>("has_key", { vendor }); } catch { hasKey[vendor] = false; }
  }
  // Re-render statuses now that has_key results are in (rows were built optimistically above).
  vendorKeysEl.querySelectorAll<HTMLElement>(".vendor-row").forEach((row, i) => {
    const vendor = Object.keys(VENDOR_ENV)[i];
    const status = row.querySelector<HTMLElement>("[data-status]")!;
    status.textContent = hasKey[vendor] ? "✓ saved" : "not set";
    status.classList.toggle("ok", hasKey[vendor]);
  });
  renderCapabilityErrors();
}

// ---- providers, models, language ----
function initProviderControls() {
  sttProviderEl.value = config.sttProvider;
  correctionProviderEl.value = config.correctionProvider;
  sttModelEl.value = config.sttModel;
  correctionModelEl.value = config.correctionModel;

  if (KNOWN_LANGUAGES.has(config.language) || config.language === "en") {
    languageEl.value = config.language || "en";
  } else {
    languageEl.value = "other";
    languageCustomEl.style.display = "block";
    languageCustomEl.value = config.language;
  }
  updateLanguageHint();

  sttProviderEl.onchange = async () => { await patchConfig({ sttProvider: sttProviderEl.value }); };
  correctionProviderEl.onchange = async () => { await patchConfig({ correctionProvider: correctionProviderEl.value }); };
  sttModelEl.onblur = async () => { await patchConfig({ sttModel: sttModelEl.value.trim() }); };
  correctionModelEl.onblur = async () => { await patchConfig({ correctionModel: correctionModelEl.value.trim() }); };

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
}

function updateLanguageHint() {
  languageHintEl.textContent = isEnglish(config.language)
    ? ""
    : "Non-English: PyAI Hear can't transcribe this — pick Deepgram or OpenAI as the STT vendor above.";
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

let recording = false;
function stopRecording() {
  recording = false;
  hotkeyCaptureEl.classList.remove("recording");
  window.removeEventListener("keydown", onCaptureKeydown, true);
}
async function onCaptureKeydown(e: KeyboardEvent) {
  e.preventDefault();
  e.stopPropagation();
  if (e.code === "Escape") { stopRecording(); refreshHotkeyUI(); return; }
  if (MODIFIER_CODES.has(e.code)) return; // wait for the real key
  const mods: string[] = [];
  if (e.altKey) mods.push("Alt");
  if (e.ctrlKey) mods.push("Control");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Meta");
  if (!mods.length) {
    hotkeyCaptureEl.value = "Add a modifier (⌥/⌃/⌘/⇧) + a key…";
    return; // keep listening — a bare key isn't a safe global shortcut
  }
  const accel = [...mods, e.code].join("+");
  stopRecording();
  try {
    await invoke("set_toggle_hotkey", { id: accel });
    config = { ...config, hotkey: accel };
  } catch (err) {
    hotkeyCaptureEl.value = "Unsupported key — try another";
    setTimeout(refreshHotkeyUI, 1400);
    return;
  }
  refreshHotkeyUI();
}
hotkeyCaptureEl.onclick = () => {
  if (recording) return;
  recording = true;
  hotkeyCaptureEl.classList.add("recording");
  hotkeyCaptureEl.value = "Press a key combo… (Esc to cancel)";
  window.addEventListener("keydown", onCaptureKeydown, true);
};
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
openMicEl.onclick = () => { void invoke("open_mic_settings").catch(() => {}); setTimeout(() => void refreshMicStatus(), 1200); };
openAxEl.onclick = () => { void invoke("open_accessibility_settings").catch(() => {}); setTimeout(() => void refreshAxStatus(), 1200); };

// `config-changed` fires from ANY writer (this window, or a future overlay/sidecar
// listener) — keep the form in sync if the store changes from elsewhere.
void listen<AppConfig>("config-changed", (e) => {
  config = e.payload;
  initProviderControls();
  refreshHotkeyUI();
  renderCapabilityErrors();
});

window.addEventListener("DOMContentLoaded", async () => {
  try { config = await invoke<AppConfig>("get_config"); } catch {}
  initProviderControls();
  refreshHotkeyUI();
  void initVendorKeys();
  void refreshMicStatus();
  void refreshAxStatus();
  // Phase 4.9: the mute-others toggle migrated here from the overlay's old inline panel.
  muteOthersEl.checked = !!config?.muteOthers;
  muteOthersEl.addEventListener("change", () => {
    void invoke("set_config", { patch: { muteOthers: muteOthersEl.checked } });
  });
});
