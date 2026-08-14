// Text injection via clipboard + synthetic Cmd+V — the universal fallback path (works
// wherever ⌘V works). A cleaner AX-write path (kAXSelectedText) can be added later; for
// now paste is the injection mechanism and AX is used only to decide WHETHER to paste.
//
// NOTE: posting keystrokes on macOS requires Accessibility permission
// (System Settings → Privacy & Security → Accessibility). enigo silently no-ops until
// granted.
use arboard::Clipboard;
use std::{thread, time::Duration};

#[cfg(not(target_os = "macos"))]
use enigo::{Direction, Enigo, Key, Keyboard, Settings};

pub fn paste_text(text: &str) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| format!("clipboard: {e}"))?;
    let previous = clipboard.get_text().ok(); // snapshot to restore afterward

    clipboard
        .set_text(text.to_string())
        .map_err(|e| format!("clipboard set: {e}"))?;

    // Give the target app a beat to be ready / focus to settle.
    thread::sleep(Duration::from_millis(120));

    // macOS: see post_command_chord below — fixes the intermittent "types a literal 'v'
    // instead of pasting" bug. Other platforms keep the previous enigo-only sequence
    // (unaffected by the fix below, which is raw core-graphics and macOS-only).
    #[cfg(target_os = "macos")]
    post_command_chord('v')?;
    #[cfg(not(target_os = "macos"))]
    {
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo: {e}"))?;
        enigo.key(Key::Meta, Direction::Press).map_err(|e| e.to_string())?;
        enigo.key(Key::Unicode('v'), Direction::Click).map_err(|e| e.to_string())?;
        enigo.key(Key::Meta, Direction::Release).map_err(|e| e.to_string())?;
    }

    // Restore the previous clipboard contents after the paste lands.
    thread::sleep(Duration::from_millis(150));
    if let Some(prev) = previous {
        let _ = clipboard.set_text(prev);
    }
    Ok(())
}

// ---- explicit-flag ⌘+letter chord (macOS) ----
//
// Bug this fixes: the previous implementation used enigo's high-level API —
// `key(Meta, Press)` … `key(Unicode(letter), Click)` … `key(Meta, Release)` — which posts
// FOUR separate, unflagged CGEvents and relies on macOS's own combined-session-state
// modifier tracking to associate the Meta keydown with the letter keydown/keyup that follow
// ~20ms later (enigo's default inter-event delay). There is no explicit synchronization:
// under any timing perturbation (system load, the frontmost app's event loop being briefly
// busy exactly when the Meta keydown lands, etc.) the letter's keydown+keyup pair can be
// delivered to the frontmost app WITHOUT the Command flag attached — which AppKit/the
// text-input system then treats as an ordinary keystroke. For ⌘V specifically, that's
// exactly the reported "sometimes it just inserts 'V' in the selected area instead of the
// text": a literal 'v' replaces the selection instead of a paste running.
//
// Fix: stamp `CGEventFlags::CGEventFlagCommand` directly onto the letter's own keydown AND
// keyup CGEvents via raw core-graphics (in addition to still pressing/releasing the
// physical ⌘ key too, so anything reading `NSEvent.modifierFlags` off a separate event also
// sees Command held). The flag now lives on the letter event itself instead of being
// inferred from a differently-timed event, so there's nothing left to race.
//
// Shared with command.rs, which sends the exact same shape of chord for ⌘A/⌘C/⌘B/⌘I/⌘U and
// the case-mode ⌘V — all equally exposed to this bug, since they all went through enigo's
// `combo()` helper the same way `paste_text` used to.
#[cfg(target_os = "macos")]
pub fn post_command_chord(letter: char) -> Result<(), String> {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, KeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let keycode = ansi_keycode(letter)?;
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "CGEventSource::new failed".to_string())?;

    let meta_down = CGEvent::new_keyboard_event(source.clone(), KeyCode::COMMAND, true)
        .map_err(|_| "CGEvent::new_keyboard_event(⌘ down) failed".to_string())?;
    meta_down.set_flags(CGEventFlags::CGEventFlagCommand);
    meta_down.post(CGEventTapLocation::HID);

    let key_down = CGEvent::new_keyboard_event(source.clone(), keycode, true)
        .map_err(|_| "CGEvent::new_keyboard_event(key down) failed".to_string())?;
    key_down.set_flags(CGEventFlags::CGEventFlagCommand); // <- the actual fix
    key_down.post(CGEventTapLocation::HID);

    let key_up = CGEvent::new_keyboard_event(source.clone(), keycode, false)
        .map_err(|_| "CGEvent::new_keyboard_event(key up) failed".to_string())?;
    key_up.set_flags(CGEventFlags::CGEventFlagCommand); // <- and the keyup, same reason
    key_up.post(CGEventTapLocation::HID);

    let meta_up = CGEvent::new_keyboard_event(source, KeyCode::COMMAND, false)
        .map_err(|_| "CGEvent::new_keyboard_event(⌘ up) failed".to_string())?;
    meta_up.post(CGEventTapLocation::HID);

    Ok(())
}

// macOS ANSI virtual keycodes (kVK_ANSI_*, layout-independent physical positions) for the
// letters this app sends ⌘-chords for. Matches what enigo's own
// get_layoutdependent_keycode() resolved these to on a US layout — same keycodes as before,
// just posted with an explicit flag instead of an implicit one.
#[cfg(target_os = "macos")]
fn ansi_keycode(letter: char) -> Result<core_graphics::event::CGKeyCode, String> {
    match letter {
        'a' => Ok(0x00),
        'b' => Ok(0x0B),
        'c' => Ok(0x08),
        'i' => Ok(0x22),
        'u' => Ok(0x20),
        'v' => Ok(0x09),
        _ => Err(format!("post_command_chord: no keycode mapped for '{letter}'")),
    }
}

// Put text on the clipboard and LEAVE it there (no paste, no restore) — the safe path
// when there's no editable field to paste into, or a secure field we refuse to touch.
pub fn copy_only(text: &str) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| format!("clipboard: {e}"))?;
    clipboard
        .set_text(text.to_string())
        .map_err(|e| format!("clipboard set: {e}"))
}
