// Wave 4 — Fn / bare-modifier push-to-talk via a listen-only CGEventTap.
//
// WHY A NATIVE TAP (not tauri-plugin-global-shortcut):
// The global-shortcut plugin can't bind a *bare* modifier (Fn / a lone ⌘). PTT needs to
// observe a single modifier key's press/release without a companion key, so we run a
// session-level `CGEventTap` for `flagsChanged` on a dedicated background thread with its
// own CFRunLoop. The tap is **listen-only** and always returns the event UNMODIFIED, so it
// can never swallow a keystroke or steal focus — it only *watches* the modifier flag.
//
// FFI DISCIPLINE (matches axinject.rs): every symbol below is hand-declared in `#[link]`
// blocks — CoreGraphics (the tap), CoreFoundation (the run loop / mach port), IOKit
// (Input-Monitoring permission). ZERO new crates, exactly like axinject.rs deliberately
// avoids objc2/core-graphics to keep Cargo.lock churn tiny. `core-foundation 0.10` is
// vendored but does NOT wrap CFMachPort, so the mach-port/runloop refs are opaque here.
//
// CONTENT-SAFETY: we tap `flagsChanged` ONLY — never keyDown/keyUp — so typed content is
// never observed, and the shipped callback never logs a flag/keycode VALUE.
//
// ⚠ Native macOS: this file CANNOT be compiled or verified in the cloud. It is authored
// correctness-first and must `cargo build` / `npm run widget` green on the Mac (see the
// on-Mac protocol in docs/product/settings/phase-5-progress.md).
#![cfg(target_os = "macos")]

use std::os::raw::c_void;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

// ─────────────────────────────── FFI type aliases ───────────────────────────────
type CGEventRef = *mut c_void;
type CFMachPortRef = *mut c_void;
type CFRunLoopSourceRef = *mut c_void;
type CFRunLoopRef = *mut c_void;
type CFStringRef = *const c_void;
type CFAllocatorRef = *const c_void;
type CFTypeRef = *const c_void;
type CFIndex = isize;

// extern "C" fn(proxy, type, event, userInfo) -> event. For a listen-only tap the return
// value is ignored, but we always return the event unmodified anyway (never NULL).
type CGEventTapCallBack =
    extern "C" fn(*mut c_void, u32, CGEventRef, *mut c_void) -> CGEventRef;

// ─────────────────────────────── FFI constants ──────────────────────────────────
// CGEventTapLocation / Placement / Options (all uint32 enums in the C API).
const KCG_SESSION_EVENT_TAP: u32 = 1; // kCGSessionEventTap — the level Input Monitoring gates
const KCG_HEAD_INSERT_EVENT_TAP: u32 = 0; // kCGHeadInsertEventTap — observe early
const KCG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1; // passive: cannot consume events

// CGEventType values.
const KCG_EVENT_FLAGS_CHANGED: u32 = 12;
const KCG_EVENT_TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
const KCG_EVENT_TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;

// CGEventField id for the virtual keycode.
const KCG_KEYBOARD_EVENT_KEYCODE: u32 = 9;

// CGEventFlags mask bits (which modifier a flagsChanged toggled).
const FLAG_MASK_SECONDARY_FN: u64 = 0x0080_0000; // kCGEventFlagMaskSecondaryFn (Fn / 🌐)
const FLAG_MASK_COMMAND: u64 = 0x0010_0000; // kCGEventFlagMaskCommand (⌘)
const FLAG_MASK_ALTERNATE: u64 = 0x0008_0000; // kCGEventFlagMaskAlternate (⌥)

// Virtual keycodes (distinguish Right-⌘ 54 from Left-⌘ 55 so left-hand ⌘-shortcuts are
// untouched). Fn = 63, RightCmd = 54, RightOpt = 61.
const KEYCODE_FN: i64 = 63;
const KEYCODE_RIGHT_CMD: i64 = 54;
const KEYCODE_LEFT_CMD: i64 = 55;
const KEYCODE_RIGHT_OPT: i64 = 61;
const KEYCODE_LEFT_OPT: i64 = 58;

