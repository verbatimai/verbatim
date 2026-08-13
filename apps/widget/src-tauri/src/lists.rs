//! Phase 3.4 / 3.5: vocabulary + snippets list stores.
//!
//! LIST data (not scalar config), so — like secrets — each lives in its OWN
//! tauri-plugin-store file (vocabulary.json / snippets.json), NOT in `AppConfig`. That
//! means Reset (`config::clear_config`) leaves them intact, matching the secrets policy.
//! The backend never reads these files; the overlay sends the lists on the WS `start` frame.

use serde::{Deserialize, Serialize};

const VOCAB_FILE: &str = "vocabulary.json";
const VOCAB_KEY: &str = "terms";
const SNIPPETS_FILE: &str = "snippets.json";
const SNIPPETS_KEY: &str = "snippets";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub trigger: String,
    pub expansion: String,
}

fn read_vocab(app: &tauri::AppHandle) -> Vec<String> {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store(VOCAB_FILE) else {
        return Vec::new();
    };
    store
        .get(VOCAB_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn write_vocab(app: &tauri::AppHandle, terms: &[String]) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(VOCAB_FILE).map_err(|e| e.to_string())?;
    store.set(VOCAB_KEY, serde_json::to_value(terms).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vocab_list(app: tauri::AppHandle) -> Vec<String> {
    read_vocab(&app)
}

#[tauri::command]
pub fn vocab_add(app: tauri::AppHandle, term: String) -> Result<Vec<String>, String> {
    let t = term.trim().to_string();
    if t.is_empty() {
        return Err("empty term".into()); // reject blanks (avoids a match-everything term)
    }
    let mut terms = read_vocab(&app);
    // Case-insensitive de-dupe so the same word isn't stored twice.
    if !terms.iter().any(|x| x.eq_ignore_ascii_case(&t)) {
        terms.push(t);
        write_vocab(&app, &terms)?;
    }
    Ok(terms)
}

#[tauri::command]
pub fn vocab_delete(app: tauri::AppHandle, term: String) -> Result<Vec<String>, String> {
    let mut terms = read_vocab(&app);
    terms.retain(|x| !x.eq_ignore_ascii_case(term.trim()));
    write_vocab(&app, &terms)?;
    Ok(terms)
}

fn read_snippets(app: &tauri::AppHandle) -> Vec<Snippet> {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store(SNIPPETS_FILE) else {
        return Vec::new();
    };
    store
        .get(SNIPPETS_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn write_snippets(app: &tauri::AppHandle, snips: &[Snippet]) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(SNIPPETS_FILE).map_err(|e| e.to_string())?;
    store.set(SNIPPETS_KEY, serde_json::to_value(snips).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn snip_list(app: tauri::AppHandle) -> Vec<Snippet> {
    read_snippets(&app)
}

#[tauri::command]
pub fn snip_add(
    app: tauri::AppHandle,
    trigger: String,
    expansion: String,
) -> Result<Vec<Snippet>, String> {
    let trig = trigger.trim().to_string();
    let exp = expansion.trim().to_string();
    // An empty/whitespace trigger would match everything — reject it (risk §3.5).
    if trig.is_empty() || exp.is_empty() {
        return Err("trigger and expansion are required".into());
    }
    let mut snips = read_snippets(&app);
    // Replace an existing trigger (case-insensitive) rather than duplicating it.
    snips.retain(|s| !s.trigger.eq_ignore_ascii_case(&trig));
    snips.push(Snippet { trigger: trig, expansion: exp });
    write_snippets(&app, &snips)?;
    Ok(snips)
}

#[tauri::command]
pub fn snip_delete(app: tauri::AppHandle, trigger: String) -> Result<Vec<Snippet>, String> {
    let mut snips = read_snippets(&app);
    snips.retain(|s| !s.trigger.eq_ignore_ascii_case(trigger.trim()));
    write_snippets(&app, &snips)?;
    Ok(snips)
}
