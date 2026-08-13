# Settings — Phase 5 (Wave 4 · Fn push-to-talk, native macOS) — Progress

**Owner:** Mayank Banga · Saaslabs
**Date:** 13 Aug 2026
**Status:** **Authored — PENDING Mac build.** All native Rust in this phase is authored
correctness-first and CANNOT be compiled or verified in the cloud. The only cloud-verified
slice is the `settings.ts` / `settings.html` (tsc + static greps). **The deliverable is not
"done" until the §9 on-Mac protocol below passes on the Mac.**

---

## Summary

Implements Wave 4: hold a bare modifier (Fn / Right-⌘ / Right-⌥) to dictate, release to stop,
**without stealing focus**, degrading cleanly when Input Monitoring isn't granted. The mechanism
is a new `fnkey.rs` module running a **listen-only `CGEventTap`** for `flagsChanged` on a
dedicated background thread with its own `CFRunLoop`. It is a *second producer* of the existing
`app.emit("dictation", "start"|"stop")` contract, sharing `RECORDING` + a new `FN_ACTIVE` flag,
so the entire front-end path (`main.ts` listener, `beginDictation`, `if (ws)` stop-guard) is
reused verbatim. All FFI is hand-declared — **zero new Cargo crates** — matching the `axinject.rs`
precedent.

Every reviewer MUST-follow bullet (phase-5-review.md) is implemented:
- Callback **borrows** the refcon `AppHandle` (`&*(refcon as *const AppHandle)`) — never
  `Box::from_raw` in the callback. Freed exactly once on teardown after `CFRunLoopRun` returns.
- Callback matches `type` FIRST: re-enables the tap on `kCGEventTapDisabledByTimeout` /
  `…ByUserInput` (via a stashed tap ref), then returns the event.
- Tap is `kCGEventTapOptionListenOnly`, masks `flagsChanged` ONLY, and always returns the event
  UNMODIFIED (no focus steal, no swallowed keys).
- NULL tap ⇒ treated as "Input Monitoring not granted": logs without any key/content, leaves
  `RECORDING` untouched, early-returns before `CFMachPortCreateRunLoopSource(NULL)`.
- `RECORDING` locked across the whole check-and-set; `FN_ACTIVE` set under the same lock
  (consistent `RECORDING → FN_ACTIVE` order).
- Overlay summoned via `get_webview_window("main").show()`, never `set_focus`.
- Tap only runs when `fn_push_to_talk` is true (set_config side-effect + clear_config teardown +
  startup reconcile) → a user who never enables PTT is never prompted for Input Monitoring.
- Right-⌘ (keycode 54) distinguished from Left-⌘ (55) by keycode, so left-hand ⌘-shortcuts are
  untouched.

**Feasibility Gate (§1) note:** the throwaway Fn spike is an **on-Mac** step (it requires
physical key presses + Input Monitoring) and is the FIRST checklist item below. Per the plan/
review, if Fn proves flaky the ONLY change is the `ptt_key` default and one copy line — the code
already supports `fn` / `right_cmd` / `right_opt` and `keycode_for` falls back to Right-⌘ for any
unknown value.

---

## Files changed

- **NEW** `apps/widget/src-tauri/src/fnkey.rs` — the whole module. Hand-FFI `#[link]` blocks for
  CoreGraphics (`CGEventTapCreate/Enable`, `CGEventGetFlags`, `CGEventGetIntegerValueField`),
  CoreFoundation (`CFMachPortCreateRunLoopSource`, `CFRunLoop{GetCurrent,AddSource,RemoveSource,
  Run,Stop}`, `kCFRunLoopCommonModes`, `CFRelease`), IOKit (`IOHIDCheckAccess`,
  `IOHIDRequestAccess`). Public surface: `set_enabled(app, on, ptt_key)`, `is_running()`,
  `input_monitoring_status()`, `request_input_monitoring()`. Internals: dedicated
  `verbatim-fnkey` thread, `extern "C" tap_callback`, `RECORDING`+`FN_ACTIVE` press/release
  logic, `SendPtr` newtype so only raw pointers cross the start/stop boundary.
- `apps/widget/src-tauri/src/main.rs`:
  - `#[cfg(target_os="macos")] mod fnkey;` next to `mod axinject;`.
  - `AppConfig`: added `fn_push_to_talk: bool` + `ptt_key: String`; `Default` adds
    `fn_push_to_talk: false`, `ptt_key: "fn"`.
  - `set_config` side-effect: `fnkey::set_enabled(&app, next.fn_push_to_talk, &next.ptt_key)`
    when the toggle OR key changes (macOS-gated).
  - `clear_config`: tears the tap down on reset (macOS-gated).
  - Startup reconcile inside the `#[cfg(desktop)]` setup block (body `target_os="macos"`-gated),
    after the paste-last registration.
  - Three new `#[tauri::command]`s: `input_monitoring_trusted`, `open_input_monitoring_settings`
    (reuses `open_privacy_pane("Privacy_ListenEvent")`), `request_input_monitoring` — registered
    in `invoke_handler!`.