// IOKit HID (Input Monitoring = TCC kTCCServiceListenEvent, separate from Accessibility).
const K_IOHID_REQUEST_TYPE_LISTEN_EVENT: u32 = 1; // kIOHIDRequestTypeListenEvent
const K_IOHID_ACCESS_TYPE_GRANTED: u32 = 0; // kIOHIDAccessTypeGranted (Denied=1, Unknown=2)

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: CGEventTapCallBack,
        user_info: *mut c_void,
    ) -> CFMachPortRef;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventGetFlags(event: CGEventRef) -> u64;
    fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFRunLoopCommonModes: CFStringRef;
    fn CFMachPortCreateRunLoopSource(
        allocator: CFAllocatorRef,
        port: CFMachPortRef,
        order: CFIndex,
    ) -> CFRunLoopSourceRef;
    fn CFRunLoopGetCurrent() -> CFRunLoopRef;
    fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
    fn CFRunLoopRemoveSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
    fn CFRunLoopRun();
    fn CFRunLoopStop(rl: CFRunLoopRef); // documented thread-safe — the cross-thread stop path
    fn CFRelease(cf: CFTypeRef);
}

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOHIDCheckAccess(request_type: u32) -> u32;
    fn IOHIDRequestAccess(request_type: u32) -> bool;
}

// ───────────────────────────── shared / module state ────────────────────────────
// A Fn-hold session is in progress AND we own it (so releasing the key stops OUR session,
// but never a toggle session we didn't start). Shares crate::RECORDING for the actual
// start/stop gate (see §4 of the plan).
static FN_ACTIVE: Mutex<bool> = Mutex::new(false);

// Raw CF pointers are not Send; wrap them so only the pointer (never the object) crosses
// the start/stop thread boundary. The mach port + run loop source are created, used, and
// destroyed entirely on the tap thread; only the runloop pointer is read cross-thread
// (for the thread-safe CFRunLoopStop) and the tap pointer for CGEventTapEnable re-arm.
struct SendPtr(*mut c_void);
unsafe impl Send for SendPtr {}

static FN_RUNLOOP: Mutex<Option<SendPtr>> = Mutex::new(None); // for CFRunLoopStop
static FN_TAP: Mutex<Option<SendPtr>> = Mutex::new(None); // for re-enable on tap-disable
static FN_THREAD: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
static RUNNING: AtomicBool = AtomicBool::new(false);
static CURRENT_KEY: Mutex<String> = Mutex::new(String::new());
static PTT_KEYCODE: AtomicI64 = AtomicI64::new(-1); // the one modifier keycode we watch

// ───────────────────────────── key ↔ code / mask ────────────────────────────────
fn keycode_for(ptt_key: &str) -> i64 {
    match ptt_key {
        "fn" => KEYCODE_FN,
        "right_cmd" => KEYCODE_RIGHT_CMD,
        "right_opt" => KEYCODE_RIGHT_OPT,
        _ => KEYCODE_RIGHT_CMD, // default fallback per plan: Right-Command (clean, no lone action)
    }
}

fn mask_for_keycode(keycode: i64) -> u64 {
    match keycode {
        KEYCODE_FN => FLAG_MASK_SECONDARY_FN,
        KEYCODE_RIGHT_CMD | KEYCODE_LEFT_CMD => FLAG_MASK_COMMAND,
        KEYCODE_RIGHT_OPT | KEYCODE_LEFT_OPT => FLAG_MASK_ALTERNATE,
        _ => 0,
    }
}

// ───────────────────────────── press / release logic ────────────────────────────
// Both are internally atomic: RECORDING is locked across the whole check-and-set, and
// FN_ACTIVE is taken while holding it (consistent RECORDING→FN_ACTIVE lock order).
fn fn_press(app: &AppHandle) {
    let mut rec = crate::RECORDING.lock().unwrap();
    if *rec {
        // A session is already live (a toggle session, or a prior hold). Do NOT start a
        // second one, and do NOT claim ownership — so releasing this key won't stop a
        // toggle session we didn't start.
        return;
    }
    *rec = true;
    *FN_ACTIVE.lock().unwrap() = true;
    // Summon the overlay WITHOUT stealing focus — show(), never set_focus(), matching the
    // toggle path (main.rs). The panel is non-activating, so the target app keeps focus.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
    }
    let _ = app.emit("dictation", "start");
}

