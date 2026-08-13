# M3 — macOS Desktop Widget: Task Breakdown

**Goal (North-Star slice):** a floating, non-activating widget summoned by a global hotkey that dictates into **whatever field is currently focused** in any macOS app — using the M2 pipeline (Hear stream → clean transcript → cleanup + format) and inserting the polished result without stealing focus.

**Architecture decision (reuse everything from M1/M2):**
- **Rust (Tauri core)** owns only the native shell: global hotkey, non-activating overlay window, focus capture, text injection, and OS keychain.
- **Webview (React + `@verbatim/core`)** owns the pipeline + UI: it captures the mic (`getUserMedia`, already working in M2), runs the `TranscriptAccumulator` + correction/format, and renders the transcript/diff. This reuses **all** of `packages/core` and the M2 UI — the widget is the M2 web app wrapped in a native overlay.
- **Keys:** BYOK, stored in the OS keychain via Rust (`keyring`); the webview gets a key through a Tauri command and calls PyAI directly (no dev backend needed → matches the open-core "local, no server" model). The `apps/backend` proxy stays optional.

Research already in `docs/architecture/tauri-stack.md` and `docs/architecture/macos-injection.md`.

---

## Phase 3.0 — De-risk spikes (do FIRST, throwaway)
The two things that can sink M3. Prove them in isolation before building the real app.

- [x] **Spike A — Non-activating overlay. ✅ CONFIRMED on macOS (11 Aug 2026).** The widget floats over the frontmost app (Notes/Slack) and, when shown/clicked, does **not** steal focus: the other app's caret keeps blinking and typing still goes to that app. **Working recipe** (in `apps/widget`): `tauri-nspanel` **`v2.1`** branch → `tauri_panel! { panel!(SpikePanel { config: { can_become_key_window: false, is_floating_panel: true } }) }`, reclass the `tauri.conf.json` "main" window via `window.to_panel::<SpikePanel>()`, then `panel.set_style_mask(NSWindowStyleMask::NonactivatingPanel)` (typed via the crate's re-exported `objc2_app_kit`) + `app.set_activation_policy(Accessory)`; ⌥Space shows without `set_focus`. **Two halves that both matter:** accessory policy + non-activating mask keep the *app* from coming frontmost; `can_become_key_window: false` keeps the panel from taking the *keyboard* (this was the missing piece — a plain non-activating panel still became key and swallowed keystrokes). Side effect (expected/desired): the widget's own webview never accepts typing — you dictate into it, never type into it.
- [x] **Spike B — Focus capture + text injection. ✅ Injection path confirmed (11 Aug 2026).** With the non-key panel, focus never leaves the target app, so clipboard + synthetic ⌘V (`enigo`/`arboard`, `inject_text` command) pastes straight into the focused field — no countdown needed. Verified pasting into a focused editor with the caret still live. **Still to do for full Spike B:** AX `kAXSelectedTextAttribute` write as the primary path (paste is the fallback), capture-focused-element-*before*-show, the Notes/Chrome/Slack matrix (≥2 of 3), and secure/password-field refusal — these move into Phase 3.4.

**Gate:** ✅ **cleared** — A and B both work on macOS, so Phase 3.1+ is unblocked. (Fallback native-Swift shell not needed; `tauri-nspanel` `v2.1` does the job.)

---

## Phase 3.1 — App scaffold ✅ (11 Aug 2026)
- [x] `apps/widget` is a Tauri v2 + Vite + TypeScript app in the npm workspace. **Deviation:** vanilla TS, **not** React — M2 shipped its UI in vanilla TS, so the widget reuses it verbatim (the "reuse everything" principle) rather than forking it into React.
- [x] Render the M2 transcript/diff/final-output UI inside the widget window (ported from `apps/web`: streaming transcript, "what was removed" diff animation, final-output box + loading indicator). **Widget seam:** on the backend's `formatted` message the webview calls the Rust `inject_text` command → the finalized text lands in the focused field. **Scope note:** the pipeline is reused **via the M2 backend WS** (`ws://127.0.0.1:8787`), not by bundling `@verbatim/core` in the browser — core is Node-side (`ws`/`node:fs`). The client-side `core` import (direct PyAI, no backend) is Phase **3.5** (BYOK/keychain); that's the correct sequencing.
- [x] Dev script **`npm run widget`** (root → `scripts/widget.mjs`: backend + `tauri dev`). Widget `typecheck` script added (covered by root `npm run typecheck`); frontend typechecks clean. CI wiring (`cargo build` on a macOS runner + `typecheck`) still TODO — tracked in STATUS next-steps.

