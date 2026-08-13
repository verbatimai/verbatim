//! Phase 3.5 / 4.3: BYOK — vendor API keys.
//!
//! `account` is the vendor key name (e.g. "PYAI_API_KEY"). Keys are never logged. Storage
//! is chosen by the hidden `key_storage` flag (Settings §1.6): "local" (default) writes a
//! 0600 secrets.json; "keychain" uses the OS keychain. Every command below routes through
//! the `secrets` adapter — the JS-facing signatures are unchanged (Tauri injects `app`).
//! `KEYCHAIN_SERVICE` is consumed by the keychain backend in `secrets.rs` (as
//! `crate::KEYCHAIN_SERVICE`, via the re-export in `main.rs`).

use crate::secrets;

pub const KEYCHAIN_SERVICE: &str = "co.saaslabs.verbatim";

#[tauri::command]
pub fn key_save(app: tauri::AppHandle, account: String, secret: String) -> Result<(), String> {
    secrets::secret_set(&app, &account, &secret)
}

#[tauri::command]
pub fn key_get(app: tauri::AppHandle, account: String) -> Result<Option<String>, String> {
    Ok(secrets::secret_get(&app, &account))
}

#[tauri::command]
pub fn key_has(app: tauri::AppHandle, account: String) -> bool {
    secrets::secret_has(&app, &account)
}

#[tauri::command]
pub fn key_delete(app: tauri::AppHandle, account: String) -> Result<(), String> {
    secrets::secret_delete(&app, &account)
}

/// Save a key that's ALREADY on the clipboard.
///
/// Why not just type it in the field? The widget is a non-activating, NON-KEY panel
/// (so it never steals keyboard focus from the app underneath — that's what makes
/// injection work). A non-key panel means its `<input>` can never receive typed or
/// pasted keystrokes. So instead of typing, the user copies their key and we read the
/// clipboard here in Rust (no keyboard focus required) and store it. Returns a masked
/// preview (last 4 chars) for confirmation; the full key is never returned or logged.
#[tauri::command]
pub fn key_save_clipboard(app: tauri::AppHandle, account: String) -> Result<String, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let raw = cb
        .get_text()
        .map_err(|_| "Clipboard has no text — copy your key first.".to_string())?;
    let secret = raw.trim().to_string();
    if secret.is_empty() {
        return Err("Clipboard is empty — copy your key first.".into());
    }
    secrets::secret_set(&app, &account, &secret)?;
    let n = secret.chars().count();
    let last4: String = secret.chars().skip(n.saturating_sub(4)).collect();
    crate::backend::restart_backend(&app); // sidecar picks up the new key from its env (Phase 4.8)
    Ok(format!("••••{last4}"))
}

/// Forward API keyed by vendor id (the settings UI in 4.7 uses these). The vendor→
/// env-var map MUST stay in sync with each provider's `requiredKeys` in packages/core
/// (providers/registry.ts, correction/registry.ts). The generic `key_*` commands above
/// stay for the current UI.
fn vendor_key_name(vendor: &str) -> Option<&'static str> {
    match vendor {
        "pyai" => Some("PYAI_API_KEY"),
        "deepgram" => Some("DEEPGRAM_API_KEY"),
        "openai" => Some("OPENAI_API_KEY"),
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        _ => None,
    }
}

#[tauri::command]
pub fn set_key(app: tauri::AppHandle, vendor: String, secret: String) -> Result<(), String> {
    let acct = vendor_key_name(&vendor).ok_or_else(|| format!("unknown vendor: {vendor}"))?;
    secrets::secret_set(&app, acct, &secret)?;
    crate::backend::restart_backend(&app); // sidecar picks up the new key from its env (Phase 4.8)
    Ok(())
}

#[tauri::command]
pub fn has_key(app: tauri::AppHandle, vendor: String) -> bool {
    vendor_key_name(&vendor)
        .map(|acct| secrets::secret_has(&app, acct))
        .unwrap_or(false)
}

#[tauri::command]
pub fn delete_key(app: tauri::AppHandle, vendor: String) -> Result<(), String> {
    let acct = vendor_key_name(&vendor).ok_or_else(|| format!("unknown vendor: {vendor}"))?;
    secrets::secret_delete(&app, acct)
}
