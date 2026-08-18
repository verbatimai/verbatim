//! Menu-bar (tray) icon — the always-visible "the widget is available" indicator,
//! since the overlay stays hidden until summoned. The configured hotkey (or the menu's
//! "Show") opens the dictation UI.
//!
//! The menu is REBUILT rather than built once, because two of its labels depend on live
//! config: the show item spells out the configured hotkey, and "Finish setup…" exists only
//! while onboarding is unfinished. `refresh_menu` is called by
//! `window::finish_onboarding` (docs/onboarding/implementation-plan.md B5).

/// Mirror of `describeHotkey` in apps/widget/src/settings.ts:432-449. Duplicated on
/// purpose: that code lives in the webview and cannot be imported here — same precedent as
/// settings.ts duplicating `VENDOR_ENV` from keys.rs. Keep the two in sync.
/// Presets match `hotkey::preset_shortcut` (hotkey.rs:35-46).
#[cfg(desktop)]
fn hotkey_glyph(id: &str) -> String {
    let preset = match id {
        "alt-space" => Some("⌥Space"),
        "ctrl-space" => Some("⌃Space"),
        "cmd-shift-d" => Some("⌘⇧D"),
        "ctrl-alt-d" => Some("⌃⌥D"),
        "alt-grave" => Some("⌥`"),
        _ => None,
    };
    if let Some(g) = preset {
        return g.to_string();
    }
    // A captured accelerator, e.g. "Alt+Shift+KeyD" -> "⌥⇧D".
    let mut parts: Vec<&str> = id.split('+').collect();
    let code = parts.pop().unwrap_or("");
    let mut out = String::new();
    for p in parts {
        out.push_str(match p {
            "Alt" => "⌥",
            "Control" => "⌃",
            "Shift" => "⇧",
            "Meta" | "Super" | "Cmd" => "⌘",
            other => other,
        });
    }
    let key = if let Some(rest) = code.strip_prefix("Key") {
        rest
    } else if let Some(rest) = code.strip_prefix("Digit") {
        rest
    } else {
        code
    };
    out.push_str(key);
    out
}

/// Build the menu from the CURRENT config. Called by `setup` at launch and by
/// `refresh_menu` whenever a label's underlying state changed.
#[cfg(desktop)]
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{IsMenuItem, Menu, MenuItem};

    let cfg = crate::config::read_config(app);
    // `with_id`'s text and accelerator share one generic parameter, so the text must be a
    // &str here to unify with `None::<&str>` (same shape as every other item below).
    let show_label = format!("Show Verbatim  ({})", hotkey_glyph(&cfg.hotkey));
    let show_i = MenuItem::with_id(app, "show", show_label.as_str(), true, None::<&str>)?;
    let last_i = MenuItem::with_id(app, "last", "Show Last Result", true, None::<&str>)?;
    let settings_i = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit Verbatim", true, None::<&str>)?;
    // Onboarding O5 — the re-entry path for anyone who chose "Set up later" (or closed the
    // window with the red X, which leaves setup_state at "unseen" on purpose). Gone once
    // setup_state == "done".
    let finish_i = if cfg.setup_state == "done" {
        None
    } else {
        Some(MenuItem::with_id(
            app,
            "finishSetup",
            "Finish setup…",
            true,
            None::<&str>,
        )?)
    };

    let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> = vec![&show_i, &last_i];
    if let Some(f) = finish_i.as_ref() {
        items.push(f); // above "settings"
    }
    items.push(&settings_i);
    items.push(&quit_i);
    Menu::with_items(app, &items)
}

/// Swap the live menu for a freshly-built one. Best-effort: a menu that can't be rebuilt
/// leaves the previous one in place (worst case the "Finish setup…" item lingers until the
/// next launch — implementation-plan.md §8 R9's accepted degradation).
#[cfg(desktop)]
pub fn refresh_menu(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Ok(menu) = build_menu(app) else {
        return;
    };
    // Id must match TrayIconBuilder::with_id below.
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_menu(Some(menu));
    }
}

#[cfg(not(desktop))]
pub fn refresh_menu(_app: &tauri::AppHandle) {}

#[cfg(desktop)]
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::tray::TrayIconBuilder;
    use tauri::{Emitter, Manager};

    let h = app.handle();
    let menu = build_menu(h)?;
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
            "finishSetup" => {
                // Onboarding O5 — reopen the first-run window (it is hidden, never
                // destroyed, so this is the same webview the user left).
                let _ = crate::window::open_onboarding_window(app);
            }
            "settings" => {
                // Phase 4.2: open the real, focusable Settings window
                // (was: show the overlay + emit "open-settings" for the
                // inline panel — that path is removed in 4.9).
                let _ = crate::window::open_settings_window(app);
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(ic) = icon {
        tray = tray.icon(ic);
    }
    let _tray = tray.build(h)?;
    Ok(())
}
