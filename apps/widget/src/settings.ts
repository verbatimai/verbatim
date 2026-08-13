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
  show("models"); // land on our headline feature

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

// ---- theme: light / dark / system, persisted in localStorage ----
function initTheme() {
  const order = ["system", "light", "dark"] as const;
  type Theme = (typeof order)[number];
  const labelEl = $("themeLabel");
  const seg = document.querySelectorAll<HTMLButtonElement>("[data-theme-opt]");
  const apply = (t: Theme) => {
    document.body.dataset.theme = t;
    labelEl.textContent = t[0].toUpperCase() + t.slice(1);
    seg.forEach((b) => b.classList.toggle("active", b.dataset.themeOpt === t));
    try { localStorage.setItem("verbatim.theme", t); } catch {}
  };
  let current = ((): Theme => {
    try { return (localStorage.getItem("verbatim.theme") as Theme) || "system"; } catch { return "system"; }
  })();
  apply(current);
  $<HTMLButtonElement>("themeToggle").onclick = () => {
    current = order[(order.indexOf(current) + 1) % order.length];
    apply(current);
  };
  seg.forEach((b) => (b.onclick = () => { current = (b.dataset.themeOpt as Theme); apply(current); }));
}

// ---- dock icon toggle (real config field) ----
function initDockIcon() {
  const el = document.getElementById("dockIcon") as HTMLInputElement | null;
  if (!el) return;
  el.checked = !!config.dockIcon;
  el.onchange = async () => { await patchConfig({ dockIcon: el.checked }); };
}

// `config-changed` fires from ANY writer (this window, or a future overlay/sidecar
// listener) — keep the form in sync if the store changes from elsewhere.
void listen<AppConfig>("config-changed", (e) => {
  config = e.payload;
  initProviderControls();
  initDockIcon();
  refreshHotkeyUI();
  renderCapabilityErrors();
});

window.addEventListener("DOMContentLoaded", async () => {
  initNav();
  initTheme();
  try { config = await invoke<AppConfig>("get_config"); } catch {}
  initProviderControls();
  initDockIcon();
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
