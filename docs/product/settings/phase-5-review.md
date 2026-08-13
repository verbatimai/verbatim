# Settings — Phase 5 (Wave 4 · Fn push-to-talk, native macOS) — Reviewer Cross-Check

**Reviewer:** Claude (pre-implementation architectural review)
**Date:** 13 Aug 2026
**Plan under review:** `docs/product/settings/phase-5-plan.md`
**Scope:** `settings-plan.md` §5 (+ Risk §10.3)
**Nature:** Native Rust (CoreGraphics/CoreFoundation/IOKit FFI) that **cannot be cloud-compiled.**
This review is architectural: FFI plausibility, event-flow correctness, and no-regression on the
existing native paths. Verified against the live repo at `/home/claude/verbatim`.

---

## Verdict: **APPROVED WITH REQUIRED CHANGES**

The plan is unusually rigorous and its code citations are accurate to the line. Every anchor it
names was verified against real code (see §Verification below). The FFI approach is sound and
matches the house style. There is **no blocking correctness defect**, but there are a handful of
required clarifications/corrections the dev must fold in — chiefly a factual dependency error
(§6) and two "do not get this wrong" FFI/teardown notes. **Dev is cleared to implement** once the
required changes below are acknowledged, and provided the §1 Feasibility Gate is run *first*.

This remains **author-only, correctness-first**: nothing here is verifiable until it is
`cargo build` / `npm run widget` green on the Mac, and the §9 on-Mac protocol is the real gate.

---

## Verification against actual code (all CONFIRMED)

| Plan claim | Real code | Status |
|---|---|---|
| `dictation` start emit | `main.rs:1046` `app.emit("dictation","start")` | ✓ exact |
| `dictation` stop emits | `main.rs:1038` and `:1065` | ✓ exact |
| Webview listener | `main.ts:552-555`; `start→beginDictation()`, `stop→if (ws) stop()` | ✓ exact |
| Shared toggle state | `RECORDING :16`, `PRESS_AT :17`, `STARTED_THIS_PRESS :18`, `HOLD_MS=300 :19` | ✓ exact |
| Toggle machine | `main.rs:1025-1069` (Pressed/Released) | ✓ exact |
| `AppConfig` struct end / `Default` | telemetry `:126` / `:149`; `#[serde(rename_all="camelCase", default)]` | ✓ exact |
| `set_config` change-guards + paste-last guard | `:183-217`, paste-last `:210-213` | ✓ exact |
| `clear_config` | `:237-254` | ✓ exact |
| Startup reconcile site | autostart reconcile `:956`, **inside `#[cfg(desktop)]`** setup | ✓ (fnkey body must be `target_os="macos"`-gated — plan says so) |
| `apply_paste_last_hotkey` helper pattern | def `:807`; called in `set_config :212`, `clear_config :245`, setup `:1079` | ✓ exact |
| Permission command pattern | `ax_trusted :588`→`axinject::is_trusted()`; `open_accessibility_settings :574`; `open_privacy_pane :553-560` | ✓ exact |
| `invoke_handler!` list | `:1138-1167` | ✓ exact |
| FFI precedent | `#[link(name="ApplicationServices", kind="framework")]` extern block `axinject.rs:33-54`; `#[link(name="objc", kind="dylib")]` `:59-64` | ✓ exact — raw C decls, **no crate** |
| `core-foundation` vendored | `Cargo.toml:34` `core-foundation = "0.10"` (lock 0.10.1) | ✓ |
| Permissions pane rows | `settings.html`: micStatus `:476`, axStatus `:483`, openMic `:478`, openAx `:485` | ✓ |
| Push-to-talk placeholder | `settings.html:337` `<h3>Push to talk <span class="tag planned">Planned</span></h3>`, kbd-group `:340` | ✓ |
| settings.ts refs/funcs | `micStatusEl/axStatusEl :82-85`, `refreshAxStatus :442`, `openAx/openMic :452-453`, DOMContentLoaded refresh `:769-770`, `type AppConfig :9`, telemetry `:27` | ✓ |
| Clean slate | no pre-existing `fnkey` / `CGEventTap` / `input_monitoring` / `IOHIDCheckAccess` in tree | ✓ |