- `apps/widget/settings.html`:
  - "Push to talk" row activated (was static `Planned`): enable `<input id="pttEnable">` switch +
    `<select id="pttKey">` (Fn / Right ⌘ / Right ⌥) + `<p id="pttStatus" class="status">`.
  - Permissions pane: new Input Monitoring row (`id="imStatus"` + `id="openIm"`), mirroring
    mic/AX rows.
- `apps/widget/src/settings.ts`:
  - `type AppConfig`: `fnPushToTalk?: boolean` + `pttKey?: string`.
  - New refs `imStatusEl`/`openImEl`/`pttEnableEl`/`pttKeyEl`/`pttStatusEl` (all null-guarded).
  - `refreshImStatus()` (mirrors `refreshAxStatus`) + `openImEl` click wiring.
  - `initPtt()` + `refreshPttStatus()`; prompts `request_input_monitoring` on first enable;
    persists via `patchConfig`. Wired into `refreshControls` + `DOMContentLoaded`.

## Config schema added

| Field (camelCase) | Rust type | Default | Drives |
|---|---|---|---|
| `fnPushToTalk` | `bool` | `false` | master enable for the Fn/PTT event tap |
| `pttKey` | `String` | `"fn"` | which bare key: `"fn"` \| `"right_cmd"` \| `"right_opt"` |

`keycode_for`: `fn`→63, `right_cmd`→54, `right_opt`→61, **unknown→54 (Right-⌘ fallback)**.
`mask_for_keycode`: Fn→`0x800000`, ⌘(54/55)→`0x100000`, ⌥(61/58)→`0x80000`.

---

## Test results — Cloud (executed)

- `cd apps/widget && npx tsc --noEmit` → **exit 0** (PASS).
- `npm test` (repo root) → **106/106 passed, 16 files** (unchanged; no core touched).
- Static greps (all PASS): `settings.html` `id="imStatus"`/`openIm`/`pttEnable`/`pttKey`/
  `pttStatus` each = 1; `<div>`/`</div>` balanced 81/81. `settings.ts` references
  `input_monitoring_trusted` (×2), `open_input_monitoring_settings` (×1),
  `request_input_monitoring` (×1) — all matching the registered Rust command names exactly.

