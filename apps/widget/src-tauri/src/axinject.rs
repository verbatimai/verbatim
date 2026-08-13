// Phase 3.4 — injection routing + AX focus read.
//
// ROOT CAUSE (found via the diagnostic below):
// The old code read the *system-wide* focused-element attribute. That attribute is
// unreliable — it returns kAXErrorNoValue (-25212) even for a fully-trusted process —
// and it was queried against a *cold* AX connection with no retry. Chromium/Electron
// apps make it worse: they expose no AX tree at all until a client sets
// `AXManualAccessibility=true`, and even then the tree takes a beat to build. So every
// early read came back NoValue. It was never a trust/signing problem: AXIsProcessTrusted
// is true and we only ever see -25212 (NoValue), never -25211 (APIDisabled).
//
// THE FIX (see `read_focus`):
//   1. Get the frontmost app's pid from NSWorkspace (rock-solid in the logs).
//   2. AXUIElementCreateApplication(pid) — the per-app element, not the system-wide one.
//   3. Set AXManualAccessibility=true so Chromium/Electron builds its tree (no-op on
//      native apps, which return -25205 and don't need it).
//   4. POLL AXFocusedUIElement for a few hundred ms so a lazily-built tree can appear.
//   5. Fall back to the system-wide element, then to plain paste — AX is additive and
//      must NEVER block the working paste path.
#![cfg(target_os = "macos")]

use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::string::{CFString, CFStringRef};
use std::os::raw::{c_char, c_void};
use std::ptr;
use std::time::Duration;

type AXUIElementRef = *const c_void;
type Pid = i32;
const AX_SUCCESS: i32 = 0;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    // Per-application AX element from a process id — the reliable path.
    fn AXUIElementCreateApplication(pid: Pid) -> AXUIElementRef;
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
    fn AXUIElementIsAttributeSettable(
        element: AXUIElementRef,
        attribute: CFStringRef,
        settable: *mut u8,
    ) -> i32;
    fn AXIsProcessTrusted() -> bool;
}

// Minimal Objective-C runtime FFI so we can ask AppKit for the frontmost application
// (NSWorkspace) without adding an objc2 dependency (keeps the blast radius tiny and
// avoids Cargo.lock churn against the parallel session).
#[link(name = "objc", kind = "dylib")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *const c_void;
    fn objc_msgSend();
}

// ─────────────────────────── AX attribute helpers ───────────────────────────

// Copy an attribute AND return the raw AXError so diagnostics can see the exact code.
unsafe fn copy_attr_e(el: AXUIElementRef, name: &str) -> (CFTypeRef, i32) {
    let attr = CFString::new(name);
    let mut out: CFTypeRef = ptr::null();
    let err = AXUIElementCopyAttributeValue(el, attr.as_concrete_TypeRef(), &mut out);
    if err == AX_SUCCESS {
        (out, err)
    } else {
        (ptr::null(), err)
    }
}

// Read a CFString attribute as a Rust String plus its AXError.
unsafe fn string_attr_e(el: AXUIElementRef, name: &str) -> (String, i32) {
    let (r, err) = copy_attr_e(el, name);
    if r.is_null() {
        (String::new(), err)
    } else {
        (CFString::wrap_under_create_rule(r as CFStringRef).to_string(), err)
    }
}

unsafe fn string_attr(el: AXUIElementRef, name: &str) -> String {
    string_attr_e(el, name).0
}

unsafe fn is_settable(el: AXUIElementRef, name: &str) -> bool {
    let attr = CFString::new(name);
    let mut settable: u8 = 0;
    let err = AXUIElementIsAttributeSettable(el, attr.as_concrete_TypeRef(), &mut settable);
    err == AX_SUCCESS && settable != 0
}

// Chromium/Electron expose their AX tree lazily — nothing appears until VoiceOver runs
// OR a client sets AXManualAccessibility on the app element. Harmless on native apps
// (they return kAXErrorAttributeUnsupported). Returns the AXError for logging.
unsafe fn enable_manual_ax(app_el: AXUIElementRef) -> i32 {
    let ma = CFString::new("AXManualAccessibility");
    AXUIElementSetAttributeValue(
        app_el,
        ma.as_concrete_TypeRef(),
        CFBoolean::true_value().as_concrete_TypeRef() as CFTypeRef,
    )
}

