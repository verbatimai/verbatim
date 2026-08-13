//! Text output: inject into the focused field, or fall back to the clipboard.

use crate::state::LAST_RESULT;

/// Inject the finalized text into the focused field — but only when it makes sense.
/// Returns a status the UI reacts to:
///   "inserted"  — pasted into an editable field
///   "secure"    — focused field is a password/secure field; refused, text copied instead
///   "no_field"  — nothing editable was focused; text copied to the clipboard instead
#[tauri::command]
pub fn inject_text(text: String) -> Result<String, String> {
    *LAST_RESULT.lock().unwrap() = Some(text.clone()); // remember for paste-last (2.1)
    #[cfg(target_os = "macos")]
    {
        Ok(crate::axinject::inject(&text))
    }
    #[cfg(not(target_os = "macos"))]
    {
        crate::inject::paste_text(&text)?;
        Ok("inserted".into())
    }
}

/// Copy text to the clipboard (no paste, no restore) — the reliable fallback when no
/// editable field is focused to receive an injected paste.
#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    crate::inject::copy_only(&text)
}
