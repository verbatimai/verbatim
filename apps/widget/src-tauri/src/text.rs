//! Text output: inject into the focused field, or fall back to the clipboard.

use crate::state::{LAST_RAW, LAST_RESULT};

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

/// 5.4 — record the last RAW (uncorrected) transcript for revert-to-raw. Called by the
/// webview when the backend delivers the correction frame's `raw`.
#[tauri::command]
pub fn set_last_raw(text: String) {
    *LAST_RAW.lock().unwrap() = Some(text);
}

/// 5.4 — re-inject the last RAW transcript into the focused field (undo an over-eager
/// correction). Best-effort: same routing / secure-field refusal as inject_text; a no-op
/// ("no_raw") when nothing has been dictated yet.
#[tauri::command]
pub fn revert_to_raw() -> Result<String, String> {
    let raw = LAST_RAW.lock().unwrap().clone();
    let Some(text) = raw else { return Ok("no_raw".into()); };
    if text.trim().is_empty() {
        return Ok("no_raw".into());
    }
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
