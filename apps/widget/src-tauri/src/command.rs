//! P1 — command-mode executor.
//!
//! The classifier (packages/core/src/command, runs in the backend) turns one spoken
//! command into a single, validated `CommandIntent`. The webview hands that intent to this
//! deterministic executor via `invoke("run_command", { intent })`, and it performs ONE
//! editing action on the focused field using synthetic keystrokes (enigo — the same
//! mechanism as the paste path in `inject.rs`/`text.rs`).
//!
//! Safety: a wrong keystroke edits the user's document, so `run_command` refuses (returns a
//! status, emits nothing) whenever `axinject::focus_route()` is anything but a confirmed
//! editable field — no access, a secure/password field, or no field at all. This mirrors
//! `axinject::inject`'s secure-field refusal, but for keystroke commands rather than paste.
//!
//! Wire contract: the serde enum below MUST mirror the TS `CommandIntent` union
//! (packages/core/src/command/types.ts). The two `insert` shapes there share
//! `action:"insert"`, which a single `#[serde(tag="action")]` variant can't split, so they
//! collapse into one `Insert { what, text }` and branch on `what` at runtime. The shared
//! fixture (packages/core/src/command/fixtures.ts) is round-tripped by both a TS test and
//! the `#[cfg(test)]` module here, so the two definitions can't silently diverge.
//!
//! P1c exception: a `Rewrite` intent is NOT run through `run_command` — the transformation
//! is open-ended (a spoken instruction, not a fixed keystroke) and needs an LLM round-trip
//! through the backend, which this module has no key/network client for. The frontend
//! instead drives `get_command_selection` (read the target text) and `paste_rewrite` (paste
//! the backend's result back) directly — see the "P1c — rewrite" section below. `Rewrite`
//! still lives in the enum so the TS<->Rust fixture stays in lockstep.

// enigo keystroke emission is macOS-only here (the app is macOS-first, and the focus route
// that guards it only exists on macOS). The serde types stay cross-platform so the command
// signature and the serde tests compile everywhere.
#[cfg(target_os = "macos")]
use enigo::{Direction, Enigo, Key, Keyboard, Settings};

#[derive(serde::Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Style {
    Bold,
    Italic,
    Underline,
}

#[derive(serde::Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CaseMode {
    Upper,
    Lower,
    Title,
}

#[derive(serde::Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Target {
    Selection,
    LastWord,
    LastSentence,
    All,
}

/// P2 — the CLOSED set of system-volume directions. Mirrors the TS `VolumeDir`
/// (packages/core/src/command/grammar.ts VOLUME_DIRS); serde rejects any other string,
/// so the executor never sees a direction outside this enum.
#[derive(serde::Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum VolumeDir {
    Up,
    Down,
    Mute,
    Unmute,
}

/// The CLOSED set of field-scoped editing actions, internally tagged by `action` and
/// kebab-cased to match the wire values (`last-word`, `bold`, `upper`, …). The two TS
/// `insert` variants (`newline` / `literal`+`text`) collapse here into one, branched on
/// `what` in `execute`.
#[derive(serde::Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum CommandIntent {
    Format {
        style: Style,
        target: Target,
    },
    Delete {
        target: Target,
    },
    Case {
        mode: CaseMode,
        target: Target,
    },
    Select {
        target: Target,
    },
    Insert {
        what: String,
        #[serde(default)]
        text: Option<String>,
    },
    // P1c — free-form rewrite of the target text, driven by a spoken instruction (e.g.
    // "make this more formal"). Unlike every other field-edit variant, this is NOT a
    // single deterministic keystroke: the transformation itself is open-ended, so
    // execution is a two-phase round trip the FRONTEND drives directly —
    // `get_command_selection` (read the target text) -> one LLM call in the backend,
    // using whichever vendor/model is already the correction provider -> `paste_rewrite`
    // (paste the result back) — rather than a single `run_command` call. The variant
    // still lives in this enum purely for the TS<->Rust serde-contract fixture parity
    // (see the `#[cfg(test)]` module below); `execute()` never truly dispatches it.
    Rewrite {
        instruction: String,
        target: Target,
    },
    // P2 — system commands (delegated to macOS in syscommand.rs, gated behind
    // config.system_commands). These do NOT act on the focused field, so they bypass the
    // `focus_route()` guard in `route_and_execute`.
    Launch {
        app: String,
    },
    Volume {
        direction: VolumeDir,
    },
    Shortcut {
        name: String,
    },
    Noop {
        reason: String,
    },
}

