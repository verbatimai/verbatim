//! Configurable global hotkeys — the dictation toggle and the 2.1 paste-last accelerator.
//!
//! The overlay is a non-key panel (can't accept typed keystrokes), so the Settings *window*
//! captures the combo and hands it here as an accelerator string. Legacy preset ids
//! ("alt-space") are still accepted for back-compat. Both accelerators are re-registered
//! live from `config::set_config`, so the shortcut handler compares the fired shortcut
//! against `CURRENT_TOGGLE` / `CURRENT_PASTE_LAST` rather than a compile-time constant.

use tauri::Manager;

/// The toggle hotkey currently registered.
#[cfg(desktop)]
pub static CURRENT_TOGGLE: std::sync::Mutex<Option<tauri_plugin_global_shortcut::Shortcut>> =
    std::sync::Mutex::new(None);

/// 2.1 — the paste-last accelerator currently registered ("" = none).
#[cfg(desktop)]
pub static CURRENT_PASTE_LAST: std::sync::Mutex<Option<tauri_plugin_global_shortcut::Shortcut>> =
    std::sync::Mutex::new(None);

/// Map a preset id → an actual Shortcut. Keep this list in sync with the buttons in the
/// Settings UI (main.ts HOTKEYS).
#[cfg(desktop)]
pub fn preset_shortcut(id: &str) -> Option<tauri_plugin_global_shortcut::Shortcut> {
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

/// Map a Web `KeyboardEvent.code` string (what the Settings UI's hotkey-capture
/// input reads, 4.7) to the matching `Code` variant. Covers what a hotkey combo
/// realistically uses — letters, digits, common punctuation, and a few named
/// keys — not the full DOM UI Events code list.
#[cfg(desktop)]
pub fn parse_code(code: &str) -> Option<tauri_plugin_global_shortcut::Code> {
    use tauri_plugin_global_shortcut::Code;
    if let Some(rest) = code.strip_prefix("Key") {
        let ch = rest.chars().next()?;
        if rest.len() == 1 && ch.is_ascii_alphabetic() {
            return Some(match ch.to_ascii_uppercase() {
                'A' => Code::KeyA, 'B' => Code::KeyB, 'C' => Code::KeyC, 'D' => Code::KeyD,
                'E' => Code::KeyE, 'F' => Code::KeyF, 'G' => Code::KeyG, 'H' => Code::KeyH,
                'I' => Code::KeyI, 'J' => Code::KeyJ, 'K' => Code::KeyK, 'L' => Code::KeyL,
                'M' => Code::KeyM, 'N' => Code::KeyN, 'O' => Code::KeyO, 'P' => Code::KeyP,
                'Q' => Code::KeyQ, 'R' => Code::KeyR, 'S' => Code::KeyS, 'T' => Code::KeyT,
                'U' => Code::KeyU, 'V' => Code::KeyV, 'W' => Code::KeyW, 'X' => Code::KeyX,
                'Y' => Code::KeyY, 'Z' => Code::KeyZ,
                _ => return None,
            });
        }
    }
    if let Some(rest) = code.strip_prefix("Digit") {
        return match rest {
            "0" => Some(Code::Digit0), "1" => Some(Code::Digit1), "2" => Some(Code::Digit2),
            "3" => Some(Code::Digit3), "4" => Some(Code::Digit4), "5" => Some(Code::Digit5),
            "6" => Some(Code::Digit6), "7" => Some(Code::Digit7), "8" => Some(Code::Digit8),
            "9" => Some(Code::Digit9),
            _ => None,
        };
    }
    if let Some(rest) = code.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u8>() {
            return match n {
                1 => Some(Code::F1), 2 => Some(Code::F2), 3 => Some(Code::F3), 4 => Some(Code::F4),
                5 => Some(Code::F5), 6 => Some(Code::F6), 7 => Some(Code::F7), 8 => Some(Code::F8),
                9 => Some(Code::F9), 10 => Some(Code::F10), 11 => Some(Code::F11), 12 => Some(Code::F12),
                _ => None,
            };
        }
    }
    match code {
        "Space" => Some(Code::Space),
        "Backquote" => Some(Code::Backquote),
        "Minus" => Some(Code::Minus),
        "Equal" => Some(Code::Equal),
        "BracketLeft" => Some(Code::BracketLeft),
        "BracketRight" => Some(Code::BracketRight),
        "Backslash" => Some(Code::Backslash),
        "Semicolon" => Some(Code::Semicolon),
        "Quote" => Some(Code::Quote),
        "Comma" => Some(Code::Comma),
        "Period" => Some(Code::Period),
        "Slash" => Some(Code::Slash),
        "Tab" => Some(Code::Tab),
        "Escape" => Some(Code::Escape),
        "Enter" => Some(Code::Enter),
        "Backspace" => Some(Code::Backspace),
        "ArrowUp" => Some(Code::ArrowUp),
        "ArrowDown" => Some(Code::ArrowDown),
        "ArrowLeft" => Some(Code::ArrowLeft),
        "ArrowRight" => Some(Code::ArrowRight),
        _ => None,
    }
}

