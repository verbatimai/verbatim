#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

mod inject;

#[tauri::command]
fn inject_text(text: String) -> Result<(), String> {
    inject::paste_text(&text)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

                // ⌥Space toggles the widget window.
                let toggle = Shortcut::new(Some(Modifiers::ALT), Code::Space);
                let toggle_for_handler = toggle;

                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if shortcut == &toggle_for_handler && event.state() == ShortcutState::Pressed {
                                if let Some(win) = app.get_webview_window("main") {
                                    let visible = win.is_visible().unwrap_or(false);
                                    if visible {
                                        let _ = win.hide();
                                    } else {
                                        let _ = win.show();
                                        let _ = win.set_focus();
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
        .invoke_handler(tauri::generate_handler![inject_text])
        .run(tauri::generate_context!())
        .expect("error while running the Open Dictation widget");
}