// NOTE on AX-write: setting kAXSelectedText was tried as the injection mechanism. On the
// tested apps it returns kAXErrorSuccess but inserts NOTHING (accepted-but-no-op, typical
// for caret-with-no-selection and web/Electron-backed text areas), which silently drops
// dictated text. So AX-write is intentionally NOT used; paste (⌘V) is the injection path
// and AX is used only to read/route (secure vs editable vs nothing).

// ─────────────────────── frontmost app via NSWorkspace ──────────────────────

#[inline]
unsafe fn sel(name: &[u8]) -> *const c_void {
    sel_registerName(name.as_ptr() as *const c_char)
}

// [id selector] returning an object pointer.
#[inline]
unsafe fn send_id(obj: *mut c_void, s: *const c_void) -> *mut c_void {
    let f: extern "C" fn(*mut c_void, *const c_void) -> *mut c_void =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, s)
}

// [id selector] returning a 32-bit int (pid_t).
#[inline]
unsafe fn send_i32(obj: *mut c_void, s: *const c_void) -> i32 {
    let f: extern "C" fn(*mut c_void, *const c_void) -> i32 =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, s)
}

// NSString* (toll-free bridged to CFString) -> Rust String.
unsafe fn ns_to_string(nsstr: *mut c_void) -> String {
    if nsstr.is_null() {
        return String::new();
    }
    CFString::wrap_under_get_rule(nsstr as CFStringRef).to_string()
}

// (pid, localizedName, bundleIdentifier) of the frontmost application, or (-1, …) if we
// can't get it. Uses [[NSWorkspace sharedWorkspace] frontmostApplication].
unsafe fn frontmost_app() -> (Pid, String, String) {
    let cls = objc_getClass(b"NSWorkspace\0".as_ptr() as *const c_char);
    if cls.is_null() {
        return (-1, "<no NSWorkspace class>".into(), String::new());
    }
    let ws = send_id(cls, sel(b"sharedWorkspace\0"));
    if ws.is_null() {
        return (-1, "<no sharedWorkspace>".into(), String::new());
    }
    let app = send_id(ws, sel(b"frontmostApplication\0"));
    if app.is_null() {
        return (-1, "<no frontmostApplication>".into(), String::new());
    }
    let pid = send_i32(app, sel(b"processIdentifier\0"));
    let name = ns_to_string(send_id(app, sel(b"localizedName\0")));
    let bid = ns_to_string(send_id(app, sel(b"bundleIdentifier\0")));
    (pid, name, bid)
}

// ─────────────────────────── focused-element read ───────────────────────────

/// A focused UI element plus the facts we route on. `el` is retained (Copy rule) — the
/// owner MUST call `CFRelease(el)` exactly once.
struct Focus {
    el: AXUIElementRef,
    role: String,
    subrole: String,
    /// Whether kAXSelectedText is settable on this element (i.e. AX-write is viable).
    writable: bool,
    /// How we found it, for logging.
    via: &'static str,
}

impl Focus {
    unsafe fn release(self) {
        if !self.el.is_null() {
            CFRelease(self.el);
        }
    }
}

