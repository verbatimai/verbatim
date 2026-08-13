# Settings — Phase 5 (Wave 4 · Native spike: Fn push-to-talk) Implementation + Spike Plan

**Owner:** Mayank Banga · Saaslabs
**Date:** 13 Aug 2026
**Scope:** `settings-plan.md` **§5 "Wave 4 — Native spike: Fn push-to-talk"** (and Risk §10.3).
Hold a bare key (Fn) to dictate, release to stop, **without stealing focus**; degrade cleanly
when **Input Monitoring** isn't granted. This needs a native `CGEventTap` on a background
thread — it lives *outside* `tauri-plugin-global-shortcut`, which can't bind a bare modifier.

**⚠ This is native macOS Rust. It CANNOT be compiled or verified in the cloud.** Everything
under `apps/widget/src-tauri` must `cargo build` / `npm run widget` on the Mac. The deliverable
is *authored* code plus an unusually careful **on-Mac verification protocol**. Only the
`settings.ts` / `settings.html` (TS/HTML) slice is cloud-checkable (`tsc --noEmit`).

**Treat this as a spike, not a feature.** The plan front-loads a **Feasibility Gate (§1)**:
prove the Fn tap fires a distinguishable press/release event *before* wiring any UI or config.
If Fn is unusable, fall back to a bare **Right-Command** key (chosen below) and keep moving.

---

## 0. Current state (what Phases 1–4 already landed)

The pieces this phase builds on all exist in the live repo:

- **The `dictation` event contract.** The global-shortcut handler emits exactly two payloads:
  `app.emit("dictation", "start")` (`main.rs:1046`) and `app.emit("dictation", "stop")`
  (`main.rs:1038`, `main.rs:1065`). The webview listens at `main.ts:552-555`:
  `start → beginDictation()`, `stop → if (ws) stop()`. **Fn PTT must emit these same two
  payloads and nothing else** — then the entire front-end path is reused for free, including
  the `if (ws)` guard that makes a duplicate `stop` a harmless no-op.
- **The toggle/PTT state machine** already exists for the *global-shortcut* path:
  `RECORDING` (`main.rs:16`), `PRESS_AT` (`:17`), `STARTED_THIS_PRESS` (`:18`), `HOLD_MS=300`
  (`:19`), driven in the handler at `main.rs:1025-1069`. Fn PTT is a *second* producer of the
  same `dictation` events and must share `RECORDING` to avoid conflicting start/stop (§4).
- **The Permissions pane** (`settings.html:463-488`) has two rows — Microphone and
  Accessibility — each: `<h3>` + `<p id="…Status" class="status">Checking…</p>` +
  `<button id="open…" class="btn">Open Settings</button>`. Wired in `settings.ts` by
  `refreshMicStatus` (`:428`), `refreshAxStatus` (`:442`), and the `openMic`/`openAx` clicks
  (`:452-453`). Input Monitoring mirrors this exactly.
- **The permission command pattern.** `ax_trusted()` (`main.rs:588`) calls
  `axinject::is_trusted()` → `AXIsProcessTrusted()` via a `#[link(name = "ApplicationServices",
  kind = "framework")]` FFI block (`axinject.rs:33-54`, `:274`). `open_accessibility_settings`
  (`main.rs:574`) calls `open_privacy_pane("Privacy_Accessibility")` (`:553`), which `open`s
  `x-apple.systempreferences:com.apple.preference.security?<anchor>`. Input Monitoring reuses
  both patterns verbatim (anchor `Privacy_ListenEvent`).
- **The "Push to talk" row** is a static `Planned` placeholder after Phase 4
  (`settings.html:335-341`): `<h3>Push to talk <span class="tag planned">Planned</span></h3>`
  + `<span class="kbd-group"><kbd>Fn</kbd></span>`. This phase makes it active.
- **Config plumbing.** `AppConfig` (`main.rs:106-127`, `#[serde(rename_all="camelCase",
  default)]`), its `Default` (`:129-152`), the shallow-merge `set_config` with per-field
  change-guards (`:183-217`), `clear_config` (`:237-254`), and the TS mirror
  `type AppConfig` (`settings.ts:9-28`). New fields slot in the same way (§5).
- **FFI precedent for a background native thread.** `axinject.rs` already does raw
  Objective-C / framework FFI directly (`#[link(name="objc")]`, ApplicationServices) *rather
  than adding crates*, explicitly to keep Cargo.lock churn tiny (`axinject.rs:57-64`). Wave 4
  follows the same discipline (§6).

---

## 1. FEASIBILITY GATE — do this first, before any UI/config

