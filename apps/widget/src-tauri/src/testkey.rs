//! Onboarding O6 — the Saaslabs PyAI test key, build-time and internal-only.
//!
//! `option_env!` is read at COMPILE time, so a build made without the env var has no key
//! in the binary at all: `test_key_available()` answers false and the onboarding button
//! cannot render. Absence is structural, not a flag someone can flip.
//! See docs/product/onboarding-plan.md §7 and scripts/assert-no-test-key.sh (the
//! release-checklist assertion that the string is absent from a public artifact).
//!
//! The key string never crosses the webview boundary: `use_test_key` stores it through the
//! same secret adapter `keys::set_key` uses and restarts the sidecar so it is picked up
//! from the process env. Nothing here logs or returns the key.
//!
//! PyAI is STT-only, so one click yields RAW dictation with no self-correction — the
//! caller applies the resolver's `raw` patch and the button's sub-label says so.

/// Compile-time only. `std::env::var` would be wrong: it would read the USER's environment
/// at runtime, which is neither internal-only nor auditable.
const TEST_KEY: Option<&str> = option_env!("VERBATIM_PYAI_TEST_KEY");

/// Account name must match `keys.rs::vendor_key_name`'s "pyai" arm (keys.rs:65) and
/// `backend.rs::VENDOR_KEYS` (backend.rs:15), or the sidecar never sees the key.
const PYAI_ACCOUNT: &str = "PYAI_API_KEY";

#[tauri::command]
pub fn test_key_available() -> bool {
    TEST_KEY.is_some()
}

#[tauri::command]
pub fn use_test_key(app: tauri::AppHandle) -> Result<(), String> {
    let k = TEST_KEY.ok_or("no test key in this build")?;
    crate::secrets::secret_set(&app, PYAI_ACCOUNT, k)?; // renderer never sees the string
    crate::backend::restart_backend(&app); // sidecar picks the key up from its env
    Ok(())
}

/// Guardrail 4 of onboarding-plan.md §7: watermark internal builds so a leaked `.app` is
/// identifiable. Called from main.rs's `setup()`; a no-op in a key-less (public) build, so
/// the public title stays exactly "Welcome to Verbatim" (tauri.conf.json).
pub fn watermark_title(app: &tauri::AppHandle) {
    use tauri::Manager;
    if TEST_KEY.is_none() {
        return;
    }
    if let Some(w) = app.get_webview_window("onboarding") {
        let _ = w.set_title("Welcome to Verbatim (internal build)");
    }
}
