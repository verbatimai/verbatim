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

/// ≥ this held = push-to-talk; below = a tap (toggle).
pub const HOLD_MS: u128 = 300;

/// The last finalized transcript that was injected — retained so the paste-last global
/// hotkey (2.1) can re-inject it with NO webview involvement. Recorded inside
/// `text::inject_text`, whose sole caller is the webview's injectFinal with the
/// finalized formatted text.
pub static LAST_RESULT: Mutex<Option<String>> = Mutex::new(None);