> The single biggest unknown (Risk §10.3) is whether the **Fn / globe key** even reaches a
> session-level `CGEventTap` as a distinguishable press/release. Prove it with a throwaway
> binary **before** touching `AppConfig`, `settings.html`, or the permission rows. Timebox: ~½ day.

### 1.1 What "Fn is special" actually means

- On modern Macs the Fn key is also the **🌐 Globe** key. **System Settings → Keyboard →
  "Press 🌐 key to:"** can bind it to *Show Emoji & Symbols*, *Change Input Source*, *Start
  Dictation*, or *Do Nothing*. If bound to anything but "Do Nothing," a press may open that
  system UI and/or be consumed before/after our tap sees it.
- At the CGEvent layer, Fn shows up as a **`kCGEventFlagsChanged`** event (it's modifier-ish),
  with the **`kCGEventFlagMaskSecondaryFn` (0x800000)** bit toggling on press and off on
  release. On built-in Apple keyboards the flagsChanged event also carries **keycode 63**
  (`kVK_Function`). On some external keyboards Fn never emits a CGEvent at all (handled in
  firmware) — hence the mandatory fallback key.

### 1.2 Spike harness (throwaway, not shipped)

Write a tiny standalone binary (a scratch `fnspike.rs` `[[bin]]`, or a `#[cfg(feature="fnspike")]`
gate) that:

1. Creates a **listen-only** session event tap for flagsChanged (see §3 for the exact FFI).
2. In the callback, `eprintln!` the event type, the raw flags, and the keycode
   (`CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode)` — field id 9).
3. **Returns the event unmodified** (never consumes it).
4. Runs a `CFRunLoop` on the main thread.

Then, on the Mac, physically:

- [ ] Grant the spike binary Input Monitoring (it'll prompt / need adding to the list).
- [ ] Hold and release **Fn** → confirm you see a flagsChanged with `secondaryFn` set then
      clear, keycode 63. Note whether the emoji/dictation picker also fires.
- [ ] Set Keyboard → "Press 🌐 key to: **Do Nothing**", repeat → confirm cleaner behaviour.
- [ ] Hold **Right-Command** (keycode 54), **Right-Option** (61), **Right-Control** (62) →
      confirm each emits a distinguishable flagsChanged press/release with its own keycode.
- [ ] Confirm typing into a *different* app during the hold is unaffected (no focus steal, no
      swallowed keys) — this validates listen-only.

### 1.3 Decision the spike must produce

- **If Fn is clean** (fires reliably, doesn't pop system UI when set to "Do Nothing"): ship Fn
  as the default `ptt_key`, but keep the fallback selectable.
- **If Fn is flaky/consumed:** ship with **Right-Command as the default** and Fn as an
  opt-in "may require Keyboard → 🌐 → Do Nothing" choice.

**Chosen fallback (pre-spike recommendation): Right-Command (`kVK_RightCommand`, keycode 54).**
Rationale: it's a real flagsChanged modifier (clean press/release), is **distinguishable from
Left-Command by keycode** (54 vs 55) so ⌘-shortcuts on the left hand are untouched, and has **no
default system action** when tapped alone (unlike Fn/Globe, Right-Option's dead-key input, or
Caps-Lock's toggle-latch semantics). Right-Option (61) is the second choice if the user wants a
non-Command key.

**Everything below assumes the gate passed.** If it didn't, the only change is the default value
of `ptt_key` and one line of Settings copy.

---

## 2. Goal (acceptance)

Hold the configured PTT key → dictation **starts** (same path as ⌥Space start); release → it
**stops**; the app you were typing in keeps focus throughout (text still lands there, never in
the widget). If Input Monitoring isn't granted, the feature is **visibly disabled with a hint**
and the app is otherwise unaffected (no crash, no hang, toggle hotkey still works). The tap runs
only when the feature is enabled, so a user who never turns PTT on is never prompted for Input
Monitoring.

---

## 3. Architecture — `apps/widget/src-tauri/src/fnkey.rs`

A new, **macOS-only** module (`#![cfg(target_os = "macos")]`, `mod fnkey;` behind
`#[cfg(target_os = "macos")]` next to `mod axinject;` at `main.rs:11-12`).

### 3.1 Thread + run loop model

```
set_config(fnPushToTalk: true)  ─────►  fnkey::set_enabled(app, true)
                                          │
                                          ├─ spawn a std::thread ("verbatim-fnkey")
                                          │    └─ CGEventTapCreate(listenOnly, flagsChanged)
                                          │       CFMachPortCreateRunLoopSource(tap)
                                          │       CFRunLoopAddSource(current, src, kCFRunLoopCommonModes)
                                          │       CGEventTapEnable(tap, true)
                                          │       stash CFRunLoopGetCurrent() into a static so the
                                          │         main thread can stop it later
                                          │       CFRunLoopRun()   ← blocks this thread
                                          │
set_config(fnPushToTalk: false) ─────►  fnkey::set_enabled(app, false)
                                          └─ CFRunLoopStop(stashed runloop) + CGEventTapEnable(false)
                                             → CFRunLoopRun() returns, thread cleans up & joins
```

- **The tap is `kCGEventTapOptionListenOnly`** (passive). The callback **returns `event`
  unmodified** (for listen-only taps the return value is ignored, but we return it anyway and
  never call any mutate/consume API) → **no focus steal, no swallowed keystrokes**. This is the
  hard requirement; a `kCGEventTapOptionDefault` tap that returned NULL would eat the key.
- **Location `kCGSessionEventTap`, placement `kCGHeadInsertEventTap`.** Session-level (not
  annotated-session) is what Input Monitoring gates; head-insert so we observe early.
- **Event mask:** `CGEventMaskBit(kCGEventFlagsChanged)` = `1 << 12`. Flags-changed only — we
  never tap keyDown/keyUp, so we can't observe typed content (secrets/content never seen or
  logged, per guardrails).

### 3.2 The callback → emit path

The C tap callback is `extern "C" fn(proxy, type, event, user_info) -> CGEventRef`. We pass a
**heap `AppHandle`** as `user_info` (refcon): `Box::into_raw(Box::new(app.clone())) as *mut
c_void`. Inside the callback, reconstruct `&AppHandle` from the pointer (do **not** drop it —
it's owned by the running tap; free it on teardown). `tauri::AppHandle` is `Send + Sync` and
`emit` is thread-safe, so emitting from the tap thread is fine.

Callback logic (the *only* place fnkey touches shared state):

```
on flagsChanged:
    keycode = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode)  // field 9
    if keycode != configured_ptt_keycode { return event }   // ignore other modifiers
    flags = CGEventGetFlags(event)
    is_down = (flags & mask_for(keycode)) != 0   // secondaryFn / maskCommand / maskAlternate
    if is_down  -> fnkey_press(app)
    else        -> fnkey_release(app)
    return event   // NEVER consume
```

`mask_for(keycode)`: Fn→`kCGEventFlagMaskSecondaryFn` (0x800000), RightCmd/LeftCmd→
`kCGEventFlagMaskCommand` (0x100000), RightOpt→`kCGEventFlagMaskAlternate` (0x80000). Because
flagsChanged reports *cumulative* flags, "is this key now down" = "is this key's flag bit set in
the post-event flags" — correct for a single tracked modifier. (Guard against auto-repeat: a
flagsChanged only fires on actual state change, so no repeat storm; still, `fnkey_press` is
idempotent via `FN_ACTIVE`.)

### 3.3 Reading config inside the callback

`configured_ptt_keycode` and the enabled flag come from `read_config(app)` (§0). Reading the
store on every flagsChanged is cheap enough (it's an in-memory `tauri-plugin-store`), but to be
safe cache the keycode in an `AtomicI64` updated by `set_enabled` and only re-read on change.
The callback must **early-return for any non-tracked keycode**, which is the overwhelming common
case (every ⌘/⌥/⌃/⇧ press), so cost is one atomic load + compare.

### 3.4 Non-`Send` pointer handling (spike gotcha)

`CFRunLoopRef` / `CFMachPortRef` are raw pointers → not `Send`. To let the main thread call
`CFRunLoopStop`, wrap the runloop pointer in a `struct RunLoopHandle(*mut c_void); unsafe impl
Send for RunLoopHandle {}` and store `static FN_RUNLOOP: Mutex<Option<RunLoopHandle>>`. The tap
+ mach port are created, used, and destroyed **entirely on the tap thread**; only the runloop
*pointer* crosses threads (for `CFRunLoopStop`, which is documented thread-safe). Also store the
boxed-AppHandle raw pointer so teardown can `drop(Box::from_raw(..))` after the runloop exits.

### 3.5 Public surface of `fnkey.rs`

```rust
// macOS-only. No-ops compiled out elsewhere via #[cfg].
pub fn set_enabled(app: &tauri::AppHandle, on: bool, ptt_key: &str);  // start/stop the tap thread
pub fn is_running() -> bool;                                          // for the status indicator
pub fn input_monitoring_status() -> bool;    // IOHIDCheckAccess == granted (see §7)
pub fn request_input_monitoring();           // IOHIDRequestAccess(listenEvent) — prompt/add-to-list
```

`set_enabled(_, false, _)` when not running, and `(_, true, _)` when already running with the
same key, are both no-ops; a key *change* while running = stop+start. Keep it dumb and explicit.

---

## 4. Concurrency with the existing toggle (no double-fire)

Both the global-shortcut handler (`main.rs:1025-1069`) and the Fn tap emit `dictation`
start/stop and both mutate `RECORDING`. To guarantee no conflicting/duplicate events, Fn PTT
adds **one** new flag and shares `RECORDING`:

```rust
static FN_ACTIVE: Mutex<bool> = Mutex::new(false);   // a Fn-hold session is in progress
```

- **Fn press** — lock `RECORDING`:
  - if already `true` (a toggle session or a prior Fn hold is live) → **do nothing** (no second
    start). Optionally set `FN_ACTIVE=true` only if *we* started it; safer: don't hijack a
    toggle session — leave `FN_ACTIVE=false` so releasing Fn won't stop a toggle session.
  - if `false` → set `RECORDING=true`, `FN_ACTIVE=true`, then
    `if let Some(win) = app.get_webview_window("main") { let _ = win.show(); }` (the exact
    idiom at `main.rs:1041-1043` — **show, never `set_focus`**, so the panel stays
    non-activating), `app.emit("dictation", "start")`. (`win("main")` above is shorthand — there
    is no `win()` helper; use `get_webview_window`.)
- **Fn release** — lock `RECORDING`:
  - if `FN_ACTIVE && *RECORDING` → set both `false`, `app.emit("dictation", "stop")`.
  - else (Fn wasn't what started the live session, e.g. the user tapped ⌥Space to stop
    mid-hold) → just clear `FN_ACTIVE`, **emit nothing**. No double-stop.

Defense in depth: even if a stray extra `stop` slipped through, `main.ts:554`
(`stop → if (ws) stop()`) makes it a no-op when no session is live. And `PRESS_AT` /
`STARTED_THIS_PRESS` / `HOLD_MS` are **not** touched by Fn — those are the *toggle* path's
tap-vs-hold discriminator; Fn is unconditionally hold-to-talk, so it needs none of them.

**Edge case to verify on-Mac (checklist §8):** hold Fn *and* press the toggle hotkey while
held. Expected: the toggle press either starts (if Fn hadn't) or stops (its own logic); Fn
release then no-ops because `RECORDING`/`FN_ACTIVE` disagree. Confirm the session ends in a sane
state (not stuck recording).

---

## 5. Config delta

Add **two** fields, following the §0 pattern (struct + `Default` + TS mirror, each
`#[serde(default)]` via the struct-level `default`).

| Field (camelCase) | Rust type | Default | Drives |
|---|---|---|---|
| `fn_push_to_talk` | `bool` | `false` | master enable for the Fn/PTT event tap |
| `ptt_key` | `String` | `"fn"` (or `"right_cmd"` if §1 gate fails) | which bare key: `"fn"` \| `"right_cmd"` \| `"right_opt"` |

**`main.rs` — `AppConfig` struct** (after `telemetry`, `:126`):
```rust
    fn_push_to_talk: bool,  // Wave 4 — hold a bare key (Fn) to dictate (needs Input Monitoring)
    ptt_key: String,        // Wave 4 — which bare key: "fn" | "right_cmd" | "right_opt"
```
**`main.rs` — `Default` impl** (after `telemetry: false,`, `:149`):
```rust
            fn_push_to_talk: false,
            ptt_key: "fn".into(),
```
**`settings.ts` — `type AppConfig`** (after `telemetry?`, `:27`):
```ts
  fnPushToTalk?: boolean; // Wave 4 — hold a bare key (Fn) to dictate
  pttKey?: string;        // Wave 4 — "fn" | "right_cmd" | "right_opt"
```

**`set_config` side-effect** (in the change-guard block, alongside the paste-last guard at
`main.rs:210-213`):
```rust
    // Wave 4 — start/stop the Fn PTT event tap when the toggle OR the key changes.
    #[cfg(target_os = "macos")]
    if next.fn_push_to_talk != old.fn_push_to_talk || next.ptt_key != old.ptt_key {
        fnkey::set_enabled(&app, next.fn_push_to_talk, &next.ptt_key);
    }
```

**`clear_config`** (`main.rs:237-254`): default is `fn_push_to_talk=false`, so add — after the
autostart reset (`:247`):
```rust
    #[cfg(target_os = "macos")]
    fnkey::set_enabled(&app, def.fn_push_to_talk, &def.ptt_key); // Wave 4 — tear the tap down on reset
```

**Startup reconcile** (in `setup`, near the autostart reconcile at `main.rs:956`, inside the
`#[cfg(desktop)]` block — but gate the body on `target_os="macos"`):
```rust
    #[cfg(target_os = "macos")]
    {
        let c = read_config(app.handle());
        fnkey::set_enabled(app.handle(), c.fn_push_to_talk, &c.ptt_key);
    }
```
So a user who had PTT enabled gets the tap back on relaunch; a user who never enabled it is
never prompted.

---

## 6. Cargo.toml — dependencies

**Recommendation: add no new crates; declare the FFI directly**, matching `axinject.rs`'s
deliberate "avoid Cargo.lock churn against the parallel session" choice (`axinject.rs:57-64`).

- **CoreGraphics** (event tap: `CGEventTapCreate`, `CGEventTapEnable`, `CGEventGetFlags`,
  `CGEventGetIntegerValueField`, and the `kCGEventTap*` / `kCGEventFlagMask*` constants) and
  **IOKit** (`IOHIDCheckAccess`, `IOHIDRequestAccess`) via `#[link(name="…", kind="framework")]`
  blocks inside `fnkey.rs` — exactly like `axinject.rs:33` links ApplicationServices.
- **CoreFoundation run-loop plumbing** (`CFMachPortCreateRunLoopSource`, `CFRunLoopGetCurrent`,
  `CFRunLoopAddSource`, `CFRunLoopRun`, `CFRunLoopStop`, `kCFRunLoopCommonModes`): reuse
  **`core-foundation = "0.10"`** — **already vendored** (`Cargo.toml:34`) — for `CFRunLoop` /
  `CFMachPort` raw refs and `TCFType`, or declare these few CF functions by hand. Either way,
  **no Cargo change required.**

If the reviewer prefers typed wrappers over hand FFI, the alternative is the `core_graphics`
crate's `event` module under the existing `[target.'cfg(target_os = "macos")'.dependencies]`
block (`Cargo.toml:30`). **Reviewer correction:** do **not** pin `core-graphics = "0.24"` —
`Cargo.lock` already carries **0.23.2 and 0.25.0** transitively (plus `objc2-core-graphics
0.3.2`), so `"0.24"` would resolve a *third* version and *increase* churn. If this route is ever
taken, reuse the already-vendored **`0.25`**. **Flagged as an open question (§11)** — its
tap-builder API is thin and version-sensitive, and the hand-FFI route keeps this consistent with
the existing native code and adds zero crates. No new capability entry is needed:
custom `#[tauri::command]`s (like `ax_trusted`) aren't plugin commands, so
`capabilities/default.json` is untouched.

---

## 7. Permissions — Input Monitoring (TCC `kTCCServiceListenEvent`)

Input Monitoring is a **separate** TCC service from Accessibility. Mirror the Accessibility
plumbing:

**New Rust commands** (`main.rs`, next to `ax_trusted` / `open_accessibility_settings`,
`:574-598`; register all three in the `invoke_handler!` list at `:1138-1167`):

```rust
#[tauri::command]
fn input_monitoring_trusted() -> bool {
    #[cfg(target_os = "macos")] { fnkey::input_monitoring_status() }
    #[cfg(not(target_os = "macos"))] { true }
}

#[tauri::command]
fn open_input_monitoring_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")] { open_privacy_pane("Privacy_ListenEvent") }  // reuse :553
    #[cfg(not(target_os = "macos"))] { Ok(()) }
}

#[tauri::command]
fn request_input_monitoring() {
    #[cfg(target_os = "macos")] { fnkey::request_input_monitoring(); }        // IOHIDRequestAccess
}
```

**Detection (`fnkey::input_monitoring_status`)** — IOKit HID, macOS 10.15+:
```
IOHIDAccessType IOHIDCheckAccess(IOHIDRequestType type);   // kIOHIDRequestTypeListenEvent = 1
// return values: kIOHIDAccessTypeGranted = 0, Denied = 1, Unknown = 2
```
→ `status == 0`. This is the proactive, non-mutating status read (the Input-Monitoring analogue
of `AXIsProcessTrusted`), safe to poll from the Settings screen.

**Requesting.** `bool IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)` shows the system prompt /
adds Verbatim to the Input Monitoring list on first call. **Additionally**, simply *creating* the
session tap (§3) triggers the TCC prompt the first time — so the natural runtime request is:
enable the feature → `set_enabled` tries to build the tap → if `CGEventTapCreate` returns
**NULL**, treat that as "not granted yet" (log `[fnkey] tap create failed — Input Monitoring not
granted`, no secret/content), leave `RECORDING` untouched, and let the UI surface the hint. Call
`request_input_monitoring()` when the user first flips the toggle so the prompt appears
proactively rather than silently failing.

**Important UX caveat (Risk §10):** granting Input Monitoring often requires **quit & relaunch**
before a newly-created tap works (same as Accessibility today — see `main.ts:262`). The hint copy
must say so.

**Info.plist / entitlements:** Input Monitoring needs **no** usage-description string (unlike the
mic's `NSMicrophoneUsageDescription` at `Info.plist`) and **no** new entitlement — the app is
already un-sandboxed with the hardened runtime (`entitlements.plist`). Nothing to add there.
Confirm on-Mac that the un-sandboxed dev build appears in the Input Monitoring list at all
(§8) — this is a known spike unknown for ad-hoc-signed builds.

---

## 8. UI edits

### 8.1 Permissions pane — add an Input Monitoring row

**`settings.html`**, inside the Permissions `card`, after the Accessibility row (`:486`, before
the card `</div>` at `:487`):
```html
            <div class="set-row">
              <div class="meta">
                <h3>Input Monitoring</h3>
                <p id="imStatus" class="status">Checking…</p>
              </div>
              <button id="openIm" class="btn">Open Settings</button>
            </div>
```

**`settings.ts`**:
- Add refs next to `micStatusEl`/`axStatusEl` (`:82-85`):
  ```ts
  const imStatusEl = $("imStatus");
  const openImEl = $<HTMLButtonElement>("openIm");
  ```
- Add `refreshImStatus()` mirroring `refreshAxStatus` (`:442-451`):
  ```ts
  async function refreshImStatus() {
    try {
      const ok = await invoke<boolean>("input_monitoring_trusted");
      imStatusEl.textContent = ok
        ? "✓ Granted — push-to-talk can watch the key"
        : "Not granted — push-to-talk is disabled until you allow it (then relaunch)";
      imStatusEl.classList.toggle("ok", ok);
      imStatusEl.classList.toggle("bad", !ok);
    } catch (e) { imStatusEl.textContent = "Couldn't check: " + String(e); }
  }
  ```
- Wire the button next to `openMic`/`openAx` (`:452-453`):
  ```ts
  openImEl.onclick = () => { void invoke("open_input_monitoring_settings").catch(() => {}); setTimeout(() => void refreshImStatus(), 1200); };
  ```
- Call `void refreshImStatus();` in `DOMContentLoaded` next to `refreshAxStatus()` (`:769-770`).

### 8.2 Shortcuts pane — make "Push to talk" active

Replace the static placeholder row (`settings.html:335-341`) with a real toggle + a key picker
+ a status line:
```html
            <div class="set-row">
              <div class="meta">
                <h3>Push to talk</h3>
                <p>Hold a key to dictate while it's pressed. Needs Input Monitoring.</p>
                <p id="pttStatus" class="status"></p>
              </div>
              <div class="control-col align-end">
                <label class="switch"><input type="checkbox" id="pttEnable" /><span></span></label>
                <select id="pttKey">
                  <option value="fn">Fn (🌐)</option>
                  <option value="right_cmd">Right ⌘</option>
                  <option value="right_opt">Right ⌥</option>
                </select>
              </div>
            </div>
```

**`settings.ts`** — add refs, an `initPtt()` (called in `DOMContentLoaded` and `refreshControls`,
`:708-723` / `:746-771`):
```ts
const pttEnableEl = $<HTMLInputElement>("pttEnable");
const pttKeyEl = $<HTMLSelectElement>("pttKey");
const pttStatusEl = $("pttStatus");

async function initPtt() {
  if (!pttEnableEl) return;
  pttEnableEl.checked = !!config.fnPushToTalk;
  pttKeyEl.value = config.pttKey ?? "fn";
  pttKeyEl.disabled = !pttEnableEl.checked;
  pttEnableEl.onchange = async () => {
    // Prompt for Input Monitoring the first time PTT is turned on.
    if (pttEnableEl.checked) { try { await invoke("request_input_monitoring"); } catch {} }
    await patchConfig({ fnPushToTalk: pttEnableEl.checked });
    pttKeyEl.disabled = !pttEnableEl.checked;
    await refreshImStatus(); await refreshPttStatus();
  };
  pttKeyEl.onchange = async () => { await patchConfig({ pttKey: pttKeyEl.value }); };
  await refreshPttStatus();
}

async function refreshPttStatus() {
  if (!pttStatusEl) return;
  const granted = await invoke<boolean>("input_monitoring_trusted").catch(() => false);
  if (config.fnPushToTalk && !granted)
    pttStatusEl.textContent = "Grant Input Monitoring in Permissions, then quit & relaunch.";
  else pttStatusEl.textContent = "";
}
```

Note: **PTT is Fn-only in the row copy if the §1 gate downgrades Fn** — then default the `<select>`
to `right_cmd` and reorder options. TS is unaffected (it just persists the string).

---

## 9. On-Mac verification protocol (REQUIRED — the deliverable is unverifiable until this passes)

Run on the Mac after `cargo build` / `npm run widget` is clean. Nothing below is cloud-runnable.

**Build / smoke**
- [ ] `cargo build` in `apps/widget/src-tauri` compiles (`fnkey.rs` FFI links CoreGraphics /
      IOKit / CoreFoundation; no `E0308` from CF ref types).
- [ ] `npm run widget` launches; overlay + tray behave exactly as before with PTT **off**
      (regression: toggle ⌥Space still starts/stops; ⌥⇧V paste-test still works).
- [ ] With PTT off, the app **never** prompts for Input Monitoring on launch.

**Permission flow**
- [ ] Settings → Permissions shows an **Input Monitoring** row reading "Not granted…" on a
      fresh machine.
- [ ] Flip **Shortcuts → Push to talk → on**: the macOS Input Monitoring prompt appears (or
      Verbatim is added to the list). The `pttStatus` hint says "grant … then quit & relaunch."
- [ ] Grant Input Monitoring in System Settings; **quit & relaunch** Verbatim.
- [ ] Input Monitoring row now reads "✓ Granted"; `input_monitoring_trusted` returns true.
- [ ] Confirm the (un-sandboxed, ad-hoc-signed) **dev** build actually appears/toggles in the
      Input Monitoring list — if not, note it as a signing caveat (Risk §10).

**Core PTT behaviour (with the chosen `ptt_key`)**
- [ ] Focus a text field in another app (TextEdit / browser / Notes). **Hold the PTT key** →
      the overlay shows and dictation **starts** (status "listening"), speak a sentence.
- [ ] **Release** the PTT key → dictation **stops**, finalizes, and the text is **injected into
      that other app's field** — i.e. focus never left it.
- [ ] **No focus steal:** while holding, keep typing on the *keyboard* into the target app —
      characters land in the target app, not the widget (validates listen-only + non-key panel).
- [ ] Repeat 5× rapidly (hold/release) → no stuck-recording state, no orphaned session, no
      duplicated start/stop in logs.

**Fallback key**
- [ ] Switch `ptt_key` to **Right ⌘** (or Right ⌥) in the dropdown; hold/release → works the
      same. Confirm **Left-⌘ shortcuts (⌘C/⌘V/⌘Tab) are unaffected** (keycode discrimination).
- [ ] If Fn was chosen: set Keyboard → "Press 🌐 key to: Do Nothing" and confirm Fn no longer
      pops emoji/dictation while still driving PTT.

**Toggle + PTT interaction (no conflict)**
- [ ] With a toggle session live (tapped ⌥Space to start), press & release the PTT key →
      does **not** double-start or prematurely stop; session state stays sane.
- [ ] Start via PTT (hold), then tap ⌥Space to stop mid-hold, then release PTT → ends cleanly,
      **no double "stop"**, not stuck recording.
- [ ] Start via PTT and release normally, then use ⌥Space normally → both still independent.

**Graceful degradation**
- [ ] Revoke Input Monitoring in System Settings while the app runs → holding the PTT key does
      nothing (no crash/hang); `input_monitoring_trusted` flips to false on next Settings open;
      toggle hotkey + all other settings keep working.
- [ ] Turn PTT **off** in Settings → the event tap thread stops (verify via a debug log line;
      confirm no lingering CPU from a spinning run loop); re-enabling starts it again.
- [ ] Quit the app with PTT on → the tap thread exits (no orphaned thread / no leaked run loop);
      relaunch reconciles PTT back on from config.

**Content-safety**
- [ ] `grep` the run logs (debug on) for any keystroke/transcript content from the tap path →
      **none** (fnkey only taps flagsChanged and never logs values).

---

## 10. Cloud-runnable (the only slice verifiable off-Mac)

Only the TS/HTML edits (§5 TS mirror, §8 Settings UI) are cloud-checkable. Rust is **not**.

- [ ] `cd apps/widget && npx tsc --noEmit` → **exit 0** after adding `fnPushToTalk?`/`pttKey?` to
      `type AppConfig` (`settings.ts:9-28`) and the new element refs / `initPtt` / `refreshImStatus`
      / `refreshPttStatus` (guard every `$()` ref against null as the existing code does, e.g.
      `if (!pttEnableEl) return;`, so a missing element can't throw on load — matches the
      Phase-1 "TypeError on Settings open" lesson).
- [ ] Static greps on `settings.html`: `id="imStatus"` → 1, `id="openIm"` → 1, `id="pttEnable"`
      → 1, `id="pttKey"` → 1; `<div>`/`</div>` balance unchanged (the Push-to-talk row swap is
      net-neutral on wrapper count).
- [ ] Grep `settings.ts` for `input_monitoring_trusted` / `open_input_monitoring_settings` /
      `request_input_monitoring` → each referenced; and that the three new Rust command names
      match the `invoke(...)` strings exactly (no cloud compile to catch a typo — spell-check by
      eye against §7).

---

## 11. Risks

1. **Fn interception / firmware handling (highest).** Fn may never reach a session tap on some
   external keyboards, or pop the Globe UI when tapped. **Mitigation:** the §1 feasibility gate
   runs first; ship Right-Command as the default fallback if Fn is flaky; expose `ptt_key` so
   the user can choose.
2. **Input Monitoring UX friction.** Granting it typically needs a **quit & relaunch** before a
   fresh tap works, and the TCC prompt only appears on first tap-create / `IOHIDRequestAccess`.
   Ad-hoc-signed **dev** builds may register a *new* TCC identity per rebuild (same root cause as
   the Keychain re-prompt in §1.6) → the app can vanish from / re-appear in the Input Monitoring
   list across builds. **Mitigation:** clear hint copy ("grant, then quit & relaunch"), the
   proactive status row, and treating a NULL tap as "not granted."
3. **Tap disabled by the system under load.** macOS disables an event tap if its callback is too
   slow (`kCGEventTapDisabledByTimeout`) or on user input excess
   (`kCGEventTapDisabledByUserInput`). **Mitigation:** handle those two event *types* in the
   callback by calling `CGEventTapEnable(tap, true)` to **re-enable**, and keep the callback
   trivial (one atomic compare + at most a lock + emit). Never block in the callback.
4. **Non-`Send` CF refs across the start/stop boundary** (§3.4) — mishandling risks a crash or a
   run loop that won't stop. **Mitigation:** create/destroy the tap+mach-port on the tap thread
   only; cross only the runloop pointer (for the thread-safe `CFRunLoopStop`) via a
   `RunLoopHandle(*mut c_void)` Send-newtype; free the boxed `AppHandle` after the run loop
   returns.
5. **Double-fire vs the toggle** — two producers of `dictation`. **Mitigation:** shared
   `RECORDING` + a single `FN_ACTIVE` flag with the exact rules in §4, plus the webview's
   `if (ws)` stop-guard (`main.ts:554`) as a backstop.
6. **Focus steal if the tap is ever non-passive.** A `Default` (non-listen-only) tap that
   returned NULL would swallow the key. **Mitigation:** `kCGEventTapOptionListenOnly` + always
   return the event unmodified; the §8 "keep typing during hold" check verifies it.
7. **Cannot compile in cloud** — a whole class of Rust errors (FFI signatures, CF ref type
   mismatches) is invisible until the Mac build. **Mitigation:** the module is small and
   self-contained; the §1 spike de-risks the FFI shape before it's wired into `main.rs`.

---

## 12. Open questions for reviewer

1. **Fn vs Right-Command as the shipped default** — decide after the §1 gate. If Fn is even
   slightly flaky, do we default to Right-⌘ and list Fn as "advanced (may need Keyboard → 🌐 →
   Do Nothing)", or default to Fn and accept the caveat? (Affects the `ptt_key` default and one
   line of copy only.)
2. **Hand-FFI vs `core-graphics` crate** (§6). Recommendation is hand-FFI to match `axinject.rs`
   and avoid Cargo.lock churn; confirm you don't prefer the typed `core_graphics::event` wrapper.
3. **Should PTT also start recording when the overlay is already showing an old result?** The
   toggle path shows-then-starts; PTT mirrors it, but confirm we don't want a "PTT ignores an
   open result card" nuance.
4. **`request_input_monitoring()` timing** — prompt on first toggle-on (planned), or only lazily
   when the tap first fails to create? Prompting eagerly is friendlier but fires the TCC dialog
   the moment they flip the switch.
5. **Key-repeat / accidental taps** — do we want a tiny debounce (e.g. ignore a hold < ~120 ms as
   an accidental brush), or is raw press/release fine? The toggle path uses `HOLD_MS=300` to
   split tap-vs-hold, but PTT has no tap semantics — leaning "no debounce," confirm.
6. **Multiple keyboards / karabiner-style remappers** in the field — out of scope for the spike,
   but flag if you want the gate to test one.
7. **Should turning PTT on auto-open the Permissions pane** if Input Monitoring isn't granted,
   rather than just showing the inline hint?