/// Execute one classified command on the focused field.
///
/// Returns a status string the webview routes exactly like `inject_text`'s result:
///   "done"      — the action was performed
///   "noop"      — nothing to do (a `noop` intent, or a best-effort action with no target)
///   "no_access"   — Accessibility not granted (text/keys can't be posted)
///   "secure"      — a password / secure field; refused
///   "no_field"    — nothing editable was focused; refused
///   "disabled"    — a system command while `config.system_commands` is off (P2)
///   "unavailable" — a system command whose macOS facility is missing (e.g. no `shortcuts` CLI)
///
/// (finding 1) The `AppHandle` is threaded through so the system-command gate can read
/// `read_config(&app).system_commands`; Tauri v2 auto-injects it, so the JS
/// `invoke("run_command",{intent})` is unchanged.
#[tauri::command]
pub fn run_command(app: tauri::AppHandle, intent: CommandIntent) -> Result<String, String> {
    route_and_execute(&app, &intent)
}

// (finding 2) System commands are matched FIRST — before the focus-route guard — because
// they don't operate on an editable field ("open Slack" on the desktop must still launch).
// They're gated on `config.system_commands` (off → "disabled"). Only the P1 field-edit
// variants fall through to the AX focus-route guard + keystroke `execute`.
//
// macOS is the only platform with the AX probe; command mode is macOS-only, so elsewhere
// we refuse the edit variants (nothing to route against).
#[cfg(target_os = "macos")]
fn route_and_execute(app: &tauri::AppHandle, intent: &CommandIntent) -> Result<String, String> {
    // System family: gate on the opt-in flag, then delegate to macOS. No focus required.
    match intent {
        CommandIntent::Launch { .. }
        | CommandIntent::Volume { .. }
        | CommandIntent::Shortcut { .. } => {
            if !crate::read_config(app).system_commands {
                return Ok("disabled".into());
            }
            return match intent {
                CommandIntent::Launch { app: name } => crate::syscommand::launch_app(name),
                CommandIntent::Volume { direction } => crate::syscommand::set_volume(direction),
                CommandIntent::Shortcut { name } => crate::syscommand::run_shortcut(name),
                _ => unreachable!(),
            };
        }
        _ => {}
    }

    // Field-edit family (P1): refuse unless a confirmed editable field is focused.
    match crate::axinject::focus_route() {
        "no_access" => Ok("no_access".into()),
        "secure" => Ok("secure".into()),
        "no_field" => Ok("no_field".into()),
        _ => execute(intent), // "editable"
    }
}

// Off-macOS: system commands still gate on the flag (and would be no-ops with no macOS
// facilities), while edit variants have no focus route to guard against.
#[cfg(not(target_os = "macos"))]
fn route_and_execute(app: &tauri::AppHandle, intent: &CommandIntent) -> Result<String, String> {
    match intent {
        CommandIntent::Launch { .. }
        | CommandIntent::Volume { .. }
        | CommandIntent::Shortcut { .. } => {
            if !crate::read_config(app).system_commands {
                Ok("disabled".into())
            } else {
                Ok("unavailable".into())
            }
        }
        _ => Ok("no_field".into()),
    }
}

// ─────────────────────────── keystroke execution (macOS) ───────────────────────────

#[cfg(target_os = "macos")]
fn new_enigo() -> Result<Enigo, String> {
    Enigo::new(&Settings::default()).map_err(|e| format!("enigo: {e}"))
}

