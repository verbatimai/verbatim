//! Shared runtime state for dictation.
//!
//! These live in one place because several unrelated entry points mutate them: the
//! global-shortcut handler (`shortcuts.rs`), the Fn/PTT event tap (`fnkey.rs`, which
//! reaches them as `crate::RECORDING` via the re-export in `main.rs`), and the text
//! injection path (`text.rs`).

use std::sync::Mutex;
use std::time::Instant;

/// Hotkey dictation state. A quick tap toggles (hands-free); a hold is push-to-talk
/// (record while held, stop on release).
pub static RECORDING: Mutex<bool> = Mutex::new(false);
pub static PRESS_AT: Mutex<Option<Instant>> = Mutex::new(None);
pub static STARTED_THIS_PRESS: Mutex<bool> = Mutex::new(false);

/// Widget redesign (pill/waveform) — bumped on every toggle Pressed-start so a delayed
/// "is this a hold?" check (spawned in shortcuts.rs) can tell a stale timer from a fresh
/// press. The toggle hotkey's Pressed handler can't know at press-time whether this will
/// resolve to a tap (toggle) or a hold (push-to-talk) — that's only known ≥HOLD_MS later
/// or at Released — so the timer re-checks after HOLD_MS and emits `dictation:"hold"` if
/// the same press is still live, telling the widget to hide its Stop button.
pub static PRESS_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Same idea as `PRESS_GEN`, but for the P1 command-mode hotkey — kept separate so the two
/// hotkeys' hold-confirmation timers never invalidate each other.
pub static COMMAND_PRESS_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// P1 command-mode state. Separate from the dictation statics so the two hotkeys never
/// cross-talk: a quick tap toggles command capture, a hold is push-to-talk (record while
/// held, classify on release). The shortcut handler drives these exactly like RECORDING /
/// PRESS_AT / STARTED_THIS_PRESS but emits the `command` event instead of `dictation`.
pub static COMMAND_RECORDING: Mutex<bool> = Mutex::new(false);
pub static COMMAND_PRESS_AT: Mutex<Option<Instant>> = Mutex::new(None);
pub static COMMAND_STARTED: Mutex<bool> = Mutex::new(false);

/// ≥ this held = push-to-talk; below = a tap (toggle).
pub const HOLD_MS: u128 = 300;

/// The last finalized transcript that was injected — retained so the paste-last global
/// hotkey (2.1) can re-inject it with NO webview involvement. Recorded inside
/// `text::inject_text`, whose sole caller is the webview's injectFinal with the
/// finalized formatted text.
pub static LAST_RESULT: Mutex<Option<String>> = Mutex::new(None);

/// 5.4 — the last RAW (pre-correction) transcript, retained so "revert to raw" can
/// re-inject the uncorrected text when the correction/format pass over-edited. Set by
/// the webview via `text::set_last_raw` on the `correction` frame.
pub static LAST_RAW: Mutex<Option<String>> = Mutex::new(None);
