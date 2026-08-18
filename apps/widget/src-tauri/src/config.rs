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
    pub stt_provider: String,        // "pyai" | "deepgram" | "openai" | "nemotron"
    pub correction_provider: String, // "openai" | "anthropic" (PyAI removed as a correction vendor — it stays STT + TTS only)
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
    pub format_mode: String,         // 5.3 — "prose" | "message" | "code" | "raw" (default "prose")
    pub paste_last_hotkey: String,   // 2.1 — global accelerator to paste last transcript ("" = unset)
    pub revert_raw_hotkey: String,   // 5.4 — global accelerator to re-inject the RAW transcript ("" = unset)
    pub mic_device_id: String,       // 3.1 — chosen input device deviceId ("" = system default)
    pub auto_detect_language: bool,  // 3.2 — auto-detect spoken language (Deepgram/OpenAI streaming)
    pub telemetry: bool,             // 3.3 — anonymous, metadata-only telemetry (default off; transport parked)
    pub fn_push_to_talk: bool,       // Wave 4 — hold a bare key (Fn) to dictate (needs Input Monitoring)
    pub ptt_key: String,             // Wave 4 — which bare key: "fn" | "right_cmd" | "right_opt"
    pub command_provider: String,    // P1 — command-mode classifier vendor ("" = follow correction_provider, resolved in the backend)
    pub command_model: String,       // P1 — optional per-vendor model override for command mode; "" = provider default
    pub command_hotkey: String,      // P1 — global accelerator to start/stop command mode ("" = unset)
    pub system_commands: bool,       // P2 — allow system commands (launch/volume/shortcut) via macOS delegation (default false, opt-in)
    pub wake_word_enabled: bool,     // P3 — always-on on-device wake-word listener (default false, opt-in; engages the mic + orange dot)
    pub wake_word_handler: String,   // P3 — which handler a detection fires: "dictate" | "command" (default "dictate")
    pub wake_word_threshold: f32,    // P3 — detection score threshold 0..1 (default 0.3, live-tunable via atomics, no restart — see wake.rs PATIENCE/AGC notes: 0.5-0.6 was above the real utterance's sustained plateau, so genuine detections never satisfied PATIENCE; going below ~0.25 risks firing on ambient-noise score blips instead)
    pub wake_word_model: String,     // P3 — wake-word model asset id under resources/wakeword/ (default stock "hey_jarvis")
    pub wake_word_greeting: bool,    // P3 — speak a hardcoded reply ("Hello Mayank, how can I help you?") when the wake word fires (default true)
    pub tts_provider: String,        // P3 — text-to-speech vendor for the wake-word greeting: "pyai" | "deepgram" (default "pyai" — PyAI already offers STT + TTS)
    pub show_transcript: bool,       // Widget redesign — show the live-transcript/correction-reveal bubble while dictating (default true; off = pill only, text still corrects + injects silently)
    pub show_removed: bool,          // Widget redesign — during the correction reveal, fade removed spans instead of collapsing them immediately (default true)
    pub history_limit: u32,          // dictation history — how many recent entries to show: 10 | 20 | 50 (default 20)
    // Local Nemotron ASR (NeMo-Speech.cpp + Metal). Used when stt_provider = "nemotron".
    pub asr_model_path: String,      // GGUF path; "" = app_data/models/nemotron-speech-streaming-en-0.6b.q8_0.gguf
    pub asr_streaming_ms: u32,         // 160 | 560 | 1120 — streaming chunk latency preset (default 560)
    pub asr_use_metal: bool,         // Metal backend on Apple Silicon (default true)
    pub asr_vad_model_path: String,  // optional Silero VAD GGUF; "" = endpointing without separate VAD model
    pub asr_vad_onset: f32,          // VAD speech onset threshold (default 0.5)
    pub asr_vad_offset: f32,         // VAD speech offset threshold (default 0.35)
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            stt_provider: "pyai".into(),
            correction_provider: "openai".into(),
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
            format_mode: "prose".into(),
            paste_last_hotkey: String::new(),
            revert_raw_hotkey: String::new(),
            mic_device_id: String::new(),
            auto_detect_language: false,
            telemetry: false,
            fn_push_to_talk: false,
            ptt_key: "fn".into(),
            command_provider: String::new(),
            command_model: String::new(),
            command_hotkey: String::new(),
            system_commands: false,
            wake_word_enabled: false,
            wake_word_handler: "dictate".into(),
            wake_word_threshold: 0.3,
            wake_word_model: "hey_jarvis".into(),
            wake_word_greeting: true,
            tts_provider: "pyai".into(),
            show_transcript: true,
            show_removed: true,
            history_limit: 20,
            asr_model_path: String::new(),
            asr_streaming_ms: 560,
            asr_use_metal: true,
            asr_vad_model_path: String::new(),
            asr_vad_onset: 0.5,
            asr_vad_offset: 0.35,
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
    // 5.4 — re-register the revert-to-raw accelerator only when it changes ("" = unregister).
    #[cfg(desktop)]
    if next.revert_raw_hotkey != old.revert_raw_hotkey {
        let _ = crate::hotkey::apply_revert_raw_hotkey(&app, &next.revert_raw_hotkey);
    }
    // P1 — re-register the command-mode accelerator only when it changes ("" = unregister).
    #[cfg(desktop)]
    if next.command_hotkey != old.command_hotkey {
        let _ = crate::hotkey::apply_command_hotkey(&app, &next.command_hotkey);
    }
    // Wave 4 — start/stop the Fn PTT event tap when the toggle OR the key changes. Only
    // runs the tap when enabled, so a user who never turns PTT on is never prompted for
    // Input Monitoring.
    #[cfg(target_os = "macos")]
    if next.fn_push_to_talk != old.fn_push_to_talk || next.ptt_key != old.ptt_key {
        crate::fnkey::set_enabled(&app, next.fn_push_to_talk, &next.ptt_key);
    }
    // P3 — wake-word listener reconcile. SELECTIVE (should-fix 1): tearing down cpal +
    // reloading the 3 ONNX sessions is heavy, so ONLY a change to `wake_word_enabled` or
    // `wake_word_model` restarts the listener. `wake_word_threshold` / `wake_word_handler`
    // are pushed LIVE to the running thread via atomics (mirrors fnkey's AtomicI64
    // PTT_KEYCODE) — no restart. Threshold/handler are pushed unconditionally-on-change so
    // the running thread always reflects the latest config even across a restart.
    #[cfg(target_os = "macos")]
    {
        if next.wake_word_enabled != old.wake_word_enabled
            || next.wake_word_model != old.wake_word_model
        {
            crate::wake::set_enabled(&app, next.wake_word_enabled, &next);
        }
        if next.wake_word_threshold != old.wake_word_threshold {
            crate::wake::set_threshold(next.wake_word_threshold);
        }
        if next.wake_word_handler != old.wake_word_handler {
            crate::wake::set_handler(&next.wake_word_handler);
        }
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
        let _ = crate::hotkey::apply_revert_raw_hotkey(&app, &def.revert_raw_hotkey); // 5.4 — default "" unregisters
        let _ = crate::hotkey::apply_command_hotkey(&app, &def.command_hotkey); // P1 — default "" unregisters
    }
    apply_autostart(&app, def.launch_at_login); // default false → remove login item
    // Wave 4 — default fn_push_to_talk=false, so tear the PTT event tap down on reset.
    #[cfg(target_os = "macos")]
    crate::fnkey::set_enabled(&app, def.fn_push_to_talk, &def.ptt_key);
    // P3 — default wake_word_enabled=false, so tear the wake-word listener down on reset.
    #[cfg(target_os = "macos")]
    crate::wake::set_enabled(&app, def.wake_word_enabled, &def);
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
