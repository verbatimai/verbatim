//! Global-shortcut registration and the dictation state machine.
//!
//! Three accelerators share one handler:
//!   • the configurable dictation toggle (tap = toggle, hold ≥ HOLD_MS = push-to-talk)
//!   • ⌥⇧V — the demo/paste test (no backend, no webview)
//!   • the 2.1 paste-last accelerator (re-inject the last finalized transcript)
//! The toggle and paste-last are compared against `hotkey::CURRENT_*` rather than a
//! captured constant, because both can be re-registered at runtime from Settings.

#[cfg(desktop)]
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use std::time::Instant;
    use tauri::{Emitter, Manager};
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

    use crate::config::{apply_autostart, migrate_legacy_config, read_config};
    use crate::hotkey::{apply_command_hotkey, apply_paste_last_hotkey, apply_revert_raw_hotkey, parse_accelerator, CURRENT_COMMAND, CURRENT_PASTE_LAST, CURRENT_REVERT_RAW, CURRENT_TOGGLE};
    use crate::state::{COMMAND_PRESS_AT, COMMAND_RECORDING, COMMAND_STARTED, HOLD_MS, LAST_RAW, LAST_RESULT, PRESS_AT, RECORDING, STARTED_THIS_PRESS};

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
                            const DEMO: &str = "The quick brown fox jumps over the lazy dog.";
                            eprintln!("[axinject] === TEST PASTE hotkey (demo, no backend) ===");
                            let status = crate::axinject::inject(DEMO);
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
                                    let _ = crate::axinject::inject(&text);
                                }
                            }
                        }
                    }
                    return;
                }

                // 5.4 — revert-to-raw accelerator: re-inject the last RAW (uncorrected)
                // transcript, for when the correction/format pass over-edited. Same
                // no-webview path as paste-last; empty/None LAST_RAW = graceful no-op.
                let is_revert_raw = CURRENT_REVERT_RAW
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map_or(false, |t| t == shortcut);
                if is_revert_raw {
                    if event.state() == ShortcutState::Released {
                        #[cfg(target_os = "macos")]
                        {
                            let last = LAST_RAW.lock().unwrap().clone();
                            if let Some(text) = last {
                                if !text.trim().is_empty() {
                                    let _ = crate::axinject::inject(&text);
                                }
                            }
                        }
                    }
                    return;
                }

                // P1 — command-mode accelerator: same tap/hold state machine as
                // dictation, but driving the separate COMMAND_* statics and emitting
                // `command` start/stop (the webview runs the same audio session, then
                // routes the classified intent through run_command). Compared against
                // CURRENT_COMMAND so it can be re-registered at runtime.
                let is_command = CURRENT_COMMAND
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map_or(false, |t| t == shortcut);
                if is_command {
                    match event.state() {
                        ShortcutState::Pressed => {
                            #[cfg(target_os = "macos")]
                            crate::axinject::probe();

                            *COMMAND_PRESS_AT.lock().unwrap() = Some(Instant::now());
                            let was_recording = *COMMAND_RECORDING.lock().unwrap();
                            if was_recording {
                                *COMMAND_RECORDING.lock().unwrap() = false;
                                *COMMAND_STARTED.lock().unwrap() = false;
                                let _ = app.emit("command", "stop");
                            } else {
                                if let Some(win) = app.get_webview_window("main") {
                                    let _ = win.show();
                                }
                                *COMMAND_RECORDING.lock().unwrap() = true;
                                *COMMAND_STARTED.lock().unwrap() = true;
                                let _ = app.emit("command", "start");
                            }
                        }
                        ShortcutState::Released => {
                            let held = COMMAND_PRESS_AT
                                .lock()
                                .unwrap()
                                .map(|t| t.elapsed().as_millis())
                                .unwrap_or(0);
                            let started = {
                                let mut s = COMMAND_STARTED.lock().unwrap();
                                let v = *s;
                                *s = false;
                                v
                            };
                            if started && held >= HOLD_MS {
                                *COMMAND_RECORDING.lock().unwrap() = false;
                                let _ = app.emit("command", "stop");
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
                        crate::axinject::probe();

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
    let _ = apply_paste_last_hotkey(app.handle(), &read_config(app.handle()).paste_last_hotkey);
    // 5.4 — register the revert-to-raw accelerator from config ("" = unset → no-op).
    let _ = apply_revert_raw_hotkey(app.handle(), &read_config(app.handle()).revert_raw_hotkey);
    // P1 — register the command-mode accelerator from config ("" = unset → no-op).
    let _ = apply_command_hotkey(app.handle(), &read_config(app.handle()).command_hotkey);

    // Wave 4 — reconcile the Fn/PTT event tap from config at startup, so a user
    // who had PTT enabled gets the tap back on relaunch; a user who never enabled
    // it is never prompted for Input Monitoring. Body gated to macOS.
    #[cfg(target_os = "macos")]
    {
        let c = read_config(app.handle());
        crate::fnkey::set_enabled(app.handle(), c.fn_push_to_talk, &c.ptt_key);
        // P3 — reconcile the wake-word listener at startup: starts cpal + the ONNX
        // sessions ONLY if wake_word_enabled, so a user who never enables it is never
        // prompted for the mic and the orange dot never appears.
        crate::wake::set_enabled(app.handle(), c.wake_word_enabled, &c);
    }

    Ok(())
}
