//! Notes: an unbounded, plain-text scratchpad. Any historical (History tab row) or current
//! (overlay Final Output) dictation can be saved here via `note_add`.
//!
//! LIST data, so — like history/vocabulary/snippets — it lives in its OWN tauri-plugin-store
//! file (`notes.json`), NOT in `AppConfig`. Unlike `history.rs`, there is NO cap: notes are a
//! deliberate save, not an automatic capture, so nothing here is ever dropped silently.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

const NOTES_FILE: &str = "notes.json";
const NOTES_KEY: &str = "notes";

static SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub text: String,
    pub created_at: i64, // unix epoch millis
    pub updated_at: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_notes(app: &tauri::AppHandle) -> Vec<Note> {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store(NOTES_FILE) else {
        return Vec::new();
    };
    store
        .get(NOTES_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn write_notes(app: &tauri::AppHandle, notes: &[Note]) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(NOTES_FILE).map_err(|e| e.to_string())?;
    store.set(NOTES_KEY, serde_json::to_value(notes).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

/// Newest-updated-first.
#[tauri::command]
pub fn note_list(app: tauri::AppHandle) -> Vec<Note> {
    let mut notes = read_notes(&app);
    notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    notes
}

/// Save `text` (a History row, the overlay's current output, or a blank "+ New note") as a
/// new note. No de-dupe — saving the same dictation twice is a valid, expected use (Keep
/// allows duplicate notes too).
#[tauri::command]
pub fn note_add(app: tauri::AppHandle, text: String) -> Result<Note, String> {
    let mut notes = read_notes(&app);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let now = now_ms();
    let note = Note {
        id: format!("{}-{}", now, seq),
        text,
        created_at: now,
        updated_at: now,
    };
    notes.push(note.clone());
    write_notes(&app, &notes)?;
    let _ = app.emit("notes-changed", ());
    Ok(note)
}

#[tauri::command]
pub fn note_update(app: tauri::AppHandle, id: String, text: String) -> Result<(), String> {
    let mut notes = read_notes(&app);
    let Some(note) = notes.iter_mut().find(|n| n.id == id) else {
        return Err("note not found".into());
    };
    note.text = text;
    note.updated_at = now_ms();
    write_notes(&app, &notes)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
pub fn note_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut notes = read_notes(&app);
    notes.retain(|n| n.id != id);
    write_notes(&app, &notes)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}
