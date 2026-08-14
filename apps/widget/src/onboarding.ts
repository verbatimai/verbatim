// Verbatim — first-run onboarding (onboarding.html). Shown once, from Rust
// (main.rs's setup(), via keys::any_vendor_key_saved), when no vendor key is saved
// anywhere. Never shown again once a key exists — see window.rs::open_onboarding_window.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Which config field(s) each vendor covers, mirroring packages/core's provider
// registries (pyai/openai do both STT + correction; deepgram is STT-only;
// anthropic is correction-only) — duplicated here rather than imported, same as
// settings.ts's VENDOR_ENV/VENDOR_LABELS (no shared runtime with this Vite app).
const VENDOR_CAPABILITIES: Record<string, { stt?: boolean; correction?: boolean }> = {
  pyai: { stt: true, correction: true },
  deepgram: { stt: true },
  openai: { stt: true, correction: true },
  anthropic: { correction: true },
};

const vendorPicker = document.getElementById("vendorPicker");
const keyInput = document.getElementById("onboardKey") as HTMLInputElement;
const errorEl = document.getElementById("onboardError") as HTMLElement;
const saveBtn = document.getElementById("onboardSave") as HTMLButtonElement;
const skipBtn = document.getElementById("onboardSkip") as HTMLButtonElement;

// pyai is the recommended provider, so it starts selected — the "Get started"
// button then enables as soon as a key is typed, instead of looking dead until
// the user first clicks a provider.
let selectedVendor: string | null = "pyai";

function selectVendor(vendor: string) {
  selectedVendor = vendor;
  vendorPicker?.querySelectorAll(".onboard-vendor").forEach((b) => {
    b.classList.toggle("selected", (b as HTMLElement).dataset.vendor === vendor);
  });
  updateSaveEnabled();
}

function updateSaveEnabled() {
  saveBtn.disabled = !selectedVendor || !keyInput.value.trim();
}

vendorPicker?.querySelectorAll<HTMLButtonElement>(".onboard-vendor").forEach((btn) => {
  btn.onclick = () => selectVendor(btn.dataset.vendor ?? "");
});
keyInput.addEventListener("input", updateSaveEnabled);

// Reflect the default selection in the UI on load.
if (selectedVendor) selectVendor(selectedVendor);

function showError(msg: string) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

saveBtn.onclick = async () => {
  const vendor = selectedVendor;
  const secret = keyInput.value.trim();
  // Never a silent no-op — a stale/desynced selectedVendor (e.g. after a dev HMR
  // reload) must surface as a visible error, not a click that does nothing.
  if (!vendor) { showError("Pick a provider first."); return; }
  if (!secret) { showError("Paste your API key first."); return; }
  errorEl.hidden = true;
  saveBtn.disabled = true;
  try {
    await invoke("set_key", { vendor, secret });
    const caps = VENDOR_CAPABILITIES[vendor] ?? {};
    const patch: Record<string, string> = {};
    if (caps.stt) patch.sttProvider = vendor;
    if (caps.correction) patch.correctionProvider = vendor;
    if (Object.keys(patch).length) await invoke("set_config", { patch });
  } catch (e) {
    showError("Couldn't save that key — check it and try again.");
    saveBtn.disabled = false;
    return;
  }
  // The key + provider are saved at this point — closing the window is a courtesy,
  // not a condition of success, so its failure must never look like a save failure.
  try { await getCurrentWindow().hide(); } catch {}
};

skipBtn.onclick = () => {
  // no key saved — onboarding shows again next launch
  getCurrentWindow().hide().catch(() => {});
};
