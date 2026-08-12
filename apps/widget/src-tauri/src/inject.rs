// Text injection via clipboard + synthetic Cmd+V — the universal fallback path (works
// wherever ⌘V works). A cleaner AX-write path (kAXSelectedText) can be added later; for
// now paste is the injection mechanism and AX is used only to decide WHETHER to paste.
//
// NOTE: posting keystrokes on macOS requires Accessibility permission
// (System Settings → Privacy & Security → Accessibility). enigo silently no-ops until
// granted.
use arboard::Clipboard;
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::{thread, time::Duration};

pub fn paste_text(text: &str) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| format!("clipboard: {e}"))?;
    let previous = clipboard.get_text().ok(); // snapshot to restore afterward

    clipboard
        .set_text(text.to_string())
        .map_err(|e| format!("clipboard set: {e}"))?;

    // Give the target app a beat to be ready / focus to settle.
    thread::sleep(Duration::from_millis(120));

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo: {e}"))?;
    enigo.key(Key::Meta, Direction::Press).map_err(|e| e.to_string())?;
    enigo.key(Key::Unicode('v'), Direction::Click).map_err(|e| e.to_string())?;
    enigo.key(Key::Meta, Direction::Release).map_err(|e| e.to_string())?;

    // Restore the previous clipboard contents after the paste lands.
    thread::sleep(Duration::from_millis(150));
    if let Some(prev) = previous {
        let _ = clipboard.set_text(prev);
    }
    Ok(())
}

// Put text on the clipboard and LEAVE it there (no paste, no restore) — the safe path
// when there's no editable field to paste into, or a secure field we refuse to touch.
pub fn copy_only(text: &str) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| format!("clipboard: {e}"))?;
    clipboard
        .set_text(text.to_string())
        .map_err(|e| format!("clipboard set: {e}"))
}
