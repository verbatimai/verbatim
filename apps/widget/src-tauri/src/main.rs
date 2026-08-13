#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::time::Instant;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

mod inject;

#[cfg(target_os = "macos")]
mod axinject;

// Hotkey dictation state. A quick tap toggles (hands-free); a hold is push-to-talk
// (record while held, stop on release).
static RECORDING: Mutex<bool> = Mutex::new(false);
static PRESS_AT: Mutex<Option<Instant>> = Mutex::new(None);
static STARTED_THIS_PRESS: Mutex<bool> = Mutex::new(false);
const HOLD_MS: u128 = 300; // ≥ this held = push-to-talk; below = a tap (toggle)

// The toggle hotkey currently registered. It's configurable at runtime (set_toggle_hotkey
// swaps the registration), so the handler compares the fired shortcut against THIS rather
// than a compile-time constant.
#[cfg(desktop)]
static CURRENT_TOGGLE: Mutex<Option<tauri_plugin_global_shortcut::Shortcut>> = Mutex::new(None);

// Inject the finalized text into the focused field — but only when it makes sense.
// Returns a status the UI reacts to:
//   "inserted"  — pasted into an editable field
//   "secure"    — focused field is a password/secure field; refused, text copied instead
//   "no_field"  — nothing editable was focused; text copied to the clipboard instead
#[tauri::command]
fn inject_text(text: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(axinject::inject(&text))
    }
    #[cfg(not(target_os = "macos"))]
    {
        inject::paste_text(&text)?;
        Ok("inserted".into())
    }
}

// Copy text to the clipboard (no paste, no restore) — the reliable fallback when no
// editable field is focused to receive an injected paste.
#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    inject::copy_only(&text)
}

// Hide the overlay (auto-hide after inserting, Wispr-style).
#[tauri::command]
fn hide_widget(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

// ── Phase 4.2: the focusable Settings window ──────────────────────────────────
// The overlay ("main") is a non-key NSPanel and can never accept typed input — that's
// what lets injected text land in the app underneath. The Settings window is an ordinary
// focusable NSWindow. A menu-bar app runs as `Accessory` (no Dock icon, never frontmost,
// so the overlay never steals focus); to give the Settings window keyboard focus we must
// briefly switch the app to `Regular`, then revert to `Accessory` when it closes (see the
// CloseRequested handler in setup). The overlay panel stays non-key throughout.
fn open_settings_window(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    let win = app
        .get_webview_window("settings")
        .ok_or_else(|| "no 'settings' window".to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn show_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    open_settings_window(&app)
}

// ── Phase 4.3: config store (single source of truth for non-secret settings) ───
// Persisted as JSON in <app_config_dir>/settings.json via tauri-plugin-store. Shape is
// a SUPERSET of the core `AppSettings` (packages/core/src/settings.ts) — same camelCase
// keys for the provider-selection slice, plus widget-only prefs (hotkey, dockIcon).
// Secrets are NOT here; API keys live in the Keychain (see below).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
struct AppConfig {
    stt_provider: String,        // "pyai" | "deepgram" | "openai"
    correction_provider: String, // "pyai" | "openai" | "anthropic"
    stt_model: String,           // optional per-vendor model override; "" = provider default
    correction_model: String,    // optional per-vendor model override; "" = provider default
    language: String,            // BCP-47 tag, default "en"
    hotkey: String,              // preset id or captured accelerator (e.g. "Alt+Space")
    dock_icon: bool,
    mute_others: bool,           // mute system audio output while dictating (restored on stop)
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
        }
    }
}

const STORE_FILE: &str = "settings.json";
const CONFIG_KEY: &str = "config";