fn fn_release(app: &AppHandle) {
    let mut rec = crate::RECORDING.lock().unwrap();
    let mut active = FN_ACTIVE.lock().unwrap();
    if *active && *rec {
        *rec = false;
        *active = false;
        let _ = app.emit("dictation", "stop");
    } else {
        // We weren't what started the live session (e.g. the user tapped the toggle to
        // stop mid-hold). Clear our flag; emit NOTHING (no double-stop). The webview's
        // `stop → if (ws) stop()` guard is the backstop either way.
        *active = false;
    }
}

// ───────────────────────────── the C tap callback ───────────────────────────────
extern "C" fn tap_callback(
    _proxy: *mut c_void,
    etype: u32,
    event: CGEventRef,
    refcon: *mut c_void,
) -> CGEventRef {
    // LIVENESS: the system delivers these two even though they're not in our mask; re-arm.
    if etype == KCG_EVENT_TAP_DISABLED_BY_TIMEOUT || etype == KCG_EVENT_TAP_DISABLED_BY_USER_INPUT
    {
        if let Some(tap) = FN_TAP.lock().unwrap().as_ref() {
            unsafe { CGEventTapEnable(tap.0, true) };
        }
        return event;
    }

    if etype == KCG_EVENT_FLAGS_CHANGED {
        let keycode = unsafe { CGEventGetIntegerValueField(event, KCG_KEYBOARD_EVENT_KEYCODE) };
        // Early-return for every non-tracked modifier (the overwhelming common case — every
        // ⌘/⌥/⌃/⇧). One atomic load + compare; never blocks.
        if keycode != PTT_KEYCODE.load(Ordering::SeqCst) {
            return event;
        }
        let flags = unsafe { CGEventGetFlags(event) };
        let is_down = (flags & mask_for_keycode(keycode)) != 0;
        // BORROW the refcon AppHandle — NEVER Box::from_raw here (the running tap owns it;
        // freeing it would be a use-after-free on the next event). Freed once, on teardown.
        let app: &AppHandle = unsafe { &*(refcon as *const AppHandle) };
        if is_down {
            fn_press(app);
        } else {
            fn_release(app);
        }
        return event;
    }

    // Passive tap: anything else passes through untouched.
    event
}

// ───────────────────────────── tap thread lifecycle ─────────────────────────────
// Runs on the dedicated "verbatim-fnkey" thread. Owns the tap + mach-port + run loop for
// its entire life; blocks in CFRunLoopRun until stop_tap() calls CFRunLoopStop.
unsafe fn run_tap_thread(app: AppHandle, keycode: i64) {
    PTT_KEYCODE.store(keycode, Ordering::SeqCst);

    // Heap the AppHandle and hand the raw pointer to the tap as refcon. Owned by this
    // thread; freed exactly once at teardown after CFRunLoopRun returns.
    let refcon = Box::into_raw(Box::new(app)) as *mut c_void;

    let mask: u64 = 1u64 << KCG_EVENT_FLAGS_CHANGED; // CGEventMaskBit(kCGEventFlagsChanged)
    let tap = CGEventTapCreate(
        KCG_SESSION_EVENT_TAP,
        KCG_HEAD_INSERT_EVENT_TAP,
        KCG_EVENT_TAP_OPTION_LISTEN_ONLY,
        mask,
        tap_callback,
        refcon,
    );

    // NULL tap ⇒ Input Monitoring not granted. Log WITHOUT any key/content, leave RECORDING
    // untouched, let the UI hint surface. NEVER call CFMachPortCreateRunLoopSource(NULL).
    if tap.is_null() {
        eprintln!("[fnkey] tap create failed — Input Monitoring not granted");
        drop(Box::from_raw(refcon as *mut AppHandle));
        RUNNING.store(false, Ordering::SeqCst);
        return;
    }

    let src = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
    if src.is_null() {
        eprintln!("[fnkey] run loop source create failed");
        CFRelease(tap as CFTypeRef);
        drop(Box::from_raw(refcon as *mut AppHandle));
        RUNNING.store(false, Ordering::SeqCst);
        return;
    }

    let rl = CFRunLoopGetCurrent();
    CFRunLoopAddSource(rl, src, kCFRunLoopCommonModes);
    CGEventTapEnable(tap, true);

    // Publish the pointers the other thread / callback need, then mark running.
    *FN_TAP.lock().unwrap() = Some(SendPtr(tap));
    *FN_RUNLOOP.lock().unwrap() = Some(SendPtr(rl));
    RUNNING.store(true, Ordering::SeqCst);
    eprintln!("[fnkey] event tap started (keycode {})", keycode);

    CFRunLoopRun(); // blocks here until CFRunLoopStop(rl) on the main thread

    // ── teardown (still on the tap thread) ──
    CGEventTapEnable(tap, false);
    CFRunLoopRemoveSource(rl, src, kCFRunLoopCommonModes);
    CFRelease(src as CFTypeRef);
    CFRelease(tap as CFTypeRef);
    *FN_TAP.lock().unwrap() = None;
    *FN_RUNLOOP.lock().unwrap() = None;

    // Reclaim the AppHandle and, if a hold was still in progress when PTT was turned off,
    // end the session cleanly (emit one stop) so we never leave RECORDING stuck true.
    let app_box = Box::from_raw(refcon as *mut AppHandle);
    {
        let mut rec = crate::RECORDING.lock().unwrap();
        let mut active = FN_ACTIVE.lock().unwrap();
        if *active && *rec {
            *rec = false;
            let _ = app_box.emit("dictation", "stop");
        }
        *active = false;
    }
    drop(app_box);

    RUNNING.store(false, Ordering::SeqCst);
    eprintln!("[fnkey] event tap stopped");
}

