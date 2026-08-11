# apps/widget — macOS dictation widget (Tauri)

**Status: M3 Phase 3.0 — injection spike (Spike B).** Proves we can (a) summon a widget with a global hotkey and (b) inject text into whatever app is focused, via clipboard + synthetic ⌘V. This is native macOS + Rust; it must be **built and run on a Mac** (it was scaffolded but not compiled in the cloud, so expect to iterate on build errors).

## Prerequisites (one-time)
- **Rust** — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Xcode Command Line Tools** — `xcode-select --install`
- Node deps installed at the repo root (`npm install`).

## Run
```bash
cd apps/widget
npm install
npx tauri dev     # or: npm run start
```
First run compiles the Rust side (slow); later runs are fast.

## Grant Accessibility permission
Posting keystrokes needs it: **System Settings → Privacy & Security → Accessibility** → enable the app (in dev it may appear as your terminal or the widget binary). enigo silently no-ops until granted — if injection does nothing, this is almost always why. Relaunch after granting.

## Test the spike
1. The widget window appears. Press **⌥Space** — it should hide/show (proves the global hotkey works even when another app is focused).
2. Put your cursor in **Notes** (or Chrome), come back, click **“Inject after 3s”**, then immediately click back into Notes. After the countdown the text should paste into Notes.
3. **Pass criteria:** the text lands in the focused field of the *other* app, and ⌥Space toggles the widget globally.

## What this spike does NOT yet do (next steps in M3)
- **Non-activating overlay (Spike A):** right now it's a normal window that takes focus, hence the 3-second "click back" trick. Next we add `tauri-nspanel` so the widget never steals focus and injection targets the previously-focused field directly (no countdown).
- **Focus capture** (AX) for caret-accurate placement, AX-write injection (cleaner than paste), secure-field refusal, and wiring the real M2 pipeline (mic → transcript → correction → inject).

## If it doesn't build
Paste the `cargo`/`tauri` error output back and we'll fix it — the likely spots are the `tauri-plugin-global-shortcut` API (version-sensitive) and `enigo`/`arboard` versions. This scaffold targets Tauri v2, enigo 0.2, arboard 3.
