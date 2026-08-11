# apps/widget — macOS dictation widget (Tauri)

**Status: M3 Phase 3.1 — real app scaffold (built on the confirmed Phase 3.0 spikes).**
- **Phase 3.1 (this):** the widget now runs the **M2 dictation UI** inside the overlay — live streaming transcript, the "what was removed" self-correction diff, and the final-output box — and on Stop the finalized text is **injected into the focused field** of the app underneath. Vanilla-TS UI ported from `apps/web`; pipeline + vendor key stay in the M2 backend (WS). Run with `npm run widget` from the repo root.
- **Spike A (non-activating overlay) ✅:** window reclassed to a non-activating, **non-key** `NSPanel` (`tauri-nspanel` `v2.1`) + accessory app, so it floats over another app **without stealing focus or keyboard**.
- **Spike B (injection) ✅:** `inject_text` pastes into the focused field via clipboard + synthetic ⌘V; focus never leaves the target app.

**Architecture (3.1):** the webview is the M2 WS client — it captures the mic, streams PCM to the backend, and renders transcript/diff/final. The one widget-specific line is: on the backend's `formatted` message, the webview calls the Rust `inject_text` command. The **client-side `@open-dictation/core` pipeline + BYOK keychain** (no backend) is Phase 3.5.

Native macOS + Rust — build and run on a Mac.

## Prerequisites (one-time)
- **Rust** — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` then `source "$HOME/.cargo/env"`
- **Xcode Command Line Tools** — `xcode-select --install`
- Node deps installed at the repo root (`npm install`).

## Run
**Full widget (backend + overlay) — from the repo root:**
```bash
npm install
npm run widget        # starts the M2 backend (WS) + the Tauri widget (tauri dev)
```
Then: focus a text field in another app, press **⌥Space** to show the widget, click **Demo** (no mic/key) or **Start** to dictate, and **Stop** — the finalized text is injected into that field. For live dictation put `PYAI_API_KEY` in a `.env` at the repo root first; grant Accessibility on first inject.

**Just the Tauri shell (no backend)** — e.g. to re-test Spike A/B:
```bash
cd apps/widget && npx tauri dev
```
First run compiles the Rust side (slow, and `tauri-nspanel` is fetched from git); later runs are fast.

The widget connects to the backend at `ws://127.0.0.1:8787` (override with `VITE_WS_URL`).

## The working recipe (Spike A)
Non-activation has **two independent halves** — you need both:
1. **App never comes frontmost:** `app.set_activation_policy(ActivationPolicy::Accessory)` (no Dock icon) + the non-activating style mask.
2. **Panel never takes the keyboard:** `can_become_key_window: false`. Without this, a non-activating panel *still* becomes the key window and swallows keystrokes (this was the bug in the first attempt).

In `src-tauri/src/main.rs`:
```rust
// item-level: declare a non-key, floating panel class
tauri_nspanel::tauri_panel! {
    panel!(SpikePanel { config: { can_become_key_window: false, is_floating_panel: true } })
}
// in setup():
app.set_activation_policy(tauri::ActivationPolicy::Accessory);
let panel = window.to_panel::<SpikePanel>()?;           // reclass the tauri.conf "main" window
panel.set_style_mask(NSWindowStyleMask::NonactivatingPanel); // typed; from tauri_nspanel::objc2_app_kit
```
`Cargo.toml` pins `tauri-nspanel = { git = "…", branch = "v2.1" }` under a `cfg(target_os = "macos")` target.

**Expected side effect:** the widget's own webview never accepts typing — by design. You dictate into the widget; you never type into it. Buttons still click.

**App icon:** `generate_context!` requires `src-tauri/icons/icon.png` (present) — `tauri.conf.json` `bundle.icon` points at it. Regenerate a full set later with `npx tauri icon <1024px.png>`.

## Verify Spike A (non-activation)
1. Launch (`npx tauri dev`). A borderless floating card appears; **no Dock icon** (accessory app) — expected. Startup logs `[spike-a] main window reclassed to non-activating, non-key NSPanel`.
2. Open **Notes** (or Slack), click into a note so the **caret blinks**, type to confirm it's active.
3. Press **⌥Space** to show the widget, then **type**. ✅ **Pass:** characters land in **Notes**, its caret keeps blinking, title bar stays active. ❌ **Fail:** Notes deactivates / keystrokes go to the widget.

## Verify injection (end to end, via the pipeline)
1. `npm run widget`, focus a text field in **Notes** (or Chrome), press ⌥Space, click **Demo** (no mic/key). When the final output appears it is pasted into the focused field.
2. **Grant Accessibility** if nothing pastes: **System Settings → Privacy & Security → Accessibility** → enable the app (in dev it may appear as your terminal or the widget binary). `enigo` silently no-ops until granted; relaunch after granting. (The standalone `inject_text` command is still what does the paste.)

## Microphone permission (live dictation)
macOS blocks WKWebView's `getUserMedia` unless the app declares a mic-usage string, so a first **Start** can fail instantly with no prompt. This is handled:
- `src-tauri/Info.plist` (+ `Info.dev.plist`) sets `NSMicrophoneUsageDescription`, so macOS shows the prompt.
- On a denial the widget shows a **"Open Microphone Settings"** button (Rust `open_mic_settings` deep-links to the pane).

To grant: click **Start** once (triggers the prompt / the help panel) → **System Settings → Privacy & Security → Microphone** → enable **Open Dictation** (in dev it may show as your terminal or the dev binary) → **quit and relaunch** the widget. Demo mode never needs the mic. If the prompt still doesn't appear in `tauri dev`, run a one-off `npx tauri build` once so the Info.plist is baked into a bundle, then go back to `tauri dev`.

## If it doesn't build
Paste the `cargo`/`tauri` error back. Version-sensitive spots (`src-tauri/src/main.rs`, marked `Spike A`): the `tauri_panel!` macro config keys, `window.to_panel::<SpikePanel>()`, and `set_style_mask(NSWindowStyleMask::…)` (uses the crate's **re-exported** `objc2_app_kit` — don't add a separate `objc2-app-kit` dep or the types won't match). `set_activation_policy` is core Tauri v2.

## What's next
- **3.1 ✅ done** — M2 transcript/diff/final-output UI in the panel; mic → backend pipeline → `inject_text(finalized output)`. (Ran vanilla-TS reusing `apps/web`; client-side `@open-dictation/core` + BYOK is 3.5.)
- **3.2:** configurable hotkey / push-to-talk (`fn`-hold needs a native event tap).
- **3.3 polish:** `set_collection_behaviour(canJoinAllSpaces | stationary | fullScreenAuxiliary)` + caret-anchored positioning (AX bounds).
- **3.4:** `capture_focus()` before show, AX-write injection with paste fallback, secure/password-field refusal.
- **3.5:** move the pipeline client-side (import `@open-dictation/core` in the webview, call PyAI directly) + keychain BYOK → no dev backend.
