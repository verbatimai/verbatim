#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::time::Instant;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

mod inject;
mod secrets;

#[cfg(target_os = "macos")]
mod axinject;

// Wave 4 — Fn / bare-modifier push-to-talk (listen-only CGEventTap). macOS-only.
#[cfg(target_os = "macos")]
mod fnkey;

// Hotkey dictation state. A quick tap toggles (hands-free); a hold is push-to-talk
// (record while held, stop on release).
static RECORDING: Mutex<bool> = Mutex::new(false);
static PRESS_AT: Mutex<Option<Instant>> = Mutex::new(None);
static STARTED_THIS_PRESS: Mutex<bool> = Mutex::new(false);
const HOLD_MS: u128 = 300; // ≥ this held = push-to-talk; below = a tap (toggle)

// The last finalized transcript that was injected — retained so the paste-last global
// hotkey (2.1) can re-inject it with NO webview involvement. Recorded inside inject_text,
// whose sole caller is the webview's injectFinal with the finalized formatted text.
static LAST_RESULT: Mutex<Option<String>> = Mutex::new(None);

// The toggle hotkey currently registered. It's configurable at runtime (set_toggle_hotkey
// swaps the registration), so the handler compares the fired shortcut against THIS rather
// than a compile-time constant.
#[cfg(desktop)]
static CURRENT_TOGGLE: Mutex<Option<tauri_plugin_global_shortcut::Shortcut>> = Mutex::new(None);

// 2.1 — the paste-last accelerator currently registered (configurable at runtime; "" = none).
// Mirrors CURRENT_TOGGLE so the global-shortcut handler recognises the fired shortcut.
#[cfg(desktop)]
static CURRENT_PASTE_LAST: Mutex<Option<tauri_plugin_global_shortcut::Shortcut>> = Mutex::new(None);

// Inject the finalized text into the focused field — but only when it makes sense.
// Returns a status the UI reacts to:
//   "inserted"  — pasted into an editable field
//   "secure"    — focused field is a password/secure field; refused, text copied instead
//   "no_field"  — nothing editable was focused; text copied to the clipboard instead
#[tauri::command]
fn inject_text(text: String) -> Result<String, String> {
    *LAST_RESULT.lock().unwrap() = Some(text.clone()); // remember for paste-last (2.1)
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

// ── Phase 4.2: the focusable app window (hosts History + the Settings tab) ─────
// The overlay ("main") is a non-key NSPanel and can never accept typed input — that's
// what lets injected text land in the app underneath. The app window (label "settings",
// loading app.html) is an ordinary focusable NSWindow. A menu-bar app runs as `Accessory`
// (no Dock icon, never frontmost, so the overlay never steals focus); to give this window
// keyboard focus we must briefly switch the app to `Regular`, then revert to `Accessory`
// when it closes (see the CloseRequested handler in setup). The overlay panel stays non-key.
//
// The window loads the main app shell (app.html). The tray/hotkey "Settings…" entrypoint
// deep-links to the in-app Settings tab (settings.html) before showing, so it lands there
// with no visible History flash; "Back to app" inside returns to History.
fn open_settings_window(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    let win = app
        .get_webview_window("settings")
        .ok_or_else(|| "no 'settings' window".to_string())?;
    // Route to the Settings surface while still hidden (avoids a History flash on open).
    let _ = win.eval("if(!location.pathname.endsWith('/settings.html')){location.replace('/settings.html');}");
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
    launch_at_login: bool,       // 1.2 — macOS login item (synced via tauri-plugin-autostart)
    debug: bool,                 // 1.4 — inject HEAR_DEBUG=1 into the backend sidecar
    theme: String,               // 1.5 — "system" | "light" | "dark" (themes all webviews)
    key_storage: String,         // 1.6 — HIDDEN, no UI: secret backend, "local" | "keychain"
    correct: bool,               // 2.2 — run the self-correction pass on finalize (default true)
    format: bool,                // 2.3 — run the formatting pass on finalize (default true)
    paste_last_hotkey: String,   // 2.1 — global accelerator to paste last transcript ("" = unset)
    mic_device_id: String,       // 3.1 — chosen input device deviceId ("" = system default)
    auto_detect_language: bool,  // 3.2 — auto-detect spoken language (Deepgram/OpenAI streaming)
    telemetry: bool,             // 3.3 — anonymous, metadata-only telemetry (default off; transport parked)
    fn_push_to_talk: bool,       // Wave 4 — hold a bare key (Fn) to dictate (needs Input Monitoring)
    ptt_key: String,             // Wave 4 — which bare key: "fn" | "right_cmd" | "right_opt"
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
        let _ = apply_hotkey(&app, &next.hotkey);
    }

    // 1.2 — sync the macOS login item only when the toggle actually flips.
    if next.launch_at_login != old.launch_at_login {
        apply_autostart(&app, next.launch_at_login);
    }
    // 1.4 — restart the sidecar when Debug flips so it picks up / drops HEAR_DEBUG.
    if next.debug != old.debug {
        restart_backend(&app);
    }
    // 2.1 — re-register the paste-last accelerator only when it changes ("" = unregister).
    #[cfg(desktop)]
    if next.paste_last_hotkey != old.paste_last_hotkey {
        let _ = apply_paste_last_hotkey(&app, &next.paste_last_hotkey);
    }
    // Wave 4 — start/stop the Fn PTT event tap when the toggle OR the key changes. Only
    // runs the tap when enabled, so a user who never turns PTT on is never prompted for
    // Input Monitoring.
    #[cfg(target_os = "macos")]
    if next.fn_push_to_talk != old.fn_push_to_talk || next.ptt_key != old.ptt_key {
        fnkey::set_enabled(&app, next.fn_push_to_talk, &next.ptt_key);
    }
    // Phase 7 (Fix 3) — apply the Dock-icon activation policy live when it flips (no
    // restart). The overlay panel's non-key behaviour is unaffected by the policy.
    #[cfg(target_os = "macos")]
    if next.dock_icon != old.dock_icon {
        let _ = app.set_activation_policy(desired_activation_policy(next.dock_icon));
    }

    let _ = app.emit("config-changed", &next);
    Ok(next)
}

