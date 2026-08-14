//! Dictation history: last-N recall / quick-copy store.
//!
//! LIST data, so — like vocabulary/snippets (`lists.rs`) — it lives in its OWN
//! tauri-plugin-store file (`history.json`), NOT in `AppConfig`. That means Reset
//! (`config::clear_config`) leaves it intact.
//!
//! Storage cap is decoupled from the user-facing display limit (`AppConfig::history_limit`,
//! 10/20/50): we always persist up to `MAX_STORED` (the largest selectable N) entries, oldest
//! dropped first, and `history_list` slices to the *current* `history_limit` at read time.
//! That way lowering the limit never deletes data — raising it again brings older entries back.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

const HISTORY_FILE: &str = "history.json";
const HISTORY_KEY: &str = "entries";
const MAX_STORED: usize = 50; // largest selectable history_limit — see module doc.

static SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub text: String,
    pub timestamp: i64, // unix epoch millis
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_entries(app: &tauri::AppHandle) -> Vec<HistoryEntry> {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store(HISTORY_FILE) else {
        return Vec::new();
    };
    store
        .get(HISTORY_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn write_entries(app: &tauri::AppHandle, entries: &[HistoryEntry]) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(HISTORY_FILE).map_err(|e| e.to_string())?;
    store.set(HISTORY_KEY, serde_json::to_value(entries).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

/// Called from `text::inject_text` for every finalized, non-empty transcript. Newest-first,
/// capped at `MAX_STORED` (oldest dropped). Best-effort: a store-write failure here must not
/// break the insert/copy path, so callers ignore the Result.
pub fn record(app: &tauri::AppHandle, text: &str) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(());
    }
    let mut entries = read_entries(app);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    entries.insert(0, HistoryEntry {
        id: format!("{}-{}", now_ms(), seq),
        text: text.to_string(),
        timestamp: now_ms(),
    });
    entries.truncate(MAX_STORED);
    write_entries(app, &entries)?;
    let _ = app.emit("history-changed", ());
    Ok(())
}

/// Returns the newest `history_limit` entries (per current config), newest-first.
#[tauri::command]
pub fn history_list(app: tauri::AppHandle) -> Vec<HistoryEntry> {
    let limit = crate::config::read_config(&app).history_limit as usize;
    let mut entries = read_entries(&app);
    entries.truncate(limit);
    entries
}

#[tauri::command]
pub fn history_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut entries = read_entries(&app);
    entries.retain(|e| e.id != id);
    write_entries(&app, &entries)?;
    let _ = app.emit("history-changed", ());
    Ok(())
}

#[tauri::command]
pub fn history_clear(app: tauri::AppHandle) -> Result<(), String> {
    write_entries(&app, &[])?;
    let _ = app.emit("history-changed", ());
    Ok(())
}
