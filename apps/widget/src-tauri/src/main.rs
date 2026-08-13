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
//!   text.rs       inject / copy the finalized transcript
//!   axinject.rs   macOS AX focus read + paste routing
//!   fnkey.rs      Fn / bare-modifier push-to-talk (CGEventTap)
//!   inject.rs     clipboard + ⌘V primitives
//!
//! Cross-module note: `secrets.rs` and `fnkey.rs` reach a few items as `crate::…`
//! (`read_config`, `KEYCHAIN_SERVICE`, `RECORDING`). The `pub(crate) use` re-exports
//! below keep those paths valid, so those files need no edits.

mod backend;
mod config;
mod hotkey;
mod inject;
mod keys;
mod lists;
mod secrets;
mod shortcuts;
mod state;
mod system;
mod text;
mod tray;
mod window;

#[cfg(target_os = "macos")]
mod axinject;

// Wave 4 — Fn / bare-modifier push-to-talk (listen-only CGEventTap). macOS-only.
#[cfg(target_os = "macos")]
mod fnkey;

// Re-exports that keep the pre-split `crate::…` paths working for modules that use them.
pub(crate) use config::read_config;
pub(crate) use keys::KEYCHAIN_SERVICE;
pub(crate) use state::RECORDING;

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

            // Phase 4.8: the app owns the backend — spawn + supervise it, injecting the
            // vendor keys from the secret store into its env (no key crosses the webview;
            // no manual `npm run backend`).
            backend::spawn_backend(app.handle());

            #[cfg(desktop)]
            {
                shortcuts::setup(app)?;
                tray::setup(app)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            text::inject_text,
            text::copy_text,
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
            keys::key_save,
            keys::key_save_clipboard,
            keys::key_get,
            keys::key_has,
            keys::key_delete,
            keys::set_key,
            keys::has_key,
            keys::delete_key
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