fn read_config(app: &tauri::AppHandle) -> AppConfig {
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

fn write_config(app: &tauri::AppHandle, cfg: &AppConfig) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(CONFIG_KEY, serde_json::to_value(cfg).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_config(app: tauri::AppHandle) -> AppConfig {
    read_config(&app)
}

// Shallow-merge `patch` over the current config, persist, re-register the hotkey if it
// changed, and broadcast `config-changed` so the overlay/pipeline refresh live.
#[tauri::command]
fn set_config(app: tauri::AppHandle, patch: serde_json::Value) -> Result<AppConfig, String> {
    let mut cur = serde_json::to_value(read_config(&app)).map_err(|e| e.to_string())?;
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
        let _ = apply_hotkey(&app, &next.hotkey);
    }

    let _ = app.emit("config-changed", &next);
    Ok(next)
}

// One-time seed: if the store has no config yet, create it from defaults, importing the
// legacy <app_config_dir>/hotkey file (Phase 3.6) if present so existing users keep their
// hotkey. Idempotent — runs only until a config exists.
fn migrate_legacy_config(app: &tauri::AppHandle) {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store(STORE_FILE) else {
        return;
    };
    if store.get(CONFIG_KEY).is_some() {
        return;
    }
    let mut cfg = AppConfig::default();
    if let Some(p) = hotkey_config_path(app) {
        if let Ok(s) = std::fs::read_to_string(p) {
            let id = s.trim().to_string();
            if !id.is_empty() {
                cfg.hotkey = id;
            }
        }
    }
    let _ = write_config(app, &cfg);
}

// ── Phase 3.5: BYOK — vendor API keys in the OS keychain ──────────────────────
// `account` is the vendor key name (e.g. "PYAI_API_KEY"). Keys never touch disk/env
// beyond the keychain, and are never logged.
const KEYCHAIN_SERVICE: &str = "co.saaslabs.verbatim";

#[tauri::command]
fn key_save(account: String, secret: String) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &account)
        .and_then(|e| e.set_password(&secret))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn key_get(account: String) -> Result<Option<String>, String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, &account).and_then(|e| e.get_password()) {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn key_has(account: String) -> bool {
    keyring::Entry::new(KEYCHAIN_SERVICE, &account)
        .and_then(|e| e.get_password())
        .is_ok()
}

#[tauri::command]
fn key_delete(account: String) -> Result<(), String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, &account).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// Save a key that's ALREADY on the clipboard into the Keychain.
// Why not just type it in the field? The widget is a non-activating, NON-KEY panel
// (so it never steals keyboard focus from the app underneath — that's what makes
// injection work). A non-key panel means its <input> can never receive typed or
// pasted keystrokes. So instead of typing, the user copies their key and we read the
// clipboard here in Rust (no keyboard focus required) and store it. Returns a masked
// preview (last 4 chars) for confirmation; the full key is never returned or logged.
#[tauri::command]
fn key_save_clipboard(account: String) -> Result<String, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let raw = cb
        .get_text()
        .map_err(|_| "Clipboard has no text — copy your key first.".to_string())?;
    let secret = raw.trim().to_string();
    if secret.is_empty() {
        return Err("Clipboard is empty — copy your key first.".into());
    }
    keyring::Entry::new(KEYCHAIN_SERVICE, &account)
        .and_then(|e| e.set_password(&secret))
        .map_err(|e| e.to_string())?;
    let n = secret.chars().count();
    let last4: String = secret.chars().skip(n.saturating_sub(4)).collect();
    Ok(format!("••••{last4}"))
}