## Phase 3.2 — Global hotkey / push-to-talk  ·  ~80% (12 Aug 2026)
- [x] **⌥Space drives dictation with BOTH modes** via `tauri-plugin-global-shortcut` `Pressed`/`Released`: a quick **tap toggles** (hands-free), a **hold is push-to-talk** (record while held, stop on release; ≥300 ms = hold). Rust owns the state machine (`RECORDING`/`PRESS_AT`/`STARTED_THIS_PRESS`) and emits a `dictation` event (`start`/`stop`) the webview acts on. Chord push-to-talk needs no event tap.
- [x] **Wispr/Amical-style UX**: a **floating orb** (idle, always visible, bottom-centre, **draggable** — click = dictate, drag = move; remembers its spot) that opens the **full streaming card** on start (transcript streams live per the SOP; no minimal-pill dead time), then collapses back to the orb after inserting. Card opens **anchored to the orb**, clamped on-screen. **Live mic-level meter** (AnalyserNode → 5 bars) in the card titlebar. **Menu-bar tray icon** (Show / Quit) as the app-running indicator.
- [x] **Configurable hotkey** — a **click-to-pick preset list** in Settings (⌥Space / ⌃Space / ⌘⇧D / ⌃⌥D / ⌥\`). The choice persists to a tiny file in the app config dir and Rust **re-registers it live** (`set_toggle_hotkey`/`get_toggle_hotkey`, a `CURRENT_TOGGLE` static the handler compares against). Click-based (not key-capture) because the non-key panel can't receive keystrokes — same constraint as the API-key field.
- [ ] **`fn`-key hold** (bare-modifier, Wispr-style) — needs a native `CGEventTap` + Input-Monitoring permission. **Deferred** (its own native spike; higher risk).
- [ ] **Context-gate the orb** (show only when an editable field is focused) — now **unblocked** by the 3.4 AX read, but **deferred**: needs a continuous background AX poll (cost/complexity), and the always-visible draggable orb is acceptable meanwhile.

## Phase 3.3 — Non-activating overlay (from Spike A)  ·  ~80% (12 Aug 2026)
- [x] Overlay window config: `alwaysOnTop`, `decorations:false`, `transparent:true`, `focus:false`, `skipTaskbar:true`, `visibleOnAllWorkspaces:true`, `macOSPrivateApi:true` (in `tauri.conf.json`).
- [x] Reclass to `NSPanel` via `tauri-nspanel` (non-activating style mask, `can_become_key_window:false`) + **collection behaviour** `CanJoinAllSpaces | Stationary | FullScreenAuxiliary` so the orb/card show on every Space and over full-screen apps. `#[cfg(target_os="macos")]`.
- [ ] Position near the caret (AX bounds) with a screen-corner fallback + multi-monitor/scale — **blocked on the AX focus read** (parallel session). The orb/card currently position bottom-centre / anchored to the (draggable) orb, clamped on-screen.

## Phase 3.4 — Focus capture + injection (from Spike B)  ·  ✅ DONE (14 Aug 2026)
- [x] **Injection works end-to-end on a real Mac**: webview emits the final formatted output → `inject_text` → clipboard + synthetic ⌘V lands in the focused field.
- [x] **Reliable AX focus read (root cause found & fixed).** The *system-wide* `AXFocusedUIElement` is unreliable (returns `kAXErrorNoValue` -25212 even for a trusted process, esp. against Chromium/Electron whose AX tree is lazy). Fix in `axinject.rs` `read_focus`: get the **frontmost app's pid via NSWorkspace** (minimal objc runtime FFI, no objc2 dep) → **`AXUIElementCreateApplication(pid)`** (per-app element, not system-wide) → set **`AXManualAccessibility=true`** to wake Chromium/Electron → **poll `AXFocusedUIElement`** a few hundred ms for the lazily-built tree → fall back to system-wide, then to plain paste. Never blocks paste. It was never a trust/signing issue (only ever -25212, never -25211).
- [x] **Routing wired** (`axinject::inject`): not-trusted → copy (`no_access`); **secure/password field** (`AXSecureTextField` role/subrole) → **refuse + copy** (`secure`); editable text element (settable `kAXSelectedText` or a text role) → **paste** (`inserted`); a real non-editable element → copy (`no_field`); AX unreadable → paste fallback. UI banners each case; Copy button is the manual escape hatch.
- [x] **AX-write (`kAXSelectedText`) intentionally NOT used** — on tested apps it returns success but inserts nothing (accepted-but-no-op), silently dropping text. Paste (⌘V) is the injection path; AX is read/guard only. Documented in `axinject.rs`.
- [x] **`⌥⇧V` paste-test hotkey** added: injects a fixed sentence straight through `inject()` (no backend/STT) — lets us verify focus-read + routing per app even with the PyAI quota spent.
- [x] Permission flow: `AXIsProcessTrusted()` gate + reactive "grant Accessibility" banner with a deep-link (`open_accessibility_settings`).
- [x] **Proactive Accessibility status in Settings** (`ax_trusted` command → live "✓ granted / not granted" indicator + deep-link button), so the permission is visible before the first injection rather than only via the failure banner. (A dedicated full-screen first-run wizard is still optional.)

## Phase 3.5 — Keychain (BYOK) ✅ DONE
- [x] Rust `keyring` integration (service `co.saaslabs.verbatim`): store/read/clear per-vendor keys (`key_save`/`key_get`/`key_has`/`key_delete`) + a **Settings screen**. Because the non-key panel can't accept a typed/pasted key, entry is via **`key_save_clipboard`** — Rust reads the clipboard directly (no keyboard focus) and stores it, returning a masked `••••1234` preview. Keys never touch disk/env beyond the Keychain and are never logged.
- [x] The key is handed to the local backend for the session (`start` message carries `apiKey`; backend sets it into the provider env). Direct client-side PyAI calls that let us **drop the dev backend** entirely are the M4 backbone (out of M3 scope).

## Phase 3.6 — UX polish
- [x] Show/hide animations (card **scale/fade-in** on expand, settings **fade-in**); "listening / cleaning up / inserted" states reuse the M2 status pill + typing indicator + live mic-level meter.
- [x] Cancel/escape to dismiss without inserting (the ✕ collapse button drops the session and returns to the orb); **re-show last result** via the tray **"Show Last Result"** item (`show-last` → recall the last dictation with Copy enabled; `lastResult` survives `reset()`).
- [x] Handle "no editable field focused" gracefully — `axinject` returns `no_field` → text is copied to the clipboard and an info banner tells the user to press ⌘V.

---

## Exit criteria for M3
Trigger the hotkey over a real third-party app (Slack / Notes / Chrome), dictate a sentence with fillers and a self-correction, and the **cleaned, formatted text is inserted into the correct field** — with the widget never stealing focus, and password fields safely refused.

## Risks (from research)
1. `fn`/push-to-talk needs a native event tap (not the shortcut plugin). → 3.2 optional path.
2. True non-activation needs `tauri-nspanel`; plain Tauri windows still steal focus. → Spike A gates it.
3. AX injection fails in some Electron/Java/terminal fields → clipboard-paste fallback; secure fields refused.
4. Accessibility permission friction; unsigned dev builds re-prompt → test with a signed/stable-identity build early.
5. Caret positioning needs AX bounds (permission) + mouse fallback.
6. Windows support (UIA + SendInput) is **out of scope for M3** (macOS-first); deferred to M6.

## Sequencing
`3.0 spikes (A+B) → 3.1 scaffold → 3.2 hotkey → 3.3 overlay → 3.4 focus+injection → 3.5 keychain → 3.6 polish → M3 exit demo`
Only start each after the previous is demoable; 3.0 is a hard gate.
