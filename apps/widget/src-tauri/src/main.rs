#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Verbatim widget — Tauri host.
//!
//! This file is deliberately thin: it declares the modules, wires the Tauri builder, and
//! lists the commands. Everything else lives in a focused module:
//!
//!   state.rs      dictation state statics (RECORDING / PRESS_AT / LAST_RESULT)
//!   config.rs     AppConfig + the settings.json store (get/set/clear/migrate)
//!   lists.rs      vocabulary + snippets list stores
//!   keys.rs       BYOK vendor API-key commands (routed through secrets.rs)
//!   secrets.rs    the storage adapter behind keys.rs (local 0600 file | OS keychain)
//!   backend.rs    the app-owned backend sidecar (spawn / kill / restart, env injection)
//!   hotkey.rs     accelerator parsing + live (re-)registration of the global shortcuts
//!   shortcuts.rs  global-shortcut handler: the tap/hold dictation state machine
//!   window.rs     the non-activating NSPanel overlay + the focusable app/settings window
//!   tray.rs       the menu-bar icon and its menu
//!   system.rs     macOS privacy panes, permission status, output muting
//!   testkey.rs    O6 build-time PyAI test key (option_env!) — internal builds only
//!   verify.rs     O2 API-key verification: one authenticated GET per vendor (ureq)
//!   text.rs       inject / copy the finalized transcript
//!   axinject.rs   macOS AX focus read + paste routing
//!   fnkey.rs      Fn / bare-modifier push-to-talk (CGEventTap)
//!   inject.rs     clipboard + ⌘V primitives
//!   command.rs    P1 command-mode executor (CommandIntent → enigo keystrokes)
//!   syscommand.rs P2 system commands (CommandIntent → open / osascript / shortcuts)
//!
//! Cross-module note: `secrets.rs` and `fnkey.rs` reach a few items as `crate::…`
//! (`read_config`, `KEYCHAIN_SERVICE`, `RECORDING`). The `pub(crate) use` re-exports
//! below keep those paths valid, so those files need no edits.

mod backend;
mod command;
mod config;
mod download;
mod history;
mod hotkey;
mod inject;
mod keys;
mod lists;
mod notes;
mod secrets;
mod shortcuts;
mod state;
mod system;
mod testkey;
mod text;
mod tray;
mod verify;
mod window;

#[cfg(target_os = "macos")]
mod axinject;

// P2 — system commands delegated to macOS (open / osascript / shortcuts). macOS-only: it
// drives macOS binaries and reuses `system::set_output_muted`. `run_command` (already listed
// in the invoke_handler) dispatches to it; no new tauri command is registered.
#[cfg(target_os = "macos")]
mod syscommand;

// Wave 4 — Fn / bare-modifier push-to-talk (listen-only CGEventTap). macOS-only.
#[cfg(target_os = "macos")]
mod fnkey;

// P3 — always-on on-device wake-word listener (openWakeWord via cpal + ort). macOS-only:
// it owns an independent cpal capture and fires the SAME activation seam as the hotkeys.
#[cfg(target_os = "macos")]
mod wake;

// Local Nemotron ASR — persistent NeMo-Speech.cpp worker (Metal on Apple Silicon).
#[cfg(target_os = "macos")]
mod asr;

// Re-exports that keep the pre-split `crate::…` paths working for modules that use them.
pub(crate) use config::read_config;
pub(crate) use keys::KEYCHAIN_SERVICE;
pub(crate) use state::RECORDING;
// P3 — re-export COMMAND_RECORDING for symmetry with RECORDING, so wake.rs reaches both
// session flags as `crate::…` for the self-trigger gate + the command-handler start.
pub(crate) use state::COMMAND_RECORDING;

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
            window::configure_non_activating_panel(app);

            window::register_settings_close_handler(app);
            window::register_onboarding_close_handler(app);
            // O6 — internal builds only: retitle the onboarding window so a leaked .app is
            // identifiable. No-op when the build holds no test key.
            testkey::watermark_title(app.handle());

            // Phase 4.8: the app owns the backend — spawn + supervise it, injecting the
            // vendor keys from the secret store into its env (no key crosses the webview;
            // no manual `npm run backend`).
            backend::spawn_backend(app.handle());

            #[cfg(target_os = "macos")]
            asr::init_at_launch(app.handle());

            #[cfg(desktop)]
            {
                shortcuts::setup(app)?;
                tray::setup(app)?;
            }

            // First-run onboarding (O5): open it only for a user who has never made a
            // choice AND has no key. `setup_state` stops the nag once they pick "Set up
            // later"/"Done"; `any_vendor_key_saved` stays as the self-healing guard, so an
            // existing keyed install is never prompted (see keys::any_vendor_key_saved).
            let cfg = config::read_config(app.handle());
            if cfg.setup_state == "unseen" && !keys::any_vendor_key_saved(app.handle()) {
                let _ = window::open_onboarding_window(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            text::inject_text,
            text::copy_text,
            text::set_last_raw,
            text::revert_to_raw,
            system::open_mic_settings,
            system::open_accessibility_settings,
            system::ax_trusted,
            system::input_monitoring_trusted,
            system::open_input_monitoring_settings,
            system::request_input_monitoring,
            system::get_output_muted,
            system::set_output_muted,
            hotkey::get_toggle_hotkey,
            hotkey::set_toggle_hotkey,
            hotkey::get_command_hotkey,
            hotkey::set_command_hotkey,
            command::run_command,
            // P1c — the two-phase rewrite round trip (read selection / paste result back);
            // the backend LLM call itself happens over the WS, not a tauri command.
            command::get_command_selection,
            command::paste_rewrite,
            state::clear_recording_state,
            window::hide_widget,
            window::show_settings_window,
            config::get_config,
            config::set_config,
            config::clear_config,
            lists::vocab_list,
            lists::vocab_add,
            lists::vocab_delete,
            lists::snip_list,
            lists::snip_add,
            lists::snip_delete,
            history::history_list,
            history::history_delete,
            history::history_clear,
            notes::note_list,
            notes::note_add,
            notes::note_update,
            notes::note_delete,
            keys::key_save,
            keys::key_save_clipboard,
            keys::key_get,
            keys::key_has,
            keys::key_delete,
            keys::set_key,
            keys::has_key,
            keys::delete_key,
            verify::key_verify,
            testkey::test_key_available,
            testkey::use_test_key,
            window::finish_onboarding,
            window::show_onboarding_window,
            #[cfg(target_os = "macos")]
            wake::wake_mic_status,
            #[cfg(target_os = "macos")]
            asr::asr_get_metrics,
            #[cfg(target_os = "macos")]
            asr::asr_get_status,
            #[cfg(target_os = "macos")]
            asr::asr_start_native_session,
            #[cfg(target_os = "macos")]
            asr::asr_stop_native_session,
            #[cfg(target_os = "macos")]
            asr::asr_ipc_port,
            #[cfg(target_os = "macos")]
            asr::asr_get_download_status,
            #[cfg(target_os = "macos")]
            asr::asr_download_model
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Verbatim widget")
        .run(|_app, event| {
            // Phase 4.8: kill the backend sidecar on exit so it never orphans / holds :8787.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                backend::kill_backend();
            }
        });
}