// ── Phase 4.3: per-vendor keychain wrappers ───────────────────────────────────
// Forward API keyed by vendor id (the settings UI in 4.7 uses these). The vendor→
// env-var map MUST stay in sync with each provider's `requiredKeys` in packages/core
// (providers/registry.ts, correction/registry.ts). The generic `key_*` commands above
// stay for the current UI.
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
fn set_key(vendor: String, secret: String) -> Result<(), String> {
    let acct = vendor_key_name(&vendor).ok_or_else(|| format!("unknown vendor: {vendor}"))?;
    keyring::Entry::new(KEYCHAIN_SERVICE, acct)
        .and_then(|e| e.set_password(&secret))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn has_key(vendor: String) -> bool {
    vendor_key_name(&vendor)
        .map(|acct| {
            keyring::Entry::new(KEYCHAIN_SERVICE, acct)
                .and_then(|e| e.get_password())
                .is_ok()
        })
        .unwrap_or(false)
}

#[tauri::command]
fn delete_key(vendor: String) -> Result<(), String> {
    let acct = vendor_key_name(&vendor).ok_or_else(|| format!("unknown vendor: {vendor}"))?;
    match keyring::Entry::new(KEYCHAIN_SERVICE, acct).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// Open System Settings to a specific Privacy pane so the user can grant access.
// macOS only; no-op elsewhere.
#[cfg(target_os = "macos")]
fn open_privacy_pane(anchor: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(format!("x-apple.systempreferences:com.apple.preference.security?{anchor}"))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_mic_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        open_privacy_pane("Privacy_Microphone")
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

#[tauri::command]
fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        open_privacy_pane("Privacy_Accessibility")
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

// Is the app trusted for Accessibility? Powers the proactive permission indicator in
// Settings (so the user isn't surprised by the first injection banner).
#[tauri::command]
fn ax_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        axinject::is_trusted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

// ── Mute other audio while dictating ──────────────────────────────────────────
// When enabled (config.muteOthers), the webview mutes the system output at the start
// of a dictation and restores the prior state on stop — so music/video doesn't bleed
// into the mic. We toggle the *muted* flag only (never the volume level), so unmuting
// returns to exactly the level the user had. macOS-only via AppleScript; no-op else.

// Is the system audio OUTPUT currently muted? Read before muting so we can restore it.
#[tauri::command]
fn get_output_muted() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("osascript")
            .args(["-e", "output muted of (get volume settings)"])
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().eq_ignore_ascii_case("true"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

#[tauri::command]
fn set_output_muted(muted: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let val = if muted { "true" } else { "false" };
        std::process::Command::new("osascript")
            .args(["-e", &format!("set volume output muted {val}")])
            .status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = muted;
        Ok(())
    }
}

// ── Configurable toggle hotkey ────────────────────────────────────────────────
// The widget is a non-key panel (can't accept typed keystrokes), so the user picks the
// hotkey from a fixed set of presets by CLICKING — no key-capture UI needed. The choice
// persists to a tiny file in the app config dir and is re-registered live.

// Map a preset id → an actual Shortcut. Keep this list in sync with the buttons in the
// Settings UI (main.ts HOTKEYS).
#[cfg(desktop)]
fn preset_shortcut(id: &str) -> Option<tauri_plugin_global_shortcut::Shortcut> {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
    let (m, c) = match id {
        "alt-space" => (Modifiers::ALT, Code::Space),
        "ctrl-space" => (Modifiers::CONTROL, Code::Space),
        "cmd-shift-d" => (Modifiers::SUPER | Modifiers::SHIFT, Code::KeyD),
        "ctrl-alt-d" => (Modifiers::CONTROL | Modifiers::ALT, Code::KeyD),
        "alt-grave" => (Modifiers::ALT, Code::Backquote),
        _ => return None,
    };
    Some(Shortcut::new(Some(m), c))
}

// Map a Web `KeyboardEvent.code` string (what the Settings UI's hotkey-capture
// input reads, 4.7) to the matching `Code` variant. Covers what a hotkey combo
// realistically uses — letters, digits, common punctuation, and a few named
// keys — not the full DOM UI Events code list.
#[cfg(desktop)]
fn parse_code(code: &str) -> Option<tauri_plugin_global_shortcut::Code> {
    use tauri_plugin_global_shortcut::Code;
    if let Some(rest) = code.strip_prefix("Key") {
        let ch = rest.chars().next()?;
        if rest.len() == 1 && ch.is_ascii_alphabetic() {
            return Some(match ch.to_ascii_uppercase() {
                'A' => Code::KeyA, 'B' => Code::KeyB, 'C' => Code::KeyC, 'D' => Code::KeyD,
                'E' => Code::KeyE, 'F' => Code::KeyF, 'G' => Code::KeyG, 'H' => Code::KeyH,
                'I' => Code::KeyI, 'J' => Code::KeyJ, 'K' => Code::KeyK, 'L' => Code::KeyL,
                'M' => Code::KeyM, 'N' => Code::KeyN, 'O' => Code::KeyO, 'P' => Code::KeyP,
                'Q' => Code::KeyQ, 'R' => Code::KeyR, 'S' => Code::KeyS, 'T' => Code::KeyT,
                'U' => Code::KeyU, 'V' => Code::KeyV, 'W' => Code::KeyW, 'X' => Code::KeyX,
                'Y' => Code::KeyY, 'Z' => Code::KeyZ,
                _ => return None,
            });
        }
    }
    if let Some(rest) = code.strip_prefix("Digit") {
        return match rest {
            "0" => Some(Code::Digit0), "1" => Some(Code::Digit1), "2" => Some(Code::Digit2),
            "3" => Some(Code::Digit3), "4" => Some(Code::Digit4), "5" => Some(Code::Digit5),
            "6" => Some(Code::Digit6), "7" => Some(Code::Digit7), "8" => Some(Code::Digit8),
            "9" => Some(Code::Digit9),
            _ => None,
        };
    }
    if let Some(rest) = code.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u8>() {
            return match n {
                1 => Some(Code::F1), 2 => Some(Code::F2), 3 => Some(Code::F3), 4 => Some(Code::F4),
                5 => Some(Code::F5), 6 => Some(Code::F6), 7 => Some(Code::F7), 8 => Some(Code::F8),
                9 => Some(Code::F9), 10 => Some(Code::F10), 11 => Some(Code::F11), 12 => Some(Code::F12),
                _ => None,
            };
        }
    }
    match code {
        "Space" => Some(Code::Space),
        "Backquote" => Some(Code::Backquote),
        "Minus" => Some(Code::Minus),
        "Equal" => Some(Code::Equal),
        "BracketLeft" => Some(Code::BracketLeft),
        "BracketRight" => Some(Code::BracketRight),
        "Backslash" => Some(Code::Backslash),
        "Semicolon" => Some(Code::Semicolon),
        "Quote" => Some(Code::Quote),
        "Comma" => Some(Code::Comma),
        "Period" => Some(Code::Period),
        "Slash" => Some(Code::Slash),
        "Tab" => Some(Code::Tab),
        "Escape" => Some(Code::Escape),
        "Enter" => Some(Code::Enter),
        "Backspace" => Some(Code::Backspace),
        "ArrowUp" => Some(Code::ArrowUp),
        "ArrowDown" => Some(Code::ArrowDown),
        "ArrowLeft" => Some(Code::ArrowLeft),
        "ArrowRight" => Some(Code::ArrowRight),
        _ => None,
    }
}

// Parse an accelerator captured by the Settings UI's hotkey-capture input, e.g.
// "Alt+Space" or "Control+Shift+KeyD" (modifier names + a Web `code`, joined by
// "+"). A legacy/preset id (e.g. "alt-space") is tried first for back-compat.
#[cfg(desktop)]
fn parse_accelerator(s: &str) -> Option<tauri_plugin_global_shortcut::Shortcut> {
    use tauri_plugin_global_shortcut::{Modifiers, Shortcut};
    if let Some(sc) = preset_shortcut(s) {
        return Some(sc);
    }
    let mut parts: Vec<&str> = s.split('+').map(str::trim).filter(|p| !p.is_empty()).collect();
    let code_str = parts.pop()?;
    let code = parse_code(code_str)?;
    let mut mods = Modifiers::empty();
    for p in parts {
        mods |= match p {
            "Alt" => Modifiers::ALT,
            "Control" => Modifiers::CONTROL,
            "Shift" => Modifiers::SHIFT,
            "Meta" | "Super" | "Cmd" => Modifiers::SUPER,
            _ => return None,
        };
    }
    if mods.is_empty() {
        return None; // a bare key with no modifier isn't a safe global shortcut
    }
    Some(Shortcut::new(Some(mods), code))
}

fn hotkey_config_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("hotkey"))
}

