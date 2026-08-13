// Settings window entry point.
//
// Phase 4.2: a minimal scaffold whose only job is to prove the window takes keyboard
// focus (the overlay is a non-key NSPanel and can't). The real configuration UI —
// typed API keys, provider/model dropdowns, hotkey capture, language, permission
// status — lands in Phase 4.7, reading/writing through the Rust config store (4.3).

window.addEventListener("DOMContentLoaded", () => {
  const probe = document.getElementById("probe") as HTMLInputElement | null;
  probe?.focus();
});