**FFI symbol/framework plausibility (all correct):**
- CoreGraphics: `CGEventTapCreate`, `CGEventTapEnable`, `CGEventGetFlags`,
  `CGEventGetIntegerValueField`; `kCGKeyboardEventKeycode`=**9**; `kCGEventFlagsChanged`=**12**
  → `CGEventMaskBit` = `1<<12`. ✓
- Flag masks: `kCGEventFlagMaskSecondaryFn`=**0x800000**, `kCGEventFlagMaskCommand`=**0x100000**,
  `kCGEventFlagMaskAlternate`=**0x80000**. ✓
- Keycodes: RightCmd **54**, LeftCmd 55, RightOpt **61**, RightCtrl **62**, Fn **63**. ✓ — and
  54≠55 confirms the "Left-⌘ shortcuts untouched" claim.
- CoreFoundation: `CFMachPortCreateRunLoopSource`, `CFRunLoopGetCurrent`, `CFRunLoopAddSource`,
  `CFRunLoopRun`, `CFRunLoopStop`, `kCFRunLoopCommonModes`. ✓ (`CFRunLoopStop` is documented
  thread-safe — the §3.4 cross-thread stop is legitimate.)
- IOKit: `IOHIDCheckAccess`/`IOHIDRequestAccess`, `kIOHIDRequestTypeListenEvent`=**1**,
  access types Granted=**0**/Denied=1/Unknown=2. ✓ — correct framework (IOKit, **not**
  CoreGraphics), correct that Input Monitoring = TCC `kTCCServiceListenEvent`, separate from AX.

---

## The top correctness risk — double-fire / toggle race: ACCEPTABLE

Traced both producers against real code. The plan's `RECORDING` + single `FN_ACTIVE` design is
sound and the frontend backstops it on **both** edges:

- **Double-stop:** guarded by `main.ts:554` `stop → if (ws) stop()` (no-op when no session). ✓
- **Double-start:** `beginDictation()` (`main.ts:116-122`) **closes any open `ws` and reopens**
  (`:120 if (ws) { ws.close(); ws=null } ; startLive()`). So even a duplicated `start` tears down
  and restarts rather than leaking a second socket. ✓ (This is stronger than the plan claims —
  the plan only cites the stop-guard.)

**Scenario trace (all end in a sane state):**
- *Fn starts, then ⌥Space tapped to stop mid-hold:* toggle Pressed sees `RECORDING=true` →
  stop; `STARTED_THIS_PRESS=false` so Released no-ops; Fn release finds `RECORDING=false` →
  else-branch clears `FN_ACTIVE`, **emits nothing**. Single stop. ✓
- *Toggle recording, then Fn held:* Fn press sees `RECORDING=true` → does nothing, leaves
  `FN_ACTIVE=false`; Fn release no-ops. Toggle session untouched. ✓
- *Genuine TOCTOU (near-simultaneous ⌥Space + Fn):* the toggle Pressed path reads
  `was_recording` and **releases the lock before writing** (`main.rs:1033` then `:1044`), so it
  is not mutually atomic with the Fn path even if Fn holds the lock across its own
  read-modify-write. A double-`start` is therefore *theoretically* possible — but (a) it requires
  two distinct physical key events to land sub-millisecond on two threads, which human timing
  makes unreachable, and (b) `beginDictation`'s close-and-reopen makes the outcome a brief
  restart, not a broken state. **Not a blocker.** No change required; noted for the record.

**REQUIRED (minor):** In the Fn callback, hold the `RECORDING` lock across the *entire*
check-and-set (lock → test → set `RECORDING` + `FN_ACTIVE` → unlock) so the Fn producer is at
least internally atomic. The plan's prose implies this; make it explicit in code and set both
flags under the one lock.

---

## Confirmation: tap is passive / non-focus-stealing

Confirmed the plan uses `kCGEventTapOptionListenOnly` at `kCGSessionEventTap` /
`kCGHeadInsertEventTap`, masks **only** `kCGEventFlagsChanged`, and returns `event` unmodified.
This cannot swallow keys and cannot steal focus (it never touches keyDown/keyUp and never returns
NULL). The plan correctly flags that a `kCGEventTapOptionDefault` tap returning NULL *would* eat
the key — that trap is called out and avoided. The panel is shown via `win.show()` (never
`set_focus`), preserving the non-activating NSPanel behavior. **No focus-steal risk.** The §9
"keep typing into the target app during a hold" check is the correct on-Mac proof.