// Persisted preset id, defaulting to ⌥Space. Never fails — a missing/garbled file just
// falls back to the default so the app always has a working hotkey.
// Superseded by the config store (4.3); kept for one release. `hotkey_config_path` is
// still used by migrate_legacy_config.
#[allow(dead_code)]
fn load_hotkey_id(app: &tauri::AppHandle) -> String {
    hotkey_config_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "alt-space".to_string())
}

#[allow(dead_code)]
fn save_hotkey_id(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let p = hotkey_config_path(app).ok_or("no config dir")?;
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(p, id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_toggle_hotkey(app: tauri::AppHandle) -> String {
    // Source of truth is now the config store (Phase 4.3).
    read_config(&app).hotkey
}

// Re-register the global toggle shortcut live: drop the old one, register the new preset,
// and remember it so the handler recognises the fired shortcut. Called from set_config.
#[cfg(desktop)]
fn apply_hotkey(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let sc = parse_accelerator(id).ok_or_else(|| format!("unrecognized hotkey: {id}"))?;
    let gs = app.global_shortcut();
    if let Some(old) = CURRENT_TOGGLE.lock().unwrap().take() {
        let _ = gs.unregister(old);
    }
    gs.register(sc).map_err(|e| e.to_string())?;
    *CURRENT_TOGGLE.lock().unwrap() = Some(sc);
    Ok(())
}

#[tauri::command]
fn set_toggle_hotkey(app: tauri::AppHandle, id: String) -> Result<(), String> {
    // Store-backed: set_config persists the hotkey, re-registers it (apply_hotkey), and
    // emits config-changed.
    set_config(app, serde_json::json!({ "hotkey": id })).map(|_| ())
}

// ── Spike A: reclass the "main" window into a non-activating, NON-KEY NSPanel ────
//
// A plain Tauri window is an NSWindow; even with `focus:false` it activates the app
// AND becomes the key window the moment you click it — so keystrokes go to the
// widget instead of the app you were typing in. The fix has two halves:
//   1. Accessory activation policy + non-activating style mask → the *app* never
//      becomes frontmost (this already worked in the v2 attempt).
//   2. `can_become_key_window: false` → the panel never becomes the *key* window,
//      so the keyboard stays with the app underneath. THIS is what was missing.
// `tauri-nspanel` v2.1's `tauri_panel!` macro lets us declare that class.
// See docs/architecture/macos-injection.md §4.
//
// macOS-only + version-sensitive to `tauri-nspanel`. If the build breaks it'll be on
// the macro below or the `to_panel::<SpikePanel>()` / `set_style_mask` lines (see
// README "If it doesn't build").
#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(SpikePanel {
        config: {
            // Never take keyboard focus from the app underneath.
            can_become_key_window: false,
            // Float above normal windows.
            is_floating_panel: true
        }
    })
}

