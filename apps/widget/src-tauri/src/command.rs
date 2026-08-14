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
        Target::All => combo(enigo, &[Key::Meta], Key::Unicode('a')),
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
            combo(&mut enigo, &[Key::Meta], Key::Unicode(letter))?;
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

        // P2 system commands are dispatched in `route_and_execute` BEFORE the focus-route
        // guard, so they never reach the field-edit executor. Handle them defensively (no
        // keystrokes) rather than leaving the match non-exhaustive.
        CommandIntent::Launch { .. }
        | CommandIntent::Volume { .. }
        | CommandIntent::Shortcut { .. } => Ok("noop".into()),
    }
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
    // Save the user's clipboard up front so we can restore it no matter what.
    let previous = clipboard.get_text().ok();

    // Select the target (Selection = whatever's already highlighted), then copy it.
    select_target(&mut enigo, target)?;
    combo(&mut enigo, &[Key::Meta], Key::Unicode('c'))?;
    thread::sleep(Duration::from_millis(120)); // settle: let ⌘C populate the pasteboard

    let selected = clipboard.get_text().unwrap_or_default();
    if selected.is_empty() {
        // Nothing selected/copied — restore and do nothing rather than paste an empty string.
        if let Some(prev) = previous {
            let _ = clipboard.set_text(prev);
        }
        return Ok("noop".into());
    }

    let transformed = match mode {
        CaseMode::Upper => selected.to_uppercase(),
        CaseMode::Lower => selected.to_lowercase(),
        CaseMode::Title => title_case(&selected),
    };
    clipboard
        .set_text(transformed)
        .map_err(|e| format!("clipboard set: {e}"))?;
    thread::sleep(Duration::from_millis(20));

    // Paste the transformed text over the still-selected target.
    combo(&mut enigo, &[Key::Meta], Key::Unicode('v'))?;
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
