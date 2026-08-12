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

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };

                // ⌥Space toggles the widget window.
                let toggle = Shortcut::new(Some(Modifiers::ALT), Code::Space);
                let toggle_for_handler = toggle;

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

                            if shortcut != &toggle_for_handler {
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
                        "Show Open Dictation  (⌥Space)",
                        true,
                        None::<&str>,
                    )?;
                    let quit_i =
                        MenuItem::with_id(h, "quit", "Quit Open Dictation", true, None::<&str>)?;
                    let menu = Menu::with_items(h, &[&show_i, &quit_i])?;
                    let icon = app.default_window_icon().cloned();
                    let mut tray = TrayIconBuilder::with_id("main-tray")
                        .tooltip("Open Dictation — press ⌥Space to dictate")
                        .menu(&menu)
                        .on_menu_event(|app, event| match event.id.as_ref() {
                            "show" => {
                                if let Some(w) = app.get_webview_window("main") {
                                    let _ = w.show();
                                }
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
            copy_text,
            hide_widget
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Open Dictation widget");
}
