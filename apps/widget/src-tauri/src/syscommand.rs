//! P2 — system commands via macOS delegation.
//!
//! System commands ("open Slack", "volume up", "run my Standup shortcut") are a commodity —
//! the OS already does them. So we build no action engine: the classifier
//! (packages/core/src/command) maps the utterance to a small closed set of `CommandIntent`
//! variants, and this module hands each to the matching macOS facility:
//!   Launch   → `open -a "<App>"`
//!   Volume   → `osascript` (up/down, a CONSTANT script) / the shared output-mute primitive
//!   Shortcut → `shortcuts run "<name>"`   (macOS 12+; missing binary → "unavailable")
//!
//! HARD INVARIANT (plan finding 7): model-produced strings (`app`, `name`) are passed ONLY
//! as `Command::args([...])` entries — a direct `execvp`, never a shell. No `sh -c`, and NO
//! model string is EVER interpolated into an `osascript -e` script. That is why launching an
//! arbitrary app name is safe for spaces / quotes / `;` / `$(...)` and needs no allow-list.
//! A later contributor must not reintroduce shell or string-interpolated osascript here.
//!
//! Each function returns "done" on success or an `Err(String)` the webview surfaces; none
//! panic. This module is macOS-only (the facilities are macOS binaries and it reuses the
//! macOS output-mute primitive); the serde `VolumeDir` lives in command.rs and stays
//! cross-platform so the wire types compile everywhere.

use std::process::Command;

use crate::command::VolumeDir;

/// Volume nudge step, of 0–100. A tunable (documented in the P2 plan §5).
const VOLUME_STEP: i32 = 12;

/// Launch (or activate) an app by name via `open -a`. `open` returns non-zero if no app of
/// that name exists; we surface that as an error rather than a silent success.
pub fn launch_app(app: &str) -> Result<String, String> {
    // `app` is a single argv entry — never a shell word — so spaces/quotes are literal.
    let status = Command::new("open")
        .args(["-a", app])
        .status()
        .map_err(|e| format!("open: {e}"))?;
    if status.success() {
        Ok("done".into())
    } else {
        Err(format!("could not open \"{app}\""))
    }
}

/// Adjust system output volume. Up/Down run a CONSTANT `osascript` — the direction selects a
/// fixed `-e` branch, the model string is NEVER interpolated. Mute/Unmute reuse the shared
/// `system::set_output_muted` primitive (the same one dictation's mute-others uses) rather
/// than a parallel `osascript set volume ... with output muted`, so command-mode mute can't
/// collide with the mute-others restore-on-stop bookkeeping (finding 6).
pub fn set_volume(dir: &VolumeDir) -> Result<String, String> {
    match dir {
        VolumeDir::Up => osascript_volume(VOLUME_STEP),
        VolumeDir::Down => osascript_volume(-VOLUME_STEP),
        VolumeDir::Mute => crate::system::set_output_muted(true).map(|_| "done".into()),
        VolumeDir::Unmute => crate::system::set_output_muted(false).map(|_| "done".into()),
    }
}

/// Nudge `output volume` by `delta` (clamped 0–100 by AppleScript) with a CONSTANT script per
/// direction — one of exactly two literal strings, chosen by the sign of `delta`. No value is
/// interpolated from any model output; `delta` is our own `±VOLUME_STEP` constant.
fn osascript_volume(delta: i32) -> Result<String, String> {
    // Two fixed scripts; the branch is chosen by our own constant, not by any model string.
    let script = if delta >= 0 {
        "set volume output volume (output volume of (get volume settings) + 12)"
    } else {
        "set volume output volume (output volume of (get volume settings) - 12)"
    };
    let status = Command::new("osascript")
        .args(["-e", script])
        .status()
        .map_err(|e| format!("osascript: {e}"))?;
    if status.success() {
        Ok("done".into())
    } else {
        Err("could not change volume".into())
    }
}

/// Run a user's named macOS Shortcut via the `shortcuts` CLI (macOS 12+). The name is a single
/// argv entry, never a shell word. A missing binary (pre-Monterey) is reported as
/// "unavailable" so the webview can show the "needs macOS 12+ Shortcuts" banner rather than a
/// generic failure.
pub fn run_shortcut(name: &str) -> Result<String, String> {
    let result = Command::new("shortcuts").args(["run", name]).status();
    match result {
        Ok(status) if status.success() => Ok("done".into()),
        Ok(_) => Err(format!("shortcut \"{name}\" failed to run")),
        // No `shortcuts` binary on PATH → pre-Monterey / Shortcuts unavailable.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("unavailable".into()),
        Err(e) => Err(format!("shortcuts: {e}")),
    }
}
