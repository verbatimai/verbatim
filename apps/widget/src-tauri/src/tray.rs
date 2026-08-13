//! Menu-bar (tray) icon — the always-visible "the widget is available" indicator,
//! since the overlay stays hidden until summoned. ⌥Space (or the menu's "Show")
//! opens the dictation UI.

#[cfg(desktop)]
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;
    use tauri::{Emitter, Manager};

    let h = app.handle();
    let show_i = MenuItem::with_id(h, "show", "Show Verbatim  (⌥Space)", true, None::<&str>)?;
    let last_i = MenuItem::with_id(h, "last", "Show Last Result", true, None::<&str>)?;
    let settings_i = MenuItem::with_id(h, "settings", "Settings…", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(h, "quit", "Quit Verbatim", true, None::<&str>)?;
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