#[cfg(target_os = "macos")]
fn configure_non_activating_panel(app: &mut tauri::App) {
    // `objc2_app_kit` is re-exported by tauri-nspanel, so we use its exact version
    // (a separately-added objc2-app-kit dep would be a different type → E0308).
    use tauri_nspanel::{
        objc2_app_kit::{NSWindowCollectionBehavior, NSWindowStyleMask},
        WebviewWindowExt,
    };

    // Accessory app: no Dock icon; the app never becomes the active/frontmost app.
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

    let window = match app.get_webview_window("main") {
        Some(w) => w,
        None => {
            eprintln!("[spike-a] no 'main' window to reclass");
            return;
        }
    };

    // Reclass NSWindow -> our non-key, non-activating NSPanel subclass.
    match window.to_panel::<SpikePanel>() {
        Ok(panel) => {
            // Non-activating: clicking the panel doesn't bring our app frontmost, so
            // the app you were typing in stays active.
            panel.set_style_mask(NSWindowStyleMask::NonactivatingPanel);
            // 3.3 overlay behaviour: show on every Space and over full-screen apps, and
            // don't get shuffled by Space switches.
            panel.set_collection_behavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::Stationary
                    | NSWindowCollectionBehavior::FullScreenAuxiliary,
            );
            println!("[spike-a] main window reclassed to non-activating, non-key NSPanel");
        }
        Err(e) => eprintln!("[spike-a] to_panel() failed: {e:?}"),
    }
}