// 1.2 — reflect the config's launch-at-login into the OS login item. Driven from Rust
// (set_config side-effect + startup reconcile), so the frontend never invokes the plugin.
#[cfg(desktop)]
fn apply_autostart(app: &tauri::AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let m = app.autolaunch();
    if enabled {
        let _ = m.enable();
    } else {
        let _ = m.disable();
    }
}
#[cfg(not(desktop))]
fn apply_autostart(_app: &tauri::AppHandle, _enabled: bool) {}

// 1.3 — Reset: restore ALL config to defaults, KEEP secrets (secrets.json / Keychain are
// untouched), and broadcast so every open webview live-updates. Re-registers the default
// hotkey, clears the login item, and restarts the sidecar if it was running in debug.
#[tauri::command]
fn clear_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
    let was_debug = read_config(&app).debug;
    let def = AppConfig::default();
    write_config(&app, &def)?;
    #[cfg(desktop)]
    {
        let _ = apply_hotkey(&app, &def.hotkey); // re-register default ⌥Space
        let _ = apply_paste_last_hotkey(&app, &def.paste_last_hotkey); // 2.1 — default "" unregisters
    }
    apply_autostart(&app, def.launch_at_login); // default false → remove login item
    // Wave 4 — default fn_push_to_talk=false, so tear the PTT event tap down on reset.
    #[cfg(target_os = "macos")]
    fnkey::set_enabled(&app, def.fn_push_to_talk, &def.ptt_key);
    // Phase 7 (Fix 3) — re-apply the default Dock-icon policy so a Reset that clears a
    // previously-on dock icon takes effect live (default dock_icon=false ⇒ Accessory).
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(desired_activation_policy(def.dock_icon));
    if was_debug {
        restart_backend(&app); // drop HEAR_DEBUG from the sidecar env
    }
    // Secrets are DELIBERATELY not touched here — API keys survive a reset (Settings §1.6).
    let _ = app.emit("config-changed", &def);
    Ok(def)
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

