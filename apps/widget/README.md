# apps/widget — macOS dictation widget (Tauri)

**Status: M3 Phase 3.0 — de-risk spikes ✅ both confirmed on a real Mac (11 Aug 2026).**
- **Spike A (non-activating overlay):** the window is reclassed to a non-activating, **non-key** `NSPanel` (`tauri-nspanel` `v2.1`) and the app runs as an accessory, so the widget floats over another app **without stealing its focus or keyboard**. Confirmed: caret keeps blinking and typing still goes to the app underneath.
- **Spike B (injection):** ⌥Space summons the widget; `inject_text` pastes into the focused field via clipboard + synthetic ⌘V. Confirmed pasting into a live editor with no countdown (focus never leaves the target app).

Native macOS + Rust — build and run on a Mac.

## Prerequisites (one-time)
- **Rust** — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` then `source "$HOME/.cargo/env"`
- **Xcode Command Line Tools** — `xcode-select --install`
- Node deps installed at the repo root (`npm install`).

## Run
```bash
cd apps/widget
npm install
npx tauri dev     # or: npm run start
```
First run compiles the Rust side (slow, and `tauri-nspanel` is fetched from git); later runs are fast.

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

## Verify Spike B (injection)
1. Cursor in **Notes** (or Chrome), click the widget's **"Inject now"** — the text pastes into the focused field. (The 3s countdown button is a leftover from before non-activation worked; "Inject now" is enough now.)
2. **Grant Accessibility** if nothing pastes: **System Settings → Privacy & Security → Accessibility** → enable the app (in dev it may appear as your terminal or the widget binary). `enigo` silently no-ops until granted; relaunch after granting.

## If it doesn't build
Paste the `cargo`/`tauri` error back. Version-sensitive spots (`src-tauri/src/main.rs`, marked `Spike A`): the `tauri_panel!` macro config keys, `window.to_panel::<SpikePanel>()`, and `set_style_mask(NSWindowStyleMask::…)` (uses the crate's **re-exported** `objc2_app_kit` — don't add a separate `objc2-app-kit` dep or the types won't match). `set_activation_policy` is core Tauri v2.

## What's next (gate cleared → Phase 3.1+)
- **3.1:** promote from spike to real app — import `@open-dictation/core`, render the M2 transcript/diff/final-output UI in the panel, wire mic → pipeline → `inject_text(finalized output)`.
- **3.3 polish:** `set_collection_behaviour(canJoinAllSpaces | stationary | fullScreenAuxiliary)` + caret-anchored positioning (AX bounds).
- **3.4:** `capture_focus()` before show, AX-write injection with paste fallback, secure/password-field refusal.
