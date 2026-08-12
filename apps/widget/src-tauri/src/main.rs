#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

mod inject;

#[cfg(target_os = "macos")]
mod axinject;

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
    use tauri_nspanel::{objc2_app_kit::NSWindowStyleMask, WebviewWindowExt};

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

                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if shortcut == &toggle_for_handler
                                && event.state() == ShortcutState::Pressed
                            {
                                if let Some(win) = app.get_webview_window("main") {
                                    let visible = win.is_visible().unwrap_or(false);
                                    if visible {
                                        let _ = win.hide();
                                    } else {
                                        // Show WITHOUT set_focus — a non-activating,
                                        // non-key panel must appear without stealing
                                        // focus/keyboard from the active app.
                                        let _ = win.show();
                                    }
                                }
                            }
                        })
                        .build(),
                )?;

                app.global_shortcut().register(toggle)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            inject_text,
            open_mic_settings,
            open_accessibility_settings,
            copy_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Open Dictation widget");
}