// ── Phase 3.4 / 3.5: vocabulary + snippets list stores ─────────────────────────
// LIST data (not scalar config), so — like secrets — each lives in its OWN
// tauri-plugin-store file (vocabulary.json / snippets.json), NOT in AppConfig. That
// means Reset (clear_config) leaves them intact, matching the secrets policy. The
// backend never reads these files; the overlay sends the lists on the WS `start` frame.
const VOCAB_FILE: &str = "vocabulary.json";
const VOCAB_KEY: &str = "terms";
const SNIPPETS_FILE: &str = "snippets.json";
const SNIPPETS_KEY: &str = "snippets";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Snippet {
    trigger: String,
    expansion: String,
}

fn read_vocab(app: &tauri::AppHandle) -> Vec<String> {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store(VOCAB_FILE) else {
        return Vec::new();
    };
    store
        .get(VOCAB_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn write_vocab(app: &tauri::AppHandle, terms: &[String]) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(VOCAB_FILE).map_err(|e| e.to_string())?;
    store.set(VOCAB_KEY, serde_json::to_value(terms).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn vocab_list(app: tauri::AppHandle) -> Vec<String> {
    read_vocab(&app)
}

#[tauri::command]
fn vocab_add(app: tauri::AppHandle, term: String) -> Result<Vec<String>, String> {
    let t = term.trim().to_string();
    if t.is_empty() {
        return Err("empty term".into()); // reject blanks (avoids a match-everything term)
    }
    let mut terms = read_vocab(&app);
    // Case-insensitive de-dupe so the same word isn't stored twice.
    if !terms.iter().any(|x| x.eq_ignore_ascii_case(&t)) {
        terms.push(t);
        write_vocab(&app, &terms)?;
    }
    Ok(terms)
}

#[tauri::command]
fn vocab_delete(app: tauri::AppHandle, term: String) -> Result<Vec<String>, String> {
    let mut terms = read_vocab(&app);
    terms.retain(|x| !x.eq_ignore_ascii_case(term.trim()));
    write_vocab(&app, &terms)?;
    Ok(terms)
}

fn read_snippets(app: &tauri::AppHandle) -> Vec<Snippet> {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store(SNIPPETS_FILE) else {
        return Vec::new();
    };
    store
        .get(SNIPPETS_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn write_snippets(app: &tauri::AppHandle, snips: &[Snippet]) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(SNIPPETS_FILE).map_err(|e| e.to_string())?;
    store.set(SNIPPETS_KEY, serde_json::to_value(snips).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn snip_list(app: tauri::AppHandle) -> Vec<Snippet> {
    read_snippets(&app)
}

#[tauri::command]
fn snip_add(app: tauri::AppHandle, trigger: String, expansion: String) -> Result<Vec<Snippet>, String> {
    let trig = trigger.trim().to_string();
    let exp = expansion.trim().to_string();
    // An empty/whitespace trigger would match everything — reject it (risk §3.5).
    if trig.is_empty() || exp.is_empty() {
        return Err("trigger and expansion are required".into());
    }
    let mut snips = read_snippets(&app);
    // Replace an existing trigger (case-insensitive) rather than duplicating it.
    snips.retain(|s| !s.trigger.eq_ignore_ascii_case(&trig));
    snips.push(Snippet { trigger: trig, expansion: exp });
    write_snippets(&app, &snips)?;
    Ok(snips)
}

#[tauri::command]
fn snip_delete(app: tauri::AppHandle, trigger: String) -> Result<Vec<Snippet>, String> {
    let mut snips = read_snippets(&app);
    snips.retain(|s| !s.trigger.eq_ignore_ascii_case(trigger.trim()));
    write_snippets(&app, &snips)?;
    Ok(snips)
}

// ── Phase 3.5: BYOK — vendor API keys ─────────────────────────────────────────
// `account` is the vendor key name (e.g. "PYAI_API_KEY"). Keys are never logged. Storage
// is chosen by the hidden `key_storage` flag (Settings §1.6): "local" (default) writes a
// 0600 secrets.json; "keychain" uses the OS keychain. Every command below routes through
// the `secrets` adapter — the JS-facing signatures are unchanged (Tauri injects `app`).
// KEYCHAIN_SERVICE is consumed by the keychain backend in secrets.rs.
const KEYCHAIN_SERVICE: &str = "co.saaslabs.verbatim";

#[tauri::command]
fn key_save(app: tauri::AppHandle, account: String, secret: String) -> Result<(), String> {
    secrets::secret_set(&app, &account, &secret)
}

#[tauri::command]
fn key_get(app: tauri::AppHandle, account: String) -> Result<Option<String>, String> {
    Ok(secrets::secret_get(&app, &account))
}

#[tauri::command]
fn key_has(app: tauri::AppHandle, account: String) -> bool {
    secrets::secret_has(&app, &account)
}

#[tauri::command]
fn key_delete(app: tauri::AppHandle, account: String) -> Result<(), String> {
    secrets::secret_delete(&app, &account)
}

// Save a key that's ALREADY on the clipboard into the Keychain.
// Why not just type it in the field? The widget is a non-activating, NON-KEY panel
// (so it never steals keyboard focus from the app underneath — that's what makes
// injection work). A non-key panel means its <input> can never receive typed or
// pasted keystrokes. So instead of typing, the user copies their key and we read the
// clipboard here in Rust (no keyboard focus required) and store it. Returns a masked
// preview (last 4 chars) for confirmation; the full key is never returned or logged.
#[tauri::command]
fn key_save_clipboard(app: tauri::AppHandle, account: String) -> Result<String, String> {
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
    restart_backend(&app); // sidecar picks up the new key from its env (Phase 4.8)
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
fn set_key(app: tauri::AppHandle, vendor: String, secret: String) -> Result<(), String> {
    let acct = vendor_key_name(&vendor).ok_or_else(|| format!("unknown vendor: {vendor}"))?;
    secrets::secret_set(&app, acct, &secret)?;
    restart_backend(&app); // sidecar picks up the new key from its env (Phase 4.8)
    Ok(())
}

#[tauri::command]
fn has_key(app: tauri::AppHandle, vendor: String) -> bool {
    vendor_key_name(&vendor)
        .map(|acct| secrets::secret_has(&app, acct))
        .unwrap_or(false)
}

#[tauri::command]
fn delete_key(app: tauri::AppHandle, vendor: String) -> Result<(), String> {
    let acct = vendor_key_name(&vendor).ok_or_else(|| format!("unknown vendor: {vendor}"))?;
    secrets::secret_delete(&app, acct)
}

// ── Phase 4.8: the app owns the backend (sidecar) ─────────────────────────────
// Rust spawns and supervises the Node backend, injecting the vendor API keys from the
// Keychain into its ENV — so the secret never travels through the webview, and there's
// no manual `npm run backend`. The webview only streams mic PCM + provider/language over
// loopback. All present keys are injected so switching vendors needs no restart; adding a
// NEW key (set_key / key_save_clipboard) triggers a restart. See m4.8-sidecar-plan.md.
static BACKEND: Mutex<Option<std::process::Child>> = Mutex::new(None);
const VENDOR_KEYS: [&str; 4] = ["PYAI_API_KEY", "DEEPGRAM_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];

// Inject the backend sidecar's env: loopback host/port, the verbose-log flag when Debug
// is on (Settings §1.4 — the sidecar gates on HEAR_DEBUG==="1"), and every present vendor
// key from the storage adapter (Settings §1.6 — local file or keychain). Secret VALUES are
// never logged here.
fn inject_keys(app: &tauri::AppHandle, cmd: &mut std::process::Command) {
    cmd.env("HOST", "127.0.0.1").env("PORT", "8787");
    if read_config(app).debug {
        cmd.env("HEAR_DEBUG", "1");
    }
    for k in VENDOR_KEYS {
        if let Some(secret) = secrets::secret_get(app, k) {
            cmd.env(k, secret);
        }
    }
}

fn spawn_backend(app: &tauri::AppHandle) {
    #[cfg(debug_assertions)]
    let spawned: Result<std::process::Child, String> = {
        // Dev: run the workspace backend via npm from the repo root
        // (…/apps/widget/src-tauri → up 3 = repo root).
        match std::path::Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(3) {
            Some(root) => {
                let mut cmd = std::process::Command::new("npm");
                cmd.args(["run", "start", "--workspace", "@verbatim/backend"])
                    .current_dir(root);
                inject_keys(app, &mut cmd);
                cmd.spawn().map_err(|e| e.to_string())
            }
            None => Err("can't locate repo root".to_string()),
        }
    };
    #[cfg(not(debug_assertions))]
    let spawned: Result<std::process::Child, String> = {
        // Release: spawn the bundled sidecar (externalBin), which Tauri places next to the
        // app executable with the target-triple stripped. Keys injected from the Keychain.
        match std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("verbatim-backend"))) {
            Some(bin) => {
                let mut cmd = std::process::Command::new(bin);
                inject_keys(app, &mut cmd);
                cmd.spawn().map_err(|e| e.to_string())
            }
            None => Err("can't locate app dir for sidecar".to_string()),
        }
    };
    match spawned {
        Ok(child) => {
            *BACKEND.lock().unwrap() = Some(child);
            println!("[backend] spawned + keyed from local secret store");
        }
        Err(e) => eprintln!("[backend] spawn failed: {e}"),
    }
}

fn kill_backend() {
    if let Some(mut c) = BACKEND.lock().unwrap().take() {
        let _ = c.kill();
    }
}

fn restart_backend(app: &tauri::AppHandle) {
    kill_backend();
    spawn_backend(app);
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

// Wave 4 — Input Monitoring (TCC kTCCServiceListenEvent) permission. Separate service from
// Accessibility; gates the session-level CGEventTap that Fn/PTT relies on. These mirror the
// ax_trusted / open_accessibility_settings pattern above.
#[tauri::command]
fn input_monitoring_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        fnkey::input_monitoring_status()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
fn open_input_monitoring_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        open_privacy_pane("Privacy_ListenEvent")
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

// Proactively prompt for / add Verbatim to the Input Monitoring list when PTT is first
// enabled (friendlier than a silent tap-create failure).
#[tauri::command]
fn request_input_monitoring() {
    #[cfg(target_os = "macos")]
    {
        fnkey::request_input_monitoring();
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

// 2.1 — Register / re-register the paste-last global accelerator. Unlike the toggle it
// accepts the empty string (unset → unregister only, no error). The handler fires it on
// Released so the physical modifiers are up before the synthetic ⌘V (matches the paste-test).
#[cfg(desktop)]
fn apply_paste_last_hotkey(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    if let Some(old) = CURRENT_PASTE_LAST.lock().unwrap().take() {
        let _ = gs.unregister(old);
    }
    if id.trim().is_empty() {
        return Ok(()); // "" = disabled (unregister only)
    }
    let sc = parse_accelerator(id).ok_or_else(|| format!("unrecognized hotkey: {id}"))?;
    gs.register(sc).map_err(|e| e.to_string())?;
    *CURRENT_PASTE_LAST.lock().unwrap() = Some(sc);
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

// Phase 7 (Fix 3) — map the `dock_icon` config flag to a macOS activation policy.
// `Regular` = the app shows a Dock icon and can become frontmost / join the app
// switcher; `Accessory` = menu-bar-only, no Dock icon. This is ORTHOGONAL to the
// overlay's non-activating/non-key behaviour, which comes from the SpikePanel class
// (NonactivatingPanel style mask + can_become_key_window:false), so injection must
// keep working under `Regular` — see docs/product/settings/phase-7-plan.md Fix 3.
#[cfg(target_os = "macos")]
fn desired_activation_policy(dock_icon: bool) -> tauri::ActivationPolicy {
    if dock_icon {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    }
}

#[cfg(target_os = "macos")]
fn configure_non_activating_panel(app: &mut tauri::App) {
    // `objc2_app_kit` is re-exported by tauri-nspanel, so we use its exact version
    // (a separately-added objc2-app-kit dep would be a different type → E0308).
    use tauri_nspanel::{
        objc2_app_kit::{NSWindowCollectionBehavior, NSWindowStyleMask},
        WebviewWindowExt,
    };

    // Phase 7 (Fix 3) — honour the configured `dock_icon` at startup (default false ⇒
    // Accessory: no Dock icon, app never becomes frontmost). The panel reclass + style
    // mask below keep the overlay non-activating regardless of the policy chosen here.
    let _ = app.set_activation_policy(desired_activation_policy(read_config(app.handle()).dock_icon));

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

    // 1.2: autostart — backs the "Launch at login" toggle with a real macOS login item.
    // Driven from Rust (set_config side-effect + startup reconcile); no JS invoke, so no
    // capabilities entry is needed.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ));
    }

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
                        // Phase 7 (Fix 3) — revert to the CONFIGURED policy, not a hard
                        // Accessory: with the Dock icon on, open+close Settings must NOT
                        // hide it. open_settings_window bumps to Regular for keyboard focus;
                        // this lands back on whatever `dock_icon` says.
                        #[cfg(target_os = "macos")]
                        let _ = app_h.set_activation_policy(desired_activation_policy(read_config(&app_h).dock_icon));
                    }
                });
            }

            // Phase 4.8: the app owns the backend — spawn + supervise it, injecting the
            // vendor keys from the Keychain into its env (no key crosses the webview; no
            // manual `npm run backend`).
            spawn_backend(app.handle());

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };

                // The toggle hotkey — from the config store (default ⌥Space), configurable
                // at runtime via set_config/set_toggle_hotkey. On first run, migrate the
                // legacy <app_config_dir>/hotkey file into the store.
                migrate_legacy_config(app.handle());
                // 1.2 — reconcile the OS login item with config once at startup, so it
                // matches even if the user changed it in System Settings while we were off.
                apply_autostart(app.handle(), read_config(app.handle()).launch_at_login);
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

                            // 2.1 — paste-last accelerator: re-inject the last finalized
                            // transcript into the focused field, with no backend/webview
                            // involvement. Fires on Released (like the paste-test) so the
                            // physical modifiers are up before the synthetic ⌘V. Empty/None
                            // LAST_RESULT = graceful no-op (nothing dictated yet).
                            let is_paste_last = CURRENT_PASTE_LAST
                                .lock()
                                .unwrap()
                                .as_ref()
                                .map_or(false, |t| t == shortcut);
                            if is_paste_last {
                                if event.state() == ShortcutState::Released {
                                    #[cfg(target_os = "macos")]
                                    {
                                        let last = LAST_RESULT.lock().unwrap().clone();
                                        if let Some(text) = last {
                                            if !text.trim().is_empty() {
                                                let _ = axinject::inject(&text);
                                            }
                                        }
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
                // 2.1 — register the paste-last accelerator from config (AFTER the global-
                // shortcut plugin is built, so app.global_shortcut() is available). "" = unset,
                // in which case apply_paste_last_hotkey is a no-op.
                let _ = apply_paste_last_hotkey(
                    app.handle(),
                    &read_config(app.handle()).paste_last_hotkey,
                );

                // Wave 4 — reconcile the Fn/PTT event tap from config at startup, so a user
                // who had PTT enabled gets the tap back on relaunch; a user who never enabled
                // it is never prompted for Input Monitoring. Body gated to macOS.
                #[cfg(target_os = "macos")]
                {
                    let c = read_config(app.handle());
                    fnkey::set_enabled(app.handle(), c.fn_push_to_talk, &c.ptt_key);
                }

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
            input_monitoring_trusted,
            open_input_monitoring_settings,
            request_input_monitoring,
            get_output_muted,
            set_output_muted,
            get_toggle_hotkey,
            set_toggle_hotkey,
            copy_text,
            hide_widget,
            show_settings_window,
            get_config,
            set_config,
            clear_config,
            vocab_list,
            vocab_add,
            vocab_delete,
            snip_list,
            snip_add,
            snip_delete,
            key_save,
            key_save_clipboard,
            key_get,
            key_has,
            key_delete,
            set_key,
            has_key,
            delete_key
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Verbatim widget")
        .run(|_app, event| {
            // Phase 4.8: kill the backend sidecar on exit so it never orphans / holds :8787.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                kill_backend();
            }
        });
}