---

## Numbered required changes

1. **[Corrected inline] §6 dependency fact.** The alternative "`core-graphics = "0.24"`" is
   wrong-headed: `Cargo.lock` already vendors **core-graphics 0.23.2 and 0.25.0** transitively
   (plus `objc2-core-graphics 0.3.2`). Pinning `0.24` resolves a *third* copy → *more* churn, the
   opposite of the stated goal. **Recommendation stands: hand-FFI, add zero crates.** If the crate
   route is ever taken, reuse the already-present **0.25**. *(Fixed in the plan.)*

2. **[Corrected inline] §4 `win("main")` shorthand.** There is no `win()` helper; use
   `app.get_webview_window("main")` exactly as the toggle path does at `main.rs:1041-1043`.
   *(Fixed in the plan.)*

3. **[MUST — teardown] Refcon lifetime.** In the tap callback, reconstruct the `AppHandle` as a
   **borrow** (`let app = &*(refcon as *const tauri::AppHandle);`) — **never** `Box::from_raw` in
   the callback (that would drop-and-free the handle the still-running tap owns → use-after-free on
   the next event). Free it exactly once, on teardown, after `CFRunLoopRun()` returns
   (`drop(Box::from_raw(..))`). The plan says this in prose (§3.2/§3.4); elevate it to a MUST so
   it isn't lost in translation.

4. **[MUST — liveness] Handle tap-disable events regardless of mask.** `kCGEventTapDisabledByTimeout`
   and `kCGEventTapDisabledByUserInput` are delivered to the callback **even though they aren't in
   the flagsChanged mask**. The callback must match on `type` first and call
   `CGEventTapEnable(tap, true)` to re-arm, then `return event`. Risk §11.3 covers this — make it a
   callback-structure MUST, not just a risk note. Keep the callback trivial (one atomic
   compare + at most a lock + emit); never block in it.

5. **[Confirm] NULL-tap = not-granted path.** `CGEventTapCreate` returns a nullable
   `CFMachPortRef`. On NULL: log `[fnkey] tap create failed — Input Monitoring not granted` (no
   key/content), leave `RECORDING` untouched, and let the UI hint surface. The plan has this;
   just confirm the tap thread doesn't then proceed to `CFMachPortCreateRunLoopSource(NULL)`
   (which would crash) — early-return on NULL.

6. **[Nit] Command-name naming.** §7 names the status command `input_monitoring_trusted` and the
   `fnkey` fn `input_monitoring_status()`; §3.5 lists `input_monitoring_status` as the public
   surface. That's fine (command wraps fn), but keep the invoke string `input_monitoring_trusted`
   consistent with the three `settings.ts` call sites (§8/§10) — the plan already matches; call it
   out to the dev since there is no cloud compile to catch a drift.

---

## Answers to open questions (§12)

1. **Fn vs Right-⌘ default** — Decide *after* the §1 gate; do not pre-commit. If Fn shows **any**
   flakiness or pops system UI when "🌐 → Do Nothing" is set, **default to `right_cmd`** and list
   Fn as advanced. Right-⌘ is the right fallback: real flagsChanged modifier, keycode-distinct
   from Left-⌘ (54 vs 55), no lone-press system action. Reordering the `<select>` + one copy line
   is the only delta — cheap. Recommendation: **ship whichever the gate proves clean as default,
   bias to Right-⌘ if it's a coin-flip** (fewer support tickets than Fn/Globe).

