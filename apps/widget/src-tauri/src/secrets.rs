// ── Settings §1.6 — secret storage adapter ────────────────────────────────────
// Replaces direct macOS-Keychain access with a pluggable backend chosen by the HIDDEN
// `key_storage` config flag (default "local"). The Tauri command names/signatures in
// main.rs (`set_key`/`has_key`/`delete_key`, the generic `key_*`, and the sidecar
// injection path) are unchanged — every key read/write routes through the four functions
// here, so no code path can re-introduce a login-password prompt while "local" is active.
//
// Backends (selected per call by `read_config(app).key_storage`):
//   "local"    (default) — a JSON map in <app_config_dir>/secrets.json, chmod 0600.
//   "keychain"           — the OS keychain (kept reachable for a future opt-in flag).
//
// Keys are keyed by ACCOUNT name (the env-var string, e.g. "PYAI_API_KEY"), matching the
// account used by the old Keychain entries. Secret VALUES are NEVER logged/printed here.
//
// TODO (deferred, Settings §1.6 — do NOT implement in Wave 1): when a user-facing storage
// toggle ships and `key_storage` can change at runtime, add MIGRATE-AND-WIPE — copy each
// key into the newly-selected backend and securely delete the old copy on change. Only
// "local" ships active now, so there is no migration path yet.

use std::collections::BTreeMap;
use tauri::{AppHandle, Manager};

fn backend(app: &AppHandle) -> String {
    crate::read_config(app).key_storage
}

fn secrets_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    // Same dir as settings.json, but a SEPARATE file so it's trivial to wipe and never
    // rides along in the tauri-plugin-store. Lives OUTSIDE the repo (app_config_dir).
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("secrets.json"))
}

fn read_map(app: &AppHandle) -> BTreeMap<String, String> {
    let Some(p) = secrets_path(app) else {
        return BTreeMap::new();
    };
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => BTreeMap::new(), // missing/unreadable file → empty map
    }
}

fn write_map(app: &AppHandle, map: &BTreeMap<String, String>) -> Result<(), String> {
    let p = secrets_path(app).ok_or("no config dir")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // NOTE: `map` may hold secret values — serialize/write only, NEVER log it.
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    // Atomic-ish write (temp + rename) so a crash mid-write can't corrupt the store; lock
    // the file down to 0600 both before and after the rename.
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    set_owner_only(&tmp);
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    set_owner_only(&p);
    Ok(())
}

fn set_owner_only(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

pub fn secret_set(app: &AppHandle, account: &str, secret: &str) -> Result<(), String> {
    match backend(app).as_str() {
        "keychain" => keyring::Entry::new(crate::KEYCHAIN_SERVICE, account)
            .and_then(|e| e.set_password(secret))
            .map_err(|e| e.to_string()),
        _ => {
            let mut map = read_map(app);
            map.insert(account.to_string(), secret.to_string());
            write_map(app, &map)
        }
    }
}

pub fn secret_get(app: &AppHandle, account: &str) -> Option<String> {
    match backend(app).as_str() {
        "keychain" => keyring::Entry::new(crate::KEYCHAIN_SERVICE, account)
            .and_then(|e| e.get_password())
            .ok(),
        _ => read_map(app).get(account).cloned(),
    }
}

pub fn secret_has(app: &AppHandle, account: &str) -> bool {
    match backend(app).as_str() {
        "keychain" => keyring::Entry::new(crate::KEYCHAIN_SERVICE, account)
            .and_then(|e| e.get_password())
            .is_ok(),
        _ => read_map(app).contains_key(account),
    }
}

pub fn secret_delete(app: &AppHandle, account: &str) -> Result<(), String> {
    match backend(app).as_str() {
        "keychain" => {
            match keyring::Entry::new(crate::KEYCHAIN_SERVICE, account)
                .and_then(|e| e.delete_credential())
            {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(e.to_string()),
            }
        }
        _ => {
            let mut map = read_map(app);
            if map.remove(account).is_some() {
                write_map(app, &map)?;
            }
            Ok(())
        }
    }
}