/// Parse an accelerator captured by the Settings UI's hotkey-capture input, e.g.
/// "Alt+Space" or "Control+Shift+KeyD" (modifier names + a Web `code`, joined by
/// "+"). A legacy/preset id (e.g. "alt-space") is tried first for back-compat.
#[cfg(desktop)]
pub fn parse_accelerator(s: &str) -> Option<tauri_plugin_global_shortcut::Shortcut> {
    use tauri_plugin_global_shortcut::{Modifiers, Shortcut};
    if let Some(sc) = preset_shortcut(s) {
        return Some(sc);
    }
    let mut parts: Vec<&str> = s.split('+').map(str::trim).filter(|p| !p.is_empty()).collect();
    let code_str = parts.pop()?;
    let code = parse_code(code_str)?;
    let mut mods = Modifiers::empty();
    for p in parts {
        mods |= match p {
            "Alt" => Modifiers::ALT,
            "Control" => Modifiers::CONTROL,
            "Shift" => Modifiers::SHIFT,
            "Meta" | "Super" | "Cmd" => Modifiers::SUPER,
            _ => return None,
        };
    }
    if mods.is_empty() {
        return None; // a bare key with no modifier isn't a safe global shortcut
    }
    Some(Shortcut::new(Some(mods), code))
}

pub fn hotkey_config_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("hotkey"))
}

/// Persisted preset id, defaulting to ⌥Space. Never fails — a missing/garbled file just
/// falls back to the default so the app always has a working hotkey.
/// Superseded by the config store (4.3); kept for one release. `hotkey_config_path` is
/// still used by `config::migrate_legacy_config`.
#[allow(dead_code)]
pub fn load_hotkey_id(app: &tauri::AppHandle) -> String {
    hotkey_config_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "alt-space".to_string())
}

#[allow(dead_code)]
pub fn save_hotkey_id(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let p = hotkey_config_path(app).ok_or("no config dir")?;
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(p, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_toggle_hotkey(app: tauri::AppHandle) -> String {
    // Source of truth is now the config store (Phase 4.3).
    crate::config::read_config(&app).hotkey
}

/// Re-register the global toggle shortcut live: drop the old one, register the new preset,
/// and remember it so the handler recognises the fired shortcut. Called from set_config.
#[cfg(desktop)]
pub fn apply_hotkey(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let sc = parse_accelerator(id).ok_or_else(|| format!("unrecognized hotkey: {id}"))?;
    let gs = app.global_shortcut();
    if let Some(old) = CURRENT_TOGGLE.lock().unwrap().take() {
        let _ = gs.unregister(old);
    }
    gs.register(sc).map_err(|e| e.to_string())?;
    *CURRENT_TOGGLE.lock().unwrap() = Some(sc);
    Ok(())
}

/// 2.1 — Register / re-register the paste-last global accelerator. Unlike the toggle it
/// accepts the empty string (unset → unregister only, no error). The handler fires it on
/// Released so the physical modifiers are up before the synthetic ⌘V (matches the paste-test).
#[cfg(desktop)]
pub fn apply_paste_last_hotkey(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    if let Some(old) = CURRENT_PASTE_LAST.lock().unwrap().take() {
        let _ = gs.unregister(old);
    }
    if id.trim().is_empty() {
        return Ok(()); // "" = disabled (unregister only)
    }
    let sc = parse_accelerator(id).ok_or_else(|| format!("unrecognized hotkey: {id}"))?;
    gs.register(sc).map_err(|e| e.to_string())?;
    *CURRENT_PASTE_LAST.lock().unwrap() = Some(sc);
    Ok(())
}

#[tauri::command]
pub fn set_toggle_hotkey(app: tauri::AppHandle, id: String) -> Result<(), String> {
    // Store-backed: set_config persists the hotkey, re-registers it (apply_hotkey), and
    // emits config-changed.
    crate::config::set_config(app, serde_json::json!({ "hotkey": id })).map(|_| ())
}
