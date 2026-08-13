//! Phase 4.3: config store (single source of truth for non-secret settings).
//!
//! Persisted as JSON in `<app_config_dir>/settings.json` via tauri-plugin-store. Shape is
//! a SUPERSET of the core `AppSettings` (packages/core/src/settings.ts) — same camelCase
//! keys for the provider-selection slice, plus widget-only prefs (hotkey, dockIcon).
//! Secrets are NOT here; API keys live in `keys.rs` / `secrets.rs`.
//!
//! ⚠ Adding a field: `set_config` deserializes the WHOLE merged object into `AppConfig`,
//! so every new field needs `#[serde(default)]` coverage (the struct-level
//! `#[serde(..., default)]` below provides it) AND a matching entry in `Default`, or an
//! existing `settings.json` will fail to parse.

use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub stt_provider: String,        // "pyai" | "deepgram" | "openai"
    pub correction_provider: String, // "pyai" | "openai" | "anthropic"
    pub stt_model: String,           // optional per-vendor model override; "" = provider default
    pub correction_model: String,    // optional per-vendor model override; "" = provider default
    pub language: String,            // BCP-47 tag, default "en"
    pub hotkey: String,              // preset id or captured accelerator (e.g. "Alt+Space")
    pub dock_icon: bool,
    pub mute_others: bool,           // mute system audio output while dictating (restored on stop)
    pub launch_at_login: bool,       // 1.2 — macOS login item (synced via tauri-plugin-autostart)
    pub debug: bool,                 // 1.4 — inject HEAR_DEBUG=1 into the backend sidecar
    pub theme: String,               // 1.5 — "system" | "light" | "dark" (themes all webviews)
    pub key_storage: String,         // 1.6 — HIDDEN, no UI: secret backend, "local" | "keychain"
    pub correct: bool,               // 2.2 — run the self-correction pass on finalize (default true)
    pub format: bool,                // 2.3 — run the formatting pass on finalize (default true)
    pub paste_last_hotkey: String,   // 2.1 — global accelerator to paste last transcript ("" = unset)
    pub mic_device_id: String,       // 3.1 — chosen input device deviceId ("" = system default)
    pub auto_detect_language: bool,  // 3.2 — auto-detect spoken language (Deepgram/OpenAI streaming)
    pub telemetry: bool,             // 3.3 — anonymous, metadata-only telemetry (default off; transport parked)
    pub fn_push_to_talk: bool,       // Wave 4 — hold a bare key (Fn) to dictate (needs Input Monitoring)
    pub ptt_key: String,             // Wave 4 — which bare key: "fn" | "right_cmd" | "right_opt"
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            stt_provider: "pyai".into(),
            correction_provider: "pyai".into(),
            stt_model: String::new(),
            correction_model: String::new(),
            language: "en".into(),
            hotkey: "alt-space".into(),
            dock_icon: false,
            mute_others: true,
            launch_at_login: false,
            debug: false,
            theme: "system".into(),
            key_storage: "local".into(),
            correct: true,
            format: true,
            paste_last_hotkey: String::new(),
            mic_device_id: String::new(),
            auto_detect_language: false,
            telemetry: false,
            fn_push_to_talk: false,
            ptt_key: "fn".into(),
        }
    }
}

const STORE_FILE: &str = "settings.json";
const CONFIG_KEY: &str = "config";

