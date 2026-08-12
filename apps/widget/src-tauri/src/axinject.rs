// Phase 3.4 — injection routing.
//
// Injection itself is clipboard + synthetic ⌘V (works whenever ⌘V works; proven in the
// Spike B test). AX is used only as a *best-effort* guard to refuse secure/password
// fields — never as a gate on the happy path. On this setup the system-wide AX focused-
// element query returns kAXErrorNoValue (-25212) even for a trusted process, so we must
// not let that block pasting; if the role can't be read we simply paste.
//
// Needs Accessibility permission (same as the paste keystroke). AX-write into a captured
// element (kAXSelectedText) is deferred until the AX focus read is reliable here.
#![cfg(target_os = "macos")]

use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::string::{CFString, CFStringRef};
use std::os::raw::c_void;
use std::ptr;

type AXUIElementRef = *const c_void;
const AX_SUCCESS: i32 = 0;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> i32;
    fn AXIsProcessTrusted() -> bool;
}

unsafe fn copy_attr(el: AXUIElementRef, name: &str) -> CFTypeRef {
    let attr = CFString::new(name);
    let mut out: CFTypeRef = ptr::null();
    if AXUIElementCopyAttributeValue(el, attr.as_concrete_TypeRef(), &mut out) == AX_SUCCESS {
        out
    } else {
        ptr::null()
    }
}

unsafe fn string_attr(el: AXUIElementRef, name: &str) -> String {
    let r = copy_attr(el, name);
    if r.is_null() {
        String::new()
    } else {
        CFString::wrap_under_create_rule(r as CFStringRef).to_string()
    }
}

// Best-effort role of the focused element ("" if AX can't read it). Tries the focused
// application first (Chromium/Electron), then the system-wide element.
unsafe fn focused_role() -> String {
    let system = AXUIElementCreateSystemWide();
    if system.is_null() {
        return String::new();
    }
    let app = copy_attr(system, "AXFocusedApplication");
    let (holder, focused) = if !app.is_null() {
        let app_el = app as AXUIElementRef;
        let ma = CFString::new("AXManualAccessibility");
        let _ = AXUIElementSetAttributeValue(
            app_el,
            ma.as_concrete_TypeRef(),
            CFBoolean::true_value().as_concrete_TypeRef() as CFTypeRef,
        );
        (app, copy_attr(app_el, "AXFocusedUIElement"))
    } else {
        (ptr::null(), copy_attr(system, "AXFocusedUIElement"))
    };
    CFRelease(system as CFTypeRef);
    if !holder.is_null() {
        CFRelease(holder);
    }
    if focused.is_null() {
        return String::new();
    }
    let role = string_attr(focused as AXUIElementRef, "AXRole");
    CFRelease(focused);
    role
}

/// Diagnostic: log whether a focused element is readable right now. Called on hotkey
/// press (widget still hidden) to test if hiding the overlay fixes the AX focus read
/// that fails while the panel is visible. Does not affect injection.
pub fn probe() {
    unsafe {
        if !AXIsProcessTrusted() {
            eprintln!("[axinject] probe: Accessibility not granted");
            return;
        }
        let role = focused_role();
        eprintln!(
            "[axinject] probe (on hotkey, widget hidden): focused role = {}",
            if role.is_empty() { "NONE".to_string() } else { role }
        );
    }
}

/// Inject `text`: paste into the focused field, refusing only if we can positively
/// identify a secure/password field. Returns "inserted" | "secure" | "no_access" |
/// "no_field".
pub fn inject(text: &str) -> String {
    unsafe {
        if !AXIsProcessTrusted() {
            let _ = crate::inject::copy_only(text);
            eprintln!("[axinject] Accessibility not granted -> copied");
            return "no_access".into();
        }

        let role = focused_role();
        if role == "AXSecureTextField" {
            let _ = crate::inject::copy_only(text);
            eprintln!("[axinject] secure field -> refused + copied");
            return "secure".into();
        }
        eprintln!(
            "[axinject] focused role='{}' -> paste",
            if role.is_empty() { "?" } else { role.as_str() }
        );

        match crate::inject::paste_text(text) {
            Ok(()) => "inserted".into(),
            Err(e) => {
                let _ = crate::inject::copy_only(text);
                eprintln!("[axinject] paste failed ({e}) -> copied");
                "no_field".into()
            }
        }
    }
}