**Everything else is On-Mac and CANNOT be run here** (native Rust FFI won't compile in cloud).

---

## On-Mac verification protocol (UNCHECKED)

### Feasibility Gate (do FIRST — throwaway spike, not shipped)
- [ ] Build a scratch listen-only flagsChanged tap that `eprintln`s type/flags/keycode and
      returns the event unmodified; grant it Input Monitoring.
- [ ] Hold/release **Fn** → see flagsChanged with `secondaryFn` set then clear, keycode 63; note
      whether the emoji/dictation picker also fires.
- [ ] Set Keyboard → "Press 🌐 key to: **Do Nothing**", repeat → confirm cleaner behaviour.
- [ ] Hold **Right-⌘ (54)**, **Right-⌥ (61)** → each emits a distinguishable flagsChanged
      press/release with its own keycode.
- [ ] Confirm typing into a *different* app during the hold is unaffected (validates listen-only).
- [ ] **Decision:** if Fn is clean → keep `ptt_key` default `"fn"`; if flaky/consumed → change the
      default to `"right_cmd"` and reorder the `<select>` + one copy line (code already supports it).

### Build / smoke
- [ ] `cargo build` in `apps/widget/src-tauri` compiles (`fnkey.rs` links CoreGraphics / IOKit /
      CoreFoundation; no `E0308` from CF ref types).
- [ ] `npm run widget` launches; overlay + tray behave exactly as before with PTT **off**
      (regression: toggle ⌥Space still starts/stops; ⌥⇧V paste-test still works).
- [ ] With PTT off, the app **never** prompts for Input Monitoring on launch.

### Permission flow
- [ ] Settings → Permissions shows an **Input Monitoring** row reading "Not granted…" on a fresh
      machine.
- [ ] Flip **Shortcuts → Push to talk → on**: the macOS Input Monitoring prompt appears (or
      Verbatim is added to the list). `pttStatus` says "grant … then quit & relaunch."
- [ ] Grant Input Monitoring in System Settings; **quit & relaunch** Verbatim.
- [ ] Input Monitoring row now reads "✓ Granted"; `input_monitoring_trusted` returns true.
- [ ] Confirm the (un-sandboxed, ad-hoc-signed) **dev** build actually appears/toggles in the
      Input Monitoring list — if not, note it as a signing caveat.

### Core PTT behaviour (with the chosen `ptt_key`)
- [ ] Focus a text field in another app. **Hold the PTT key** → overlay shows and dictation
      **starts** (status "listening"); speak a sentence.
- [ ] **Release** → dictation **stops**, finalizes, and the text is **injected into that other
      app's field** — focus never left it.
- [ ] **No focus steal:** while holding, keep typing on the keyboard into the target app —
      characters land in the target app, not the widget.
- [ ] Repeat 5× rapidly → no stuck-recording state, no orphaned session, no duplicated
      start/stop in logs.

### Fallback key
- [ ] Switch `ptt_key` to **Right ⌘** (or Right ⌥); hold/release works the same. Confirm
      **Left-⌘ shortcuts (⌘C/⌘V/⌘Tab) are unaffected** (keycode discrimination).
- [ ] If Fn was chosen: set Keyboard → "Press 🌐 key to: Do Nothing" and confirm Fn no longer
      pops emoji/dictation while still driving PTT.

### Toggle + PTT interaction (no conflict)
- [ ] With a toggle session live (tapped ⌥Space to start), press & release the PTT key → does
      **not** double-start or prematurely stop; state stays sane.
- [ ] Start via PTT (hold), then tap ⌥Space to stop mid-hold, then release PTT → ends cleanly,
      **no double "stop"**, not stuck recording.
- [ ] Start via PTT and release normally, then use ⌥Space normally → both still independent.

### Graceful degradation
- [ ] Revoke Input Monitoring while the app runs → holding the PTT key does nothing (no
      crash/hang); `input_monitoring_trusted` flips to false on next Settings open; toggle hotkey
      + all other settings keep working.
- [ ] Turn PTT **off** in Settings → the event tap thread stops (verify via the `[fnkey] event
      tap stopped` log; confirm no lingering CPU from a spinning run loop); re-enabling starts it.
- [ ] Quit the app with PTT on → the tap thread exits (no orphaned thread / leaked run loop);
      relaunch reconciles PTT back on from config.

### Content-safety
- [ ] `grep` the debug run logs for any keystroke/transcript content from the tap path → **none**
      (fnkey taps flagsChanged only and never logs values; only `[fnkey] …` lifecycle lines).

---

## Deviations from the plan

- **Startup reconcile placement:** placed just after the paste-last registration inside the
  `#[cfg(desktop)]` setup block (still `target_os="macos"`-gated), rather than at the autostart
  reconcile site (:956). Both are inside the same setup block; this site is after config-dependent
  hotkey setup and reads cleaner. Behaviour identical.
- **Graceful stop on disable-mid-hold (added safety):** if PTT is turned off (or the app quits)
  while a Fn hold is in progress, the tap-thread teardown emits one `stop` and clears `RECORDING`
  so no session is left stuck recording. Not explicitly in the plan, but correctness-positive and
  low-risk; consistent with the "no stuck recording" acceptance criteria.
- **Thread-liveness reaping:** `start_tap` reaps a *finished* thread (e.g. after a NULL-tap
  permission failure) before spawning, so toggling PTT off→on retries cleanly within one run.

## Risks to watch on Mac

1. **Fn interception / firmware handling (highest).** Fn may never reach a session tap on some
   external keyboards, or pop the Globe UI when tapped. **Mitigation:** run the Feasibility Gate
   first; if Fn is flaky, flip the `ptt_key` default to `"right_cmd"` (code already supports it —
   `keycode_for` falls back to Right-⌘). Right-⌘ is the safe default (clean flagsChanged, keycode
   54 ≠ 55, no lone-press system action).
2. **Input Monitoring UX friction.** Granting typically needs quit & relaunch before a fresh tap
   works; ad-hoc-signed dev builds may register a *new* TCC identity per rebuild (vanish/reappear
   in the list). **Mitigation:** hint copy + proactive status row + NULL-tap = not-granted.
3. **Tap disabled under load** (`kCGEventTapDisabledByTimeout/ByUserInput`). **Mitigation:**
   callback matches those types first and re-enables via the stashed tap ref; callback is trivial
   (one atomic compare + at most a lock + emit), never blocks.
4. **Non-`Send` CF refs across start/stop.** **Mitigation:** tap + mach-port created/destroyed
   entirely on the tap thread; only the runloop pointer crosses (for thread-safe `CFRunLoopStop`)
   and the tap pointer (for re-enable) via the `SendPtr` newtype; `AppHandle` freed once after
   `CFRunLoopRun` returns.
5. **FFI signature/CF-ref-type mismatches invisible until the Mac build** — the whole class of
   Rust errors this phase can't catch in cloud. **Mitigation:** module is small, self-contained,
   FFI hand-declared with explicit widths (u32/u64/i64/isize); symbol/framework/const values
   cross-checked against the plan + review tables.

**Reminder: this whole phase is authored-pending-Mac-build.** Nothing native here is verified
until `cargo build` / `npm run widget` is green and the protocol above passes on the Mac.
