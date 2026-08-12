# M3 — macOS Desktop Widget: Task Breakdown

**Goal (North-Star slice):** a floating, non-activating widget summoned by a global hotkey that dictates into **whatever field is currently focused** in any macOS app — using the M2 pipeline (Hear stream → clean transcript → cleanup + format) and inserting the polished result without stealing focus.

**Architecture decision (reuse everything from M1/M2):**
- **Rust (Tauri core)** owns only the native shell: global hotkey, non-activating overlay window, focus capture, text injection, and OS keychain.
- **Webview (React + `@open-dictation/core`)** owns the pipeline + UI: it captures the mic (`getUserMedia`, already working in M2), runs the `TranscriptAccumulator` + correction/format, and renders the transcript/diff. This reuses **all** of `packages/core` and the M2 UI — the widget is the M2 web app wrapped in a native overlay.
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
- [x] Render the M2 transcript/diff/final-output UI inside the widget window (ported from `apps/web`: streaming transcript, "what was removed" diff animation, final-output box + loading indicator). **Widget seam:** on the backend's `formatted` message the webview calls the Rust `inject_text` command → the finalized text lands in the focused field. **Scope note:** the pipeline is reused **via the M2 backend WS** (`ws://127.0.0.1:8787`), not by bundling `@open-dictation/core` in the browser — core is Node-side (`ws`/`node:fs`). The client-side `core` import (direct PyAI, no backend) is Phase **3.5** (BYOK/keychain); that's the correct sequencing.
- [x] Dev script **`npm run widget`** (root → `scripts/widget.mjs`: backend + `tauri dev`). Widget `typecheck` script added (covered by root `npm run typecheck`); frontend typechecks clean. CI wiring (`cargo build` on a macOS runner + `typecheck`) still TODO — tracked in STATUS next-steps.

## Phase 3.2 — Global hotkey / push-to-talk
- [ ] `tauri-plugin-global-shortcut`: register a configurable hotkey (default a chord, e.g. ⌥Space) that toggles the widget; wire `Pressed`/`Released` for optional push-to-talk.
- [ ] **`fn`-key hold** (Wispr-style) needs a native `CGEventTap`/`NSEvent` global monitor — the plugin can't bind bare modifiers. Implement as an optional Rust event-tap; document the extra Accessibility/Input-Monitoring permission it needs.

## Phase 3.3 — Non-activating overlay (from Spike A)
- [ ] Overlay window config: `alwaysOnTop`, `decorations:false`, `transparent:true`, `focus:false`, `skipTaskbar:true`, `visibleOnAllWorkspaces:true`; `app.macOSPrivateApi:true`.
- [ ] Reclass to `NSPanel` via `tauri-nspanel` (`NONACTIVATING_PANEL`, `can_become_key_window:false`, floating level, joins all Spaces). `#[cfg(target_os=…)]` per-OS.
- [ ] Position near the caret (AX bounds) with a screen-corner fallback; handle multi-monitor + scale factor.

## Phase 3.4 — Focus capture + injection (from Spike B)  ·  ~60% (12 Aug 2026)
- [x] **Injection works end-to-end on a real Mac**: webview emits the final formatted output → `inject_text` → clipboard + synthetic ⌘V lands in the focused field. Verified pasting into a browser form input.
- [x] **Hard lesson — AX focus reading is unreliable on this setup, so it must NOT gate injection.** `AXUIElementCopyAttributeValue(systemWide, AXFocusedUIElement / AXFocusedApplication)` returns `kAXErrorNoValue` (-25212) *even when the process is trusted* (`AXIsProcessTrusted()==true`), and even when triggered from the global ⌥Space hotkey (no widget click involved), and even with the per-application + `AXManualAccessibility` path for Chromium/Electron. Every attempt to route on the read (`focused_kind`, capture-then-write, capture-on-hotkey) sent everything to "no field". Root cause not fully resolved (candidate: our accessory + always-visible non-key panel means no reported key window/focused app; or a dev-signing/TCC quirk).
- [x] **Design that works:** paste via ⌘V is the mechanism (it targets the key window; it does NOT need `AXFocusedUIElement`). `axinject::inject()` = trusted-gate → *best-effort* secure-field check (skipped if AX can't read) → paste → copy-to-clipboard fallback on paste error. Returns `inserted` | `secure` | `no_access` | `no_field`; UI shows a matching banner, and a **Copy** button by the final output is the manual escape hatch.
- [ ] **Secure/password-field refusal** — only best-effort right now; depends on the AX role read, which currently fails here. Blocked on making the AX focus read reliable.
- [ ] **"No editable field focused" detection** — likewise deferred; today an unfocused target just pastes nowhere (Copy button covers it).
- [ ] **AX-write (`kAXSelectedText`)** as primary insert — deferred (needs the AX element read to work).
- [ ] **Reliable AX focus read** is the real blocker for the above. Likely needs: the widget to stop being always-visible (hide until ⌥Space summons it, capturing focus in the global handler while the target is still key), and/or a signed/stable build so TCC/AX behaves. Tracked into 3.2/3.6.
- [ ] Proactive first-run "grant Accessibility" screen (today reactive via the injection banner + deep-link).

## Phase 3.5 — Keychain (BYOK)
- [ ] Rust `keyring` integration: store/read per-vendor keys (`PYAI_API_KEY`, etc.); a settings screen to enter them.
- [ ] Tauri command to hand the selected key to the webview for direct PyAI calls; **never** log or bundle keys.

## Phase 3.6 — UX polish
- [ ] Show/hide animations; "listening / cleaning up / inserted" states (reuse M2 status + typing indicator).
- [ ] Cancel/escape to dismiss without inserting; re-show last result.
- [ ] Handle "no editable field focused" gracefully (offer copy-to-clipboard instead).

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