/// Reliably read the focused UI element of the frontmost app.
///
/// Strategy: frontmost pid (NSWorkspace) → AXUIElementCreateApplication → flip
/// AXManualAccessibility on → poll AXFocusedUIElement up to `max_wait_ms` (Chromium/
/// Electron builds its tree lazily). Falls back to the system-wide element. Returns
/// `None` if nothing is focused / AX can't read — callers must treat that as "just
/// paste", never as a hard failure.
unsafe fn read_focus(max_wait_ms: u64) -> Option<Focus> {
    let mut chosen: AXUIElementRef = ptr::null();
    let mut via = "none";

    // Per-application path (the reliable one).
    let (pid, _name, _bid) = frontmost_app();
    if pid > 0 {
        let app_el = AXUIElementCreateApplication(pid);
        if !app_el.is_null() {
            enable_manual_ax(app_el); // wake Chromium/Electron; no-op on native
            let step: u64 = 40;
            let mut waited: u64 = 0;
            loop {
                let (fue, _err) = copy_attr_e(app_el, "AXFocusedUIElement");
                if !fue.is_null() {
                    chosen = fue as AXUIElementRef;
                    via = "app-pid";
                    break;
                }
                if waited >= max_wait_ms {
                    break;
                }
                std::thread::sleep(Duration::from_millis(step));
                waited += step;
            }
            CFRelease(app_el as CFTypeRef);
        }
    }

    // System-wide fallback (flaky, but occasionally wins when per-app doesn't).
    if chosen.is_null() {
        let system = AXUIElementCreateSystemWide();
        if !system.is_null() {
            let (fue, _err) = copy_attr_e(system, "AXFocusedUIElement");
            if !fue.is_null() {
                chosen = fue as AXUIElementRef;
                via = "system-wide";
            }
            CFRelease(system as CFTypeRef);
        }
    }

    if chosen.is_null() {
        return None;
    }

    let role = string_attr(chosen, "AXRole");
    let subrole = string_attr(chosen, "AXSubrole");
    let writable = is_settable(chosen, "AXSelectedText");
    Some(Focus {
        el: chosen,
        role,
        subrole,
        writable,
        via,
    })
}

fn is_secure(f: &Focus) -> bool {
    f.role == "AXSecureTextField" || f.subrole == "AXSecureTextField"
}

// Roles we treat as editable text targets even when kAXSelectedText isn't settable
// (e.g. web inputs that only accept a paste).
fn is_editable_role(role: &str) -> bool {
    matches!(
        role,
        "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField"
    )
}

/// Is this process trusted for Accessibility? Cheap, non-mutating — safe to poll from
/// the settings screen so we can show the permission state proactively (not just after
/// the first failed injection).
pub fn is_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// P1 — Classify the CURRENT focus for the command executor, WITHOUT injecting anything.
/// Wraps the same private `read_focus` / `is_secure` / `is_editable_role` logic `inject`
/// uses, but returns a route string the Rust `run_command` guards on BEFORE emitting any
/// synthetic keystrokes (a wrong keystroke edits the user's document):
///   "no_access" — Accessibility not granted (can't post keys reliably) → refuse
///   "secure"    — a password / secure text field → never touch
///   "editable"  — a text field we can safely edit → proceed with keystrokes
///   "no_field"  — nothing editable focused, or AX unreadable → refuse (do nothing)
/// Unlike `inject` (whose None-focus fallback is "just paste"), an unreadable focus here
/// maps to "no_field": command mode biases to doing nothing when it can't confirm a field.
pub fn focus_route() -> &'static str {
    unsafe {
        if !AXIsProcessTrusted() {
            return "no_access";
        }
        let focus = match read_focus(400) {
            None => return "no_field",
            Some(f) => f,
        };
        let route = if is_secure(&focus) {
            "secure"
        } else if focus.writable || is_editable_role(&focus.role) {
            "editable"
        } else {
            "no_field"
        };
        focus.release();
        route
    }
}

// ─────────────────────────────── diagnostic ─────────────────────────────────