fn start_tap(app: &AppHandle, ptt_key: &str) {
    let mut slot = FN_THREAD.lock().unwrap();
    if let Some(h) = slot.as_ref() {
        if !h.is_finished() {
            return; // a live tap thread already runs
        }
    }
    if let Some(done) = slot.take() {
        let _ = done.join(); // reap a finished thread (e.g. a prior NULL-tap failure)
    }
    let keycode = keycode_for(ptt_key);
    let app_owned = app.clone();
    let handle = std::thread::Builder::new()
        .name("verbatim-fnkey".into())
        .spawn(move || unsafe { run_tap_thread(app_owned, keycode) })
        .ok();
    *slot = handle;
}

fn stop_tap() {
    // Ask the run loop to return (CFRunLoopStop is thread-safe), then join the thread so
    // teardown (CFRelease + AppHandle free) completes before we return.
    if let Some(rl) = FN_RUNLOOP.lock().unwrap().as_ref() {
        unsafe { CFRunLoopStop(rl.0) };
    }
    let joiner = FN_THREAD.lock().unwrap().take();
    if let Some(join) = joiner {
        let _ = join.join();
    }
}

// ─────────────────────────────── public surface ─────────────────────────────────
/// Start or stop the Fn/PTT event tap. Only runs the tap when `on` is true, so a user who
/// never enables PTT is never prompted for Input Monitoring. A key change while running is
/// a stop-then-start; same key while running is a no-op; off while stopped is a no-op.
pub fn set_enabled(app: &AppHandle, on: bool, ptt_key: &str) {
    if on {
        let want = ptt_key.to_string();
        let same = RUNNING.load(Ordering::SeqCst) && *CURRENT_KEY.lock().unwrap() == want;
        if same {
            return;
        }
        stop_tap(); // stop any prior tap (key change) / reap a finished thread
        *CURRENT_KEY.lock().unwrap() = want.clone();
        start_tap(app, &want);
    } else {
        *CURRENT_KEY.lock().unwrap() = String::new();
        stop_tap();
    }
}

/// Is the tap thread currently running? (For the Settings status line.)
pub fn is_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

/// Input Monitoring granted? Non-mutating IOKit read, safe to poll from Settings — the
/// Input-Monitoring analogue of AXIsProcessTrusted.
pub fn input_monitoring_status() -> bool {
    unsafe { IOHIDCheckAccess(K_IOHID_REQUEST_TYPE_LISTEN_EVENT) == K_IOHID_ACCESS_TYPE_GRANTED }
}

/// Prompt for / add Verbatim to the Input Monitoring list (first-enable UX). The TCC
/// dialog also appears the first time CGEventTapCreate runs; this makes it proactive.
pub fn request_input_monitoring() {
    unsafe {
        let _ = IOHIDRequestAccess(K_IOHID_REQUEST_TYPE_LISTEN_EVENT);
    }
}