/// Press `mods` (in order), click `key`, release `mods` (reverse order) — a chord like
/// ⌘B or ⌥⇧←. Modifiers are released even if the click fails only in the success path; on
/// error we bail (the OS auto-releases on process teardown, and enigo drops keys on Drop).
#[cfg(target_os = "macos")]
fn combo(enigo: &mut Enigo, mods: &[Key], key: Key) -> Result<(), String> {
    for m in mods {
        enigo.key(*m, Direction::Press).map_err(|e| e.to_string())?;
    }
    enigo.key(key, Direction::Click).map_err(|e| e.to_string())?;
    for m in mods.iter().rev() {
        enigo.key(*m, Direction::Release).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Establish the selection the action operates on. `Selection` relies on whatever the user
/// already has selected (no keystrokes). `LastSentence` is v1 best-effort — there's no
/// portable "select sentence" shortcut, so it selects backward like a word (⌥⇧←); a real
/// sentence heuristic is a later refinement.
#[cfg(target_os = "macos")]
fn select_target(enigo: &mut Enigo, target: &Target) -> Result<(), String> {
    match target {
        Target::Selection => Ok(()),
        // ⌘A — explicit-flag chord (crate::inject::post_command_chord), not enigo's combo()
        // — see the comment on post_command_chord for why (the "types a literal letter
        // instead of the modified keystroke" bug).
        Target::All => crate::inject::post_command_chord('a'),
        Target::LastWord | Target::LastSentence => {
            combo(enigo, &[Key::Alt, Key::Shift], Key::LeftArrow)
        }
    }
}

#[cfg(target_os = "macos")]
fn execute(intent: &CommandIntent) -> Result<String, String> {
    match intent {
        CommandIntent::Noop { .. } => Ok("noop".into()),

        CommandIntent::Insert { what, text } => match what.as_str() {
            "newline" => {
                let mut enigo = new_enigo()?;
                enigo
                    .key(Key::Return, Direction::Click)
                    .map_err(|e| e.to_string())?;
                Ok("done".into())
            }
            "literal" => {
                // Reuse the proven clipboard+⌘V paste path (it snapshots/restores the
                // clipboard itself). Empty/absent text → nothing to type.
                match text.as_ref().filter(|s| !s.is_empty()) {
                    Some(t) => {
                        crate::inject::paste_text(t)?;
                        Ok("done".into())
                    }
                    None => Ok("noop".into()),
                }
            }
            _ => Ok("noop".into()),
        },

        CommandIntent::Format { style, target } => {
            let mut enigo = new_enigo()?;
            select_target(&mut enigo, target)?;
            let letter = match style {
                Style::Bold => 'b',
                Style::Italic => 'i',
                Style::Underline => 'u',
            };
            crate::inject::post_command_chord(letter)?;
            Ok("done".into())
        }

        CommandIntent::Delete { target } => {
            let mut enigo = new_enigo()?;
            // Selection → just ⌫ over the existing selection; others select first, then ⌫.
            select_target(&mut enigo, target)?;
            enigo
                .key(Key::Backspace, Direction::Click)
                .map_err(|e| e.to_string())?;
            Ok("done".into())
        }

        CommandIntent::Select { target } => match target {
            // Selecting the current selection is a no-op; anything else moves the selection.
            Target::Selection => Ok("noop".into()),
            _ => {
                let mut enigo = new_enigo()?;
                select_target(&mut enigo, target)?;
                Ok("done".into())
            }
        },

        CommandIntent::Case { mode, target } => apply_case(mode, target),

        // P1c — rewrite is never dispatched through run_command in practice (the frontend
        // drives get_command_selection / paste_rewrite directly, per the block above); this
        // arm exists only so the match stays exhaustive if something calls run_command with
        // a Rewrite intent directly.
        CommandIntent::Rewrite { .. } => Ok("noop".into()),

        // P2 system commands are dispatched in `route_and_execute` BEFORE the focus-route
        // guard, so they never reach the field-edit executor. Handle them defensively (no
        // keystrokes) rather than leaving the match non-exhaustive.
        CommandIntent::Launch { .. }
        | CommandIntent::Volume { .. }
        | CommandIntent::Shortcut { .. } => Ok("noop".into()),
    }
}

/// Select `target`, ⌘C it, and read the pasteboard — the read half of the clipboard
/// round-trip `apply_case` and the P1c rewrite path both need. Always restores the user's
/// PREVIOUS clipboard before returning (whether or not anything was selected), since both
/// callers either transform-then-paste immediately (case) or hold the text for a network
/// round-trip before pasting (rewrite) — in neither case should the user's clipboard sit
/// polluted with our intermediate copy. Returns `Ok(None)` when nothing was selected/copied.
#[cfg(target_os = "macos")]
fn copy_selection(
    enigo: &mut Enigo,
    clipboard: &mut arboard::Clipboard,
    target: &Target,
) -> Result<Option<String>, String> {
    use std::{thread, time::Duration};

    let previous = clipboard.get_text().ok();
    select_target(enigo, target)?;
    // ⌘C — explicit-flag chord, same reason as select_target's ⌘A (see post_command_chord).
    crate::inject::post_command_chord('c')?;
    thread::sleep(Duration::from_millis(120)); // settle: let ⌘C populate the pasteboard

    let selected = clipboard.get_text().unwrap_or_default();
    if let Some(prev) = previous {
        let _ = clipboard.set_text(prev);
    }
    Ok(if selected.is_empty() { None } else { Some(selected) })
}

/// Case-fold the target text. macOS has no native case shortcut, so this does an EXPLICIT
/// clipboard round-trip: save the user's clipboard → select the target → ⌘C → read the
/// selection → transform → set → ⌘V over the selection → restore the clipboard. We do NOT
/// use `inject::paste_text` here: it snapshots the clipboard AFTER we've already put the
/// transformed text on it, so its built-in restore would "restore" the transformed text,
/// not the user's original (finding 8). A short settle delay after ⌘C lets the copy land.
#[cfg(target_os = "macos")]
fn apply_case(mode: &CaseMode, target: &Target) -> Result<String, String> {
    use arboard::Clipboard;
    use std::{thread, time::Duration};

    let mut enigo = new_enigo()?;
    let mut clipboard = Clipboard::new().map_err(|e| format!("clipboard: {e}"))?;
    // Save the user's clipboard up front so we can restore it no matter what (copy_selection
    // already restores after ITS read, but we still need the ORIGINAL for after our paste).
    let previous = clipboard.get_text().ok();

    let Some(selected) = copy_selection(&mut enigo, &mut clipboard, target)? else {
        // Nothing selected/copied — copy_selection already restored the clipboard.
        return Ok("noop".into());
    };

    let transformed = match mode {
        CaseMode::Upper => selected.to_uppercase(),
        CaseMode::Lower => selected.to_lowercase(),
        CaseMode::Title => title_case(&selected),
    };
    clipboard
        .set_text(transformed)
        .map_err(|e| format!("clipboard set: {e}"))?;
    thread::sleep(Duration::from_millis(20));

    // Paste the transformed text over the still-selected target. Explicit-flag chord, same
    // reason as copy_selection's ⌘C above (see post_command_chord) — this is the OTHER half
    // of the exact bug that was reported for inject_text's plain ⌘V.
    crate::inject::post_command_chord('v')?;
    thread::sleep(Duration::from_millis(150)); // let the paste land before we restore

    if let Some(prev) = previous {
        let _ = clipboard.set_text(prev);
    }
    Ok("done".into())
}

/// Title-case each whitespace-delimited word, preserving the original spacing (uses
/// `split_inclusive` so runs of whitespace ride along with their word).
#[cfg(target_os = "macos")]
fn title_case(s: &str) -> String {
    s.split_inclusive(char::is_whitespace)
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => {
                    first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()
                }
                None => String::new(),
            }
        })
        .collect()
}