/// One-shot diagnostic dump, fired on the ⌥Space press while the widget is still hidden.
/// Prints the raw signals side by side so we can keep verifying the fix per app.
pub fn diagnose() {
    unsafe {
        eprintln!("[axinject] ===================== AX DIAGNOSTIC =====================");
        eprintln!("[axinject] AXIsProcessTrusted() = {}", AXIsProcessTrusted());
        eprintln!("[axinject] our pid = {}", std::process::id());

        let system = AXUIElementCreateSystemWide();
        if !system.is_null() {
            let (fa, e_fa) = copy_attr_e(system, "AXFocusedApplication");
            let (fue, e_fue) = copy_attr_e(system, "AXFocusedUIElement");
            eprintln!(
                "[axinject] systemWide FocusedApplication err={}  FocusedUIElement err={}",
                e_fa, e_fue
            );
            if !fue.is_null() {
                CFRelease(fue);
            }
            if !fa.is_null() {
                CFRelease(fa);
            }
            CFRelease(system as CFTypeRef);
        }

        let (pid, name, bid) = frontmost_app();
        eprintln!(
            "[axinject] frontmost: name='{}' bundle='{}' pid={}",
            name, bid, pid
        );

        // The real read, with retry — this is what inject() uses.
        match read_focus(600) {
            Some(f) => {
                eprintln!(
                    "[axinject] read_focus => role='{}' subrole='{}' writable={} via={}",
                    f.role, f.subrole, f.writable, f.via
                );
                let routed = if is_secure(&f) {
                    "SECURE -> refuse+copy"
                } else if f.writable || is_editable_role(&f.role) {
                    "editable -> paste"
                } else {
                    "not editable -> copy"
                };
                eprintln!("[axinject] would route: {}", routed);
                f.release();
            }
            None => eprintln!("[axinject] read_focus => NONE (would paste as fallback)"),
        }
        eprintln!("[axinject] =================== END DIAGNOSTIC ====================");
    }
}

/// Diagnostic hook fired on the ⌥Space press while the widget is still hidden.
pub fn probe() {
    diagnose();
}

// ─────────────────────────────── injection ──────────────────────────────────

fn paste_fallback(text: &str) -> String {
    match crate::inject::paste_text(text) {
        Ok(()) => "inserted".into(),
        Err(e) => {
            let _ = crate::inject::copy_only(text);
            eprintln!("[axinject] paste failed ({e}) -> copied");
            "no_field".into()
        }
    }
}

/// Read visible text from the focused editable field (post-injection learn loop).
pub fn read_focused_field_text() -> Option<String> {
    unsafe {
        if !AXIsProcessTrusted() {
            return None;
        }
        let focus = read_focus(600)?;
        if is_secure(&focus) {
            focus.release();
            return None;
        }
        let mut text = string_attr(focus.el, "AXValue");
        if text.is_empty() {
            text = string_attr(focus.el, "AXSelectedText");
        }
        focus.release();
        if text.trim().is_empty() {
            None
        } else {
            Some(text)
        }
    }
}

/// Inject `text` into the focused field.
///
/// Routing (AX is best-effort; paste is always the safety net):
///   - not trusted            -> copy                         ("no_access")
///   - secure/password field  -> refuse + copy                ("secure")
///   - editable text element  -> paste                         ("inserted"/"no_field")
///   - a real non-editable el -> copy                         ("no_field")
///   - AX unreadable (None)   -> paste (never block)           ("inserted"/"no_field")
pub fn inject(text: &str) -> String {
    unsafe {
        if !AXIsProcessTrusted() {
            let _ = crate::inject::copy_only(text);
            eprintln!("[axinject] Accessibility not granted -> copied");
            return "no_access".into();
        }

        let focus = match read_focus(400) {
            None => {
                eprintln!("[axinject] focus unreadable -> paste (fallback)");
                return paste_fallback(text);
            }
            Some(f) => f,
        };

        eprintln!(
            "[axinject] focus role='{}' subrole='{}' writable={} via={}",
            focus.role, focus.subrole, focus.writable, focus.via
        );

        // Secure field: never inject; copy so the user can paste deliberately.
        if is_secure(&focus) {
            let _ = crate::inject::copy_only(text);
            eprintln!("[axinject] secure field -> refused + copied");
            focus.release();
            return "secure".into();
        }

        // Editable field -> paste. We deliberately do NOT AX-write (kAXSelectedText):
        // on tested apps it reports success but inserts nothing, silently dropping text.
        // Paste is the proven injection path; AX is only the read/guard.
        if focus.writable || is_editable_role(&focus.role) {
            eprintln!(
                "[axinject] editable (role='{}' writable={}) -> paste",
                focus.role, focus.writable
            );
            focus.release();
            return paste_fallback(text);
        }

        // We read a real element and it isn't an editable field -> copy.
        eprintln!("[axinject] role='{}' not editable -> copied", focus.role);
        focus.release();
        "no_field".into()
    }
}
