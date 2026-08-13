//! Windows & panels: the non-activating overlay, and the focusable app/settings window.

use tauri::Manager;

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

/// Phase 7 (Fix 3) — map the `dock_icon` config flag to a macOS activation policy.
/// `Regular` = the app shows a Dock icon and can become frontmost / join the app
/// switcher; `Accessory` = menu-bar-only, no Dock icon. This is ORTHOGONAL to the
/// overlay's non-activating/non-key behaviour, which comes from the SpikePanel class
/// (NonactivatingPanel style mask + can_become_key_window:false), so injection must
/// keep working under `Regular` — see docs/product/settings/phase-7-plan.md Fix 3.
#[cfg(target_os = "macos")]
pub fn desired_activation_policy(dock_icon: bool) -> tauri::ActivationPolicy {
    if dock_icon {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    }
}

#[cfg(target_os = "macos")]
pub fn configure_non_activating_panel(app: &mut tauri::App) {
    // `objc2_app_kit` is re-exported by tauri-nspanel, so we use its exact version
    // (a separately-added objc2-app-kit dep would be a different type → E0308).
    use tauri_nspanel::{
        objc2_app_kit::{NSWindowCollectionBehavior, NSWindowStyleMask},
        WebviewWindowExt,
    };

    // Phase 7 (Fix 3) — honour the configured `dock_icon` at startup (default false ⇒
    // Accessory: no Dock icon, app never becomes frontmost). The panel reclass + style
    // mask below keep the overlay non-activating regardless of the policy chosen here.
    let _ = app.set_activation_policy(desired_activation_policy(
        crate::config::read_config(app.handle()).dock_icon,
    ));

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

// ── Phase 4.2: the focusable app window (hosts History + the Settings tab) ─────
// The overlay ("main") is a non-key NSPanel and can never accept typed input — that's
// what lets injected text land in the app underneath. The app window (label "settings",
// loading app.html) is an ordinary focusable NSWindow. A menu-bar app runs as `Accessory`
// (no Dock icon, never frontmost, so the overlay never steals focus); to give this window
// keyboard focus we must briefly switch the app to `Regular`, then revert to `Accessory`
// when it closes (see `register_settings_close_handler`). The overlay panel stays non-key.
//
// The window loads the main app shell (app.html). The tray/hotkey "Settings…" entrypoint
// deep-links to the in-app Settings tab (settings.html) before showing, so it lands there
// with no visible History flash; "Back to app" inside returns to History.
pub fn open_settings_window(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    let win = app
        .get_webview_window("settings")
        .ok_or_else(|| "no 'settings' window".to_string())?;
    // Route to the Settings surface while still hidden (avoids a History flash on open).
    let _ = win.eval(
        "if(!location.pathname.endsWith('/settings.html')){location.replace('/settings.html');}",
    );
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn show_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    open_settings_window(&app)
}

/// Hide the overlay (auto-hide after inserting, Wispr-style).
#[tauri::command]
pub fn hide_widget(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// Phase 4.2: closing the Settings window HIDES it (keeps it for a fast reopen)
/// and reverts the activation policy — the app must NOT quit when settings closes
/// (it's a menu-bar app; the tray keeps it alive). The overlay is untouched.
pub fn register_settings_close_handler(app: &tauri::App) {
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
                let _ = app_h.set_activation_policy(desired_activation_policy(
                    crate::config::read_config(&app_h).dock_icon,
                ));
            }
        });
    }
}