// ─────────────────────────── P1c — rewrite (two-phase, frontend-driven) ───────────────────────────
//
// A "rewrite" intent can't be executed in one `run_command` call like every other action:
// the transformation needs an LLM round-trip through the backend (using whichever vendor is
// already the correction provider), and the Rust host holds neither a vendor key nor a
// network client for it. So the frontend drives two Tauri calls instead of one:
//   1. `get_command_selection(target)` — read the field's current selection (this module
//      already knows how, via `copy_selection`/`focus_route`), hand it to the backend
//      alongside the classified instruction.
//   2. `paste_rewrite(text)` — once the backend replies with the rewritten text, paste it
//      back over the (still-selected) target.
// Both share `run_command`'s refusal contract (no_access/secure/no_field) so the frontend
// reuses the exact same banners.

/// The result of reading a field's current selection for a rewrite. `status` mirrors
/// `run_command`'s routing strings (no_access/secure/no_field), plus "ok" (text present)
/// and "empty" (a confirmed editable field, but nothing was actually selected).
#[derive(serde::Serialize)]
pub struct SelectionResult {
    pub status: String,
    pub text: Option<String>,
}

impl SelectionResult {
    fn blocked(status: &str) -> Self {
        Self { status: status.into(), text: None }
    }
}

/// P1c step 1 — read the CURRENTLY SELECTED text at `target` so the frontend can send it to
/// the backend for the actual rewrite call. Refuses under the same rules as `run_command`'s
/// field-edit path (no Accessibility / secure field / nothing focused) — a rewrite is exactly
/// as sensitive as any other keystroke-driven edit, just split across two calls.
#[tauri::command]
pub fn get_command_selection(target: Target) -> SelectionResult {
    #[cfg(target_os = "macos")]
    {
        match crate::axinject::focus_route() {
            "no_access" => return SelectionResult::blocked("no_access"),
            "secure" => return SelectionResult::blocked("secure"),
            "no_field" => return SelectionResult::blocked("no_field"),
            _ => {}
        }
        let (Ok(mut enigo), Ok(mut clipboard)) = (new_enigo(), arboard::Clipboard::new()) else {
            return SelectionResult::blocked("no_access");
        };
        match copy_selection(&mut enigo, &mut clipboard, &target) {
            Ok(Some(text)) => SelectionResult { status: "ok".into(), text: Some(text) },
            Ok(None) => SelectionResult::blocked("empty"),
            Err(_) => SelectionResult::blocked("no_access"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = target;
        SelectionResult::blocked("no_field")
    }
}

/// P1c step 2 — paste the backend's rewritten text back over the target, which the earlier
/// `get_command_selection` call left selected (we deliberately do NOT re-select here: for
/// last-word/last-sentence, `select_target` moves relative to the CURRENT cursor, and
/// re-invoking it after the network round-trip could select the wrong span; relying on the
/// field's own selection staying put across the wait is the same assumption dictation
/// already makes between capturing focus and injecting the finalized text, just applied to
/// a highlighted span instead of a caret). Refuses again defensively — focus may have
/// changed during the LLM call — under the same rules as `run_command`.
#[tauri::command]
pub fn paste_rewrite(text: String) -> Result<String, String> {
    if text.trim().is_empty() {
        return Ok("noop".into());
    }
    #[cfg(target_os = "macos")]
    {
        match crate::axinject::focus_route() {
            "no_access" => return Ok("no_access".into()),
            "secure" => return Ok("secure".into()),
            // Focus moved away from an editable field during the LLM round-trip — fall back
            // to the clipboard (mirrors `inject_text`'s own no_field routing) rather than
            // silently dropping the rewritten text.
            "no_field" => { let _ = crate::inject::copy_only(&text); return Ok("no_field".into()); }
            _ => {}
        }
        crate::inject::paste_text(&text)?;
        Ok("done".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("no_field".into())
    }
}

// ─────────────────────────────── serde contract test ───────────────────────────────

#[cfg(test)]
mod tests {
    use super::{CaseMode, CommandIntent, Style, Target, VolumeDir};

    // These JSON strings are the EXACT payloads INTENT_FIXTURES
    // (packages/core/src/command/fixtures.ts) sends via invoke("run_command",{intent}).
    // KEEP THEM IN SYNC with that file: one object of every variant, including both
    // `insert` shapes. If the TS union or this enum drifts, deserialization fails here.
    const FIXTURES: &[&str] = &[
        r#"{"action":"format","style":"bold","target":"selection"}"#,
        r#"{"action":"format","style":"italic","target":"last-word"}"#,
        r#"{"action":"format","style":"underline","target":"last-sentence"}"#,
        r#"{"action":"delete","target":"all"}"#,
        r#"{"action":"delete","target":"last-word"}"#,
        r#"{"action":"case","mode":"upper","target":"selection"}"#,
        r#"{"action":"case","mode":"lower","target":"last-word"}"#,
        r#"{"action":"case","mode":"title","target":"all"}"#,
        r#"{"action":"select","target":"all"}"#,
        r#"{"action":"select","target":"selection"}"#,
        r#"{"action":"insert","what":"newline"}"#,
        r#"{"action":"insert","what":"literal","text":"hello world"}"#,
        // P1c — free-form rewrite (mirror packages/core/src/command/fixtures.ts).
        r#"{"action":"rewrite","instruction":"make this more formal","target":"selection"}"#,
        // P2 — system-command variants (mirror packages/core/src/command/fixtures.ts).
        r#"{"action":"launch","app":"Slack"}"#,
        r#"{"action":"volume","direction":"up"}"#,
        r#"{"action":"shortcut","name":"Start Standup"}"#,
        r#"{"action":"noop","reason":"not an editing command"}"#,
    ];

    #[test]
    fn deserializes_every_intent_fixture() {
        for j in FIXTURES {
            let parsed: Result<CommandIntent, _> = serde_json::from_str(j);
            assert!(
                parsed.is_ok(),
                "failed to deserialize fixture {j}: {:?}",
                parsed.err()
            );
        }
    }

    #[test]
    fn maps_kebab_case_wire_values_to_variants() {
        assert_eq!(
            serde_json::from_str::<CommandIntent>(
                r#"{"action":"format","style":"bold","target":"last-word"}"#
            )
            .unwrap(),
            CommandIntent::Format {
                style: Style::Bold,
                target: Target::LastWord
            }
        );
        assert_eq!(
            serde_json::from_str::<CommandIntent>(r#"{"action":"case","mode":"title","target":"all"}"#)
                .unwrap(),
            CommandIntent::Case {
                mode: CaseMode::Title,
                target: Target::All
            }
        );
        // P2 — a system-command variant round-trips, and the volume direction kebab-maps.
        assert_eq!(
            serde_json::from_str::<CommandIntent>(r#"{"action":"volume","direction":"unmute"}"#)
                .unwrap(),
            CommandIntent::Volume {
                direction: VolumeDir::Unmute
            }
        );
        assert_eq!(
            serde_json::from_str::<CommandIntent>(r#"{"action":"launch","app":"Slack"}"#).unwrap(),
            CommandIntent::Launch {
                app: "Slack".into()
            }
        );
        // P1c — the rewrite variant round-trips (instruction is a free string, target kebab-maps).
        assert_eq!(
            serde_json::from_str::<CommandIntent>(
                r#"{"action":"rewrite","instruction":"make this more formal","target":"selection"}"#
            )
            .unwrap(),
            CommandIntent::Rewrite {
                instruction: "make this more formal".into(),
                target: Target::Selection
            }
        );
    }

    // P2 — serde must REJECT a direction outside the closed VolumeDir enum (parity with the
    // Style/Target rejection the TS grammar enforces).
    #[test]
    fn rejects_out_of_enum_volume_direction() {
        assert!(
            serde_json::from_str::<CommandIntent>(r#"{"action":"volume","direction":"louder"}"#)
                .is_err()
        );
    }

    #[test]
    fn insert_variants_collapse_onto_what() {
        assert_eq!(
            serde_json::from_str::<CommandIntent>(r#"{"action":"insert","what":"newline"}"#).unwrap(),
            CommandIntent::Insert {
                what: "newline".into(),
                text: None
            }
        );
        assert_eq!(
            serde_json::from_str::<CommandIntent>(
                r#"{"action":"insert","what":"literal","text":"hi"}"#
            )
            .unwrap(),
            CommandIntent::Insert {
                what: "literal".into(),
                text: Some("hi".into())
            }
        );
    }
}