pub fn read_config(app: &tauri::AppHandle) -> AppConfig {
    use tauri_plugin_store::StoreExt;
    let store = match app.store(STORE_FILE) {
        Ok(s) => s,
        Err(_) => return AppConfig::default(),
    };
    store
        .get(CONFIG_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub fn write_config(app: &tauri::AppHandle, cfg: &AppConfig) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(CONFIG_KEY, serde_json::to_value(cfg).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_config(app: tauri::AppHandle) -> AppConfig {
    read_config(&app)
}

/// Shallow-merge `patch` over the current config, persist, re-register the hotkey if it
/// changed, and broadcast `config-changed` so the overlay/pipeline refresh live.
#[tauri::command]
pub fn set_config(app: tauri::AppHandle, patch: serde_json::Value) -> Result<AppConfig, String> {
    let old = read_config(&app); // typed snapshot for change-guards (autostart, debug restart)
    let mut cur = serde_json::to_value(&old).map_err(|e| e.to_string())?;
    if let (Some(base), Some(p)) = (cur.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            base.insert(k.clone(), v.clone());
        }
    }
    let next: AppConfig = serde_json::from_value(cur).map_err(|e| e.to_string())?;
    write_config(&app, &next)?;

    // Side effect: a changed hotkey must be re-registered live.
    #[cfg(desktop)]
    {
        let _ = crate::hotkey::apply_hotkey(&app, &next.hotkey);
    }

    // 1.2 — sync the macOS login item only when the toggle actually flips.
    if next.launch_at_login != old.launch_at_login {
        apply_autostart(&app, next.launch_at_login);
    }
    // 1.4 — restart the sidecar when Debug flips so it picks up / drops HEAR_DEBUG.
    if next.debug != old.debug {
        crate::backend::restart_backend(&app);
    }
    // 2.1 — re-register the paste-last accelerator only when it changes ("" = unregister).
    #[cfg(desktop)]
    if next.paste_last_hotkey != old.paste_last_hotkey {
        let _ = crate::hotkey::apply_paste_last_hotkey(&app, &next.paste_last_hotkey);
    }
    // Wave 4 — start/stop the Fn PTT event tap when the toggle OR the key changes. Only
    // runs the tap when enabled, so a user who never turns PTT on is never prompted for
    // Input Monitoring.
    #[cfg(target_os = "macos")]
    if next.fn_push_to_talk != old.fn_push_to_talk || next.ptt_key != old.ptt_key {
        crate::fnkey::set_enabled(&app, next.fn_push_to_talk, &next.ptt_key);
    }
    // Phase 7 (Fix 3) — apply the Dock-icon activation policy live when it flips (no
    // restart). The overlay panel's non-key behaviour is unaffected by the policy.
    #[cfg(target_os = "macos")]
    if next.dock_icon != old.dock_icon {
        let _ = app.set_activation_policy(crate::window::desired_activation_policy(next.dock_icon));
    }

    let _ = app.emit("config-changed", &next);
    Ok(next)
}

/// 1.2 — reflect the config's launch-at-login into the OS login item. Driven from Rust
/// (set_config side-effect + startup reconcile), so the frontend never invokes the plugin.
#[cfg(desktop)]
pub fn apply_autostart(app: &tauri::AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let m = app.autolaunch();
    if enabled {
        let _ = m.enable();
    } else {
        let _ = m.disable();
    }
}
#[cfg(not(desktop))]
pub fn apply_autostart(_app: &tauri::AppHandle, _enabled: bool) {}

/// 1.3 — Reset: restore ALL config to defaults, KEEP secrets (secrets.json / Keychain are
/// untouched), and broadcast so every open webview live-updates. Re-registers the default
/// hotkey, clears the login item, and restarts the sidecar if it was running in debug.
#[tauri::command]
pub fn clear_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
    let was_debug = read_config(&app).debug;
    let def = AppConfig::default();
    write_config(&app, &def)?;
    #[cfg(desktop)]
    {
        let _ = crate::hotkey::apply_hotkey(&app, &def.hotkey); // re-register default ⌥Space
        let _ = crate::hotkey::apply_paste_last_hotkey(&app, &def.paste_last_hotkey); // 2.1 — default "" unregisters
    }
    apply_autostart(&app, def.launch_at_login); // default false → remove login item
    // Wave 4 — default fn_push_to_talk=false, so tear the PTT event tap down on reset.
    #[cfg(target_os = "macos")]
    crate::fnkey::set_enabled(&app, def.fn_push_to_talk, &def.ptt_key);
    // Phase 7 (Fix 3) — re-apply the default Dock-icon policy so a Reset that clears a
    // previously-on dock icon takes effect live (default dock_icon=false ⇒ Accessory).
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(crate::window::desired_activation_policy(def.dock_icon));
    if was_debug {
        crate::backend::restart_backend(&app); // drop HEAR_DEBUG from the sidecar env
    }
    // Secrets are DELIBERATELY not touched here — API keys survive a reset (Settings §1.6).
    let _ = app.emit("config-changed", &def);
    Ok(def)
}

/// One-time seed: if the store has no config yet, create it from defaults, importing the
/// legacy `<app_config_dir>/hotkey` file (Phase 3.6) if present so existing users keep their
/// hotkey. Idempotent — runs only until a config exists.
pub fn migrate_legacy_config(app: &tauri::AppHandle) {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store(STORE_FILE) else {
        return;
    };
    if store.get(CONFIG_KEY).is_some() {
        return;
    }
    let mut cfg = AppConfig::default();
    if let Some(p) = crate::hotkey::hotkey_config_path(app) {
        if let Ok(s) = std::fs::read_to_string(p) {
            let id = s.trim().to_string();
            if !id.is_empty() {
                cfg.hotkey = id;
            }
        }
    }
    let _ = write_config(app, &cfg);
}
