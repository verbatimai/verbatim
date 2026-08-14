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

let selectedVendor: string | null = null;

function updateSaveEnabled() {
  saveBtn.disabled = !selectedVendor || !keyInput.value.trim();
}

vendorPicker?.querySelectorAll<HTMLButtonElement>(".onboard-vendor").forEach((btn) => {
  btn.onclick = () => {
    selectedVendor = btn.dataset.vendor ?? null;
    vendorPicker.querySelectorAll(".onboard-vendor").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    updateSaveEnabled();
  };
});
keyInput.addEventListener("input", updateSaveEnabled);

function showError(msg: string) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

saveBtn.onclick = async () => {
  const vendor = selectedVendor;
  const secret = keyInput.value.trim();
  if (!vendor || !secret) return;
  saveBtn.disabled = true;
  try {
    await invoke("set_key", { vendor, secret });
    const caps = VENDOR_CAPABILITIES[vendor] ?? {};
    const patch: Record<string, string> = {};
    if (caps.stt) patch.sttProvider = vendor;
    if (caps.correction) patch.correctionProvider = vendor;
    if (Object.keys(patch).length) await invoke("set_config", { patch });
    await getCurrentWindow().hide();
  } catch (e) {
    showError("Couldn't save that key — check it and try again.");
    saveBtn.disabled = false;
  }
};

skipBtn.onclick = () => {
  void getCurrentWindow().hide(); // no key saved — onboarding shows again next launch
};
