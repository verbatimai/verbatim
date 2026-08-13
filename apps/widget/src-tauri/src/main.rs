#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::time::Instant;
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

fn hotkey_config_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("hotkey"))
}

// Persisted preset id, defaulting to ⌥Space. Never fails — a missing/garbled file just
// falls back to the default so the app always has a working hotkey.
fn load_hotkey_id(app: &tauri::AppHandle) -> String {
    hotkey_config_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "alt-space".to_string())
}

fn save_hotkey_id(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let p = hotkey_config_path(app).ok_or("no config dir")?;
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(p, id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_toggle_hotkey(app: tauri::AppHandle) -> String {
    load_hotkey_id(&app)
}

#[tauri::command]
fn set_toggle_hotkey(app: tauri::AppHandle, id: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let sc = preset_shortcut(&id).ok_or_else(|| format!("unknown hotkey: {id}"))?;
        let gs = app.global_shortcut();
        // Swap the registration: drop the old toggle, register the new one, remember it so
        // the handler recognises the fired shortcut.
        if let Some(old) = CURRENT_TOGGLE.lock().unwrap().take() {
            let _ = gs.unregister(old);
        }
        gs.register(sc).map_err(|e| e.to_string())?;
        *CURRENT_TOGGLE.lock().unwrap() = Some(sc);
        save_hotkey_id(&app, &id)?;
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, id);
        Ok(())
    }
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

                // The toggle hotkey — loaded from the persisted preset (default ⌥Space),
                // configurable at runtime via set_toggle_hotkey.
                let hotkey_id = load_hotkey_id(app.handle());
                let toggle = preset_shortcut(&hotkey_id)
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
            get_toggle_hotkey,
            set_toggle_hotkey,
            copy_text,
            hide_widget,
            show_settings_window,
            key_save,
            key_save_clipboard,
            key_get,
            key_has,
            key_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Verbatim widget");
}