fn main() {
    let mut builder = tauri::Builder::default();

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    // Phase 4.3: config store (settings.json in the app config dir).
    builder = builder.plugin(tauri_plugin_store::Builder::new().build());

    builder
        .setup(|app| {
            #[cfg(target_os = "macos")]
            configure_non_activating_panel(app);

            // Phase 4.2: closing the Settings window HIDES it (keeps it for a fast reopen)
            // and reverts the activation policy — the app must NOT quit when settings closes
            // (it's a menu-bar app; the tray keeps it alive). The overlay is untouched.
            if let Some(settings) = app.get_webview_window("settings") {
                let app_h = app.handle().clone();
                settings.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(w) = app_h.get_webview_window("settings") {
                            let _ = w.hide();
                        }
                        #[cfg(target_os = "macos")]
                        let _ = app_h.set_activation_policy(tauri::ActivationPolicy::Accessory);
                    }
                });
            }

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };

                // The toggle hotkey — from the config store (default ⌥Space), configurable
                // at runtime via set_config/set_toggle_hotkey. On first run, migrate the
                // legacy <app_config_dir>/hotkey file into the store.
                migrate_legacy_config(app.handle());
                let hotkey_id = read_config(app.handle()).hotkey;
                let toggle = parse_accelerator(&hotkey_id)
                    .unwrap_or_else(|| Shortcut::new(Some(Modifiers::ALT), Code::Space));
                *CURRENT_TOGGLE.lock().unwrap() = Some(toggle);

                // ⌥⇧V — DEMO / PASTE TEST. Injects a fixed sentence straight through the
                // Rust inject() path (read focus → route → AX-write/paste). Bypasses the
                // backend/STT entirely, so it works even when the pyai quota is spent.
                // Fires on RELEASE so the physical modifier keys are up before the
                // synthetic ⌘V lands.
                let test_paste = Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyV);
                let test_for_handler = test_paste;

                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            // Demo/paste-test hotkey: no backend, no widget, just inject.
                            if shortcut == &test_for_handler {
                                if event.state() == ShortcutState::Released {
                                    #[cfg(target_os = "macos")]
                                    {
                                        const DEMO: &str =
                                            "The quick brown fox jumps over the lazy dog.";
                                        eprintln!(
                                            "[axinject] === TEST PASTE hotkey (demo, no backend) ==="
                                        );
                                        let status = axinject::inject(DEMO);
                                        eprintln!("[axinject] test paste status = {}", status);
                                    }
                                }
                                return;
                            }

                            // Compare against the CURRENTLY-registered toggle (it can change
                            // at runtime), not a captured constant.
                            let is_toggle = CURRENT_TOGGLE
                                .lock()
                                .unwrap()
                                .as_ref()
                                .map_or(false, |t| t == shortcut);
                            if !is_toggle {
                                return;
                            }
                            match event.state() {
                                ShortcutState::Pressed => {
                                    // Probe focus while the widget is still hidden — the
                                    // hotkey fires without touching our window.
                                    #[cfg(target_os = "macos")]
                                    axinject::probe();

                                    *PRESS_AT.lock().unwrap() = Some(Instant::now());
                                    let was_recording = *RECORDING.lock().unwrap();
                                    if was_recording {
                                        // Second tap -> stop (toggle off).
                                        *RECORDING.lock().unwrap() = false;
                                        *STARTED_THIS_PRESS.lock().unwrap() = false;
                                        let _ = app.emit("dictation", "stop");
                                    } else {
                                        // Summon (no set_focus) and start.
                                        if let Some(win) = app.get_webview_window("main") {
                                            let _ = win.show();
                                        }
                                        *RECORDING.lock().unwrap() = true;
                                        *STARTED_THIS_PRESS.lock().unwrap() = true;
                                        let _ = app.emit("dictation", "start");
                                    }
                                }
                                ShortcutState::Released => {
                                    let held = PRESS_AT
                                        .lock()
                                        .unwrap()
                                        .map(|t| t.elapsed().as_millis())
                                        .unwrap_or(0);
                                    let started = {
                                        let mut s = STARTED_THIS_PRESS.lock().unwrap();
                                        let v = *s;
                                        *s = false;
                                        v
                                    };
                                    // Held long enough on the starting press = push-to-talk;
                                    // stop on release. A quick tap leaves it recording (toggle).
                                    if started && held >= HOLD_MS {
                                        *RECORDING.lock().unwrap() = false;
                                        let _ = app.emit("dictation", "stop");
                                    }
                                }
                                _ => {}
                            }
                        })
                        .build(),
                )?;

                app.global_shortcut().register(toggle)?;
                app.global_shortcut().register(test_paste)?;

                // Menu-bar (tray) icon — the always-visible "the widget is available"
                // indicator, since the window itself stays hidden until summoned. ⌥Space
                // (or the menu's "Show") opens the dictation UI.
                {
                    use tauri::menu::{Menu, MenuItem};
                    use tauri::tray::TrayIconBuilder;
                    let h = app.handle();
                    let show_i = MenuItem::with_id(
                        h,
                        "show",
                        "Show Verbatim  (⌥Space)",
                        true,
                        None::<&str>,
                    )?;
                    let last_i =
                        MenuItem::with_id(h, "last", "Show Last Result", true, None::<&str>)?;
                    let settings_i =
                        MenuItem::with_id(h, "settings", "Settings…", true, None::<&str>)?;
                    let quit_i =
                        MenuItem::with_id(h, "quit", "Quit Verbatim", true, None::<&str>)?;
                    let menu = Menu::with_items(h, &[&show_i, &last_i, &settings_i, &quit_i])?;
                    let icon = app.default_window_icon().cloned();
                    let mut tray = TrayIconBuilder::with_id("main-tray")
                        .tooltip("Verbatim — press ⌥Space to dictate")
                        .menu(&menu)
                        .on_menu_event(|app, event| match event.id.as_ref() {
                            "show" => {
                                if let Some(w) = app.get_webview_window("main") {
                                    let _ = w.show();
                                }
                            }
                            "last" => {
                                if let Some(w) = app.get_webview_window("main") {
                                    let _ = w.show();
                                    let _ = app.emit("show-last", ());
                                }
                            }
                            "settings" => {
                                // Phase 4.2: open the real, focusable Settings window
                                // (was: show the overlay + emit "open-settings" for the
                                // inline panel — that path is removed in 4.9).
                                let _ = open_settings_window(app);
                            }
                            "quit" => app.exit(0),
                            _ => {}
                        });
                    if let Some(ic) = icon {
                        tray = tray.icon(ic);
                    }
                    let _tray = tray.build(h)?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            inject_text,
            open_mic_settings,
            open_accessibility_settings,
            ax_trusted,
            get_output_muted,
            set_output_muted,
            get_toggle_hotkey,
            set_toggle_hotkey,
            copy_text,
            hide_widget,
            show_settings_window,
            get_config,
            set_config,
            key_save,
            key_save_clipboard,
            key_get,
            key_has,
            key_delete,
            set_key,
            has_key,
            delete_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Verbatim widget");
}