2. **Hand-FFI vs `core-graphics` crate** — **Hand-FFI.** Decisive because (a) it cannot be
   cloud-compiled, so minimizing new/duplicated deps is the safer bet; (b) the crate route would
   pull a *third* core-graphics version (see change #1); (c) it matches `axinject.rs` exactly, so
   reviewers and the build already trust the pattern. Declare CoreGraphics + IOKit + the CF
   runloop/machport functions in `#[link]` extern blocks inside `fnkey.rs`. Use the vendored
   `core-foundation` crate's `TCFType`/`runloop` types only where convenient — but **note it does
   not wrap `CFMachPort`**, so the `CFMachPortRef` from `CGEventTapCreate` and
   `CFMachPortCreateRunLoopSource` must be hand-declared regardless (opaque `*mut c_void`). Zero
   Cargo change either way.

3. **PTT while an old result card is open** — Mirror the toggle (show-then-start;
   `beginDictation` already `reset()`s and reopens `ws`). No special "ignore open card" nuance —
   consistency with ⌥Space wins. Confirmed fine.

4. **`request_input_monitoring()` timing** — Prompt **eagerly on first toggle-on** (the planned
   behavior). It's friendlier than a silent tap-create failure, and the `set_enabled` NULL-tap
   path is the backstop if the user dismisses the dialog. Keep both.

5. **Debounce** — **No debounce.** PTT has no tap-vs-hold ambiguity (unlike the toggle's
   `HOLD_MS`), flagsChanged fires only on real state change (no repeat storm), and any accidental
   brush self-corrects on release. Raw press/release is correct and simplest.

6. **Multiple keyboards / remappers (Karabiner)** — Out of scope for the spike; do **not** block
   on it. Worth one line in the §1 gate notes if a remapper is handy, but not required.

7. **Auto-open Permissions pane on toggle-on when ungranted** — Nice-to-have, **not** for this
   spike. The inline `pttStatus` hint + the eager `request_input_monitoring()` TCC prompt are
   enough. Defer.

---

## Go / No-Go

**GO** — implement, gated on running the §1 Feasibility Gate first and folding in the required
changes above. This is a **spike**: if the gate shows Fn is unusable, the *only* change is the
`ptt_key` default and one copy line — proceed with Right-⌘ and keep moving.

### MUST-follow bullets for the dev (author-only, correctness-first)
- **Run §1 first.** Prove a distinguishable Fn (or Right-⌘) press/release on a listen-only tap in
  a throwaway binary *before* wiring `AppConfig`/UI. Don't build the feature on an unproven event.
- **Listen-only, always return `event`.** `kCGEventTapOptionListenOnly`; never NULL, never mutate.
  This is the non-negotiable "don't break typing / don't steal focus" invariant.
- **Callback discipline:** match `type` first — re-enable on `kCGEventTapDisabledByTimeout` /
  `…ByUserInput`; borrow (never free) the refcon `AppHandle`; early-return for any non-tracked
  keycode; hold `RECORDING` across the whole check-and-set. Keep it trivial; never block.
- **NULL tap = not granted.** Early-return on a NULL `CFMachPortRef`; log without any key/content;
  leave `RECORDING` untouched; let the UI hint surface. Never call
  `CFMachPortCreateRunLoopSource(NULL)`.
- **Teardown:** create/destroy tap + mach-port entirely on the tap thread; cross only the runloop
  pointer via the `RunLoopHandle(*mut c_void)` Send-newtype for `CFRunLoopStop`; free the boxed
  `AppHandle` after `CFRunLoopRun()` returns.
- **Zero new crates.** Hand-FFI CoreGraphics/IOKit/CF in `fnkey.rs` `#[link]` blocks. Do not add
  `core-graphics`; `core-foundation 0.10` is already vendored and does not cover `CFMachPort`.
- **Reuse the contract verbatim.** Emit only `app.emit("dictation","start"|"stop")`; show via
  `get_webview_window("main").show()`, never `set_focus`. No new front-end path.
- **Only start the tap when the feature is on** (set_config side-effect + `clear_config` teardown
  + startup reconcile inside the `#[cfg(desktop)]` setup block, body gated `target_os="macos"`),
  so a user who never enables PTT is never prompted for Input Monitoring.
- **The deliverable is unverifiable until §9 passes on the Mac.** Only the `settings.ts`/
  `settings.html` slice is cloud-checkable (`tsc --noEmit`, static greps). Do not claim done off
  the Mac. Re-run the toggle/⌥⇧V regressions with PTT **off** to prove no native regression.
- **Content-safety:** tap flagsChanged only; never log flag/keycode *values* from the ship path
  (the §1 spike may `eprintln` them; the shipped callback must not).
