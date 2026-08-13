# Settings — Phase 2 (Wave 2 — "Small features") Implementation Progress

**Owner:** Mayank Banga · Saaslabs · **Implemented:** 13 Aug 2026
**Scope:** items 2.1–2.3 of `phase-2-plan.md` (as corrected by `phase-2-review.md`).
**Env note:** Rust (`src-tauri`) was authored but NOT compiled here (the cloud can't
`cargo build`). Only the widget/backend TS typecheck + the core vitest suite were runnable
in the cloud. Everything Rust below needs a `cargo build` / `npm run widget` on the Mac.

---

## Summary (per item)

- **2.1 Paste last transcript (global hotkey).** A new `static LAST_RESULT: Mutex<Option<String>>`
  is recorded inside `inject_text` (its sole caller is the webview's `injectFinal` with the
  finalized formatted text — confirmed by the reviewer), so Rust retains the last final with
  no webview/WS change. A configurable `paste_last_hotkey` accelerator is registered through
  the existing `parse_accelerator` infra via a new `apply_paste_last_hotkey` helper (accepts
  `""` = unset → unregister only). Startup registration is placed AFTER the global-shortcut
  plugin is built (after `register(test_paste)?`). A new handler branch — ordered
  test-paste → paste-last → toggle — fires on `Released` and injects `LAST_RESULT` (graceful
  no-op when empty). `set_config` re-registers on change; `clear_config` unregisters on Reset.
  A second capture row in Settings reuses the toggle's capture UI via a new
  `makeHotkeyCapture` factory, with a soft collision guard rejecting the toggle hotkey and
  the reserved ⌥⇧V paste-test combo. Config field `paste_last_hotkey` default `""`.
- **2.2 Self-correction real toggle (`correct`).** A `correct` flag (default true, `!== false`
  semantics) travels on the WS `start` frame from `main.ts`. When false the correction pass is
  skipped entirely → the final is the raw STT-only transcript, no `correction`/`onCorrection`
  emitted. Edited BOTH pipelines: core `packages/core/src/pipeline.ts` `finalizeOnce` (rewrote
  240–248, kept `try {`/`const language` at 238–239 and the `catch`) AND the widget's real path
  `apps/backend/src/server.ts` `finalize`. The decorative Labs "Self-correction" row is now a
  real switch (`#selfCorrect`), "Cloud only" tag dropped.
- **2.3 Formatting toggle (`format`, "Alpha").** A `format` flag (default true) gates the
  finalize FORMAT pass in BOTH core `pipeline.ts` (same `finalizeOnce` rewrite) AND
  `server.ts` — where `format:false` ALSO bypasses the `localFormat` fallback (whole
  134–144 block skipped → `finalText = cleanText`). The Dictation "Formatting" row is un-gated
  (`#formatToggle`); the "Alpha" tag is retained per scope.

---

## Files changed

| Path | What |
|------|------|
| `packages/core/src/pipeline.ts` | New exported `PipelineOptions { correct?, format? }`; optional 4th constructor arg `opts` (back-compat — 3-arg call sites unaffected); `finalizeOnce` gated on `doCorrect`/`doFormat` (`!== false`), keeping the `try`/`language`/`catch`. |
| `apps/backend/src/server.ts` | Connection-scope `doCorrect`/`doFormat` (default true); parsed on `start` as `msg.correct !== false` / `msg.format !== false`; `finalize` skips the `correct()` call + `correction` message when `!doCorrect`, and skips BOTH `correction.format` AND `localFormat` when `!doFormat`. |
| `apps/widget/src/main.ts` | Start frame now sends `correct: cfg.correct` + `format: cfg.format` (demo `cfg={}` → undefined → backend defaults on). |
| `apps/widget/settings.html` | Formatting row un-gated (`#formatToggle`, Alpha kept); Self-correction row un-gated (`#selfCorrect`, "Cloud only" dropped); Paste-last row replaced with a hotkey-capture row (`#pasteLastCapture` + `#pasteLastClear`), "Not in use" tag removed. |
| `apps/widget/src/settings.ts` | `AppConfig` type gains `correct?`/`format?`/`pasteLastHotkey?`; new element refs; `makeHotkeyCapture` factory (toggle re-expressed through it); paste-last wiring + `canonHotkey`/`pasteLastCollision` soft guard + `refreshPasteLastUI`; `initSelfCorrect`/`initFormat`; all wired into `refreshControls` + `DOMContentLoaded`. |
| `apps/widget/src-tauri/src/main.rs` | `static LAST_RESULT`; record it in `inject_text`; `#[cfg(desktop)] static CURRENT_PASTE_LAST`; `AppConfig` + `Default` gain `correct`/`format`/`paste_last_hotkey`; `apply_paste_last_hotkey` helper; `set_config` change-guarded re-register; `clear_config` unregister; startup register (after `register(test_paste)?`); handler branch (Released → inject `LAST_RESULT`). |
| `docs/product/settings/phase-2-progress.md` | **New.** This file. |

---

## Config schema added

Rust `AppConfig` (+ `Default`) and mirrored in the TS `AppConfig` type. Per the review,
`correct`/`format` are deliberately kept OUT of core `AppSettings`/`resolveProviders` — they
are `PipelineOptions` (core) + widget config (persisted) + WS `start` (runtime).

| Rust (snake) / TS (camel) | Type | Default | Item | UI |
|---|---|---|---|---|
| `correct` / `correct` | bool | `true` | 2.2 | Labs → Self-correction |
| `format` / `format` | bool | `true` | 2.3 | Dictation → Formatting (Alpha) |
| `paste_last_hotkey` / `pasteLastHotkey` | String | `""` | 2.1 | Shortcuts → Paste last transcript |

The `AppConfig` struct carries `#[serde(rename_all="camelCase", default)]`, so old
`settings.json` stores still load (missing fields fall back to the `Default` impl).

---

## Test results — Cloud (executed here)

- `npm test` (core): **`Test Files 13 passed (13)` · `Tests 83 passed (83)`** — was 77;
  +6 new toggle cases in `format.test.ts` (that file: 5 → 11 tests). No regression.
- `apps/widget` typecheck — `npx tsc --noEmit`: **exit 0 (pass)** (AppConfig fields,
  `makeHotkeyCapture` refactor, paste-last refs, start-frame flags).
- `apps/backend` typecheck — `npx tsc --noEmit`: **exit 0 (pass)** (`doCorrect`/`doFormat`
  gates, including the skipped-`localFormat` path).
- Static grep: `settings.html` has exactly one each of `id="pasteLastCapture"`,
  `id="selfCorrect"`, `id="formatToggle"`; **zero** "Cloud only" strings remain.

New vitest cases added to `packages/core/src/correction/format.test.ts` (FixtureSTT events +
MockCorrection, asserted via `onCorrection`/`onFormatted`):
- `correct:false bypasses the correction pass (STT-only)` — `onCorrection` never fires; the
  repeated word survives into `onFormatted`.
- `correct:true (default) still runs correction` — `onCorrection` fires; the repeat is gone.
- `correct:false + a throwing correction provider still finalizes` — provider `.correct`
  rejects but is never called; `onError` never fires; `onFormatted` = raw. Proves a true skip.
- `format:false skips the FORMAT_PROMPT pass` — custom enumeration fixture; `onFormatted`
  has no numbered-list structure and equals the cleaned (== raw) text.
- `format:true (default) still formats` — same fixture; `onFormatted` contains `1. Shopping`.
- `correct:false + format:false emits the raw transcript` — `onFormatted` === raw, no caps/
  period, `onCorrection` never fired.

Cloud-runnable checkboxes from the plan:
- [x] 2.1 widget typecheck passes with `pasteLastHotkey`, the `makeHotkeyCapture` refactor, new refs.
- [x] 2.1 static: `settings.html` has exactly one `id="pasteLastCapture"`; old "Not in use" tag gone.
- [x] 2.1 static (Rust, read-only): `LAST_RESULT` + `CURRENT_PASTE_LAST` declared;
      `apply_paste_last_hotkey` handles `""`; `paste_last_hotkey` in struct AND `Default`;
      `clear_config` unregisters it.
- [x] 2.2 core vitest: correction-bypass, default-still-runs, and throwing-provider cases pass.
- [x] 2.2 `npm test` green (83); widget + backend typecheck pass.
- [x] 2.3 core vitest: format-bypass, default-still-formats, combined-bypass cases pass.
- [x] 2.3 backend typecheck passes (the `doFormat` gate incl. skipped-`localFormat`).

> Note: `tsc --noEmit` is the only automated cloud gate for the widget; `npm test` is core
> only. Neither exercises the Rust or the runtime WS wiring — green is necessary, not
> sufficient. The Rust needs a `cargo check`/build on the Mac.

---

## Test checklist — On-Mac (UNCHECKED — for Mayank)

### Build (gates everything)
- [ ] `cd apps/widget/src-tauri && cargo check` (or `npm run widget`) compiles with the 3 new
      `AppConfig` fields + `Default`, `LAST_RESULT`, `CURRENT_PASTE_LAST`, `apply_paste_last_hotkey`,
      the handler branch, and the `set_config`/`clear_config`/startup wiring.

### 2.1 Paste last transcript
- [ ] Register a paste-last combo in Settings → it persists (reopen shows it) and does not
      collide with the toggle or ⌥⇧V (the UI rejects those with a soft guard).
- [ ] Dictate once; focus another app's text field; press the combo → the last formatted
      transcript is injected.
- [ ] Press the combo before any dictation → nothing happens (graceful no-op), no crash.
- [ ] Clear the combo → pressing it no longer pastes; Reset also clears it.
- [ ] Change the combo live → the old accelerator stops firing, the new one works (re-register).
- [ ] Try to set the combo to the toggle hotkey (or ⌥⇧V) → the capture row shows the collision
      message and does not persist.

### 2.2 Self-correction toggle
- [ ] Toggle Self-correction OFF → dictate → the final output is the raw transcript (no
      strike-through diff animation, no `correction` message).
- [ ] Toggle ON → today's behaviour returns (diff animates, fillers struck).
- [ ] Confirm the output box isn't left on the typing spinner when correction is suppressed
      (final text arrives via the `formatted` message).
- [ ] Restart app with it OFF → still off (persisted); default is ON for a fresh config / after Reset.

### 2.3 Formatting toggle
- [ ] Toggle Formatting OFF → dictate → inserted text is unformatted (no added
      punctuation/capitalization/list structure); confirm the `localFormat` fallback is also
      skipped (a lowercased, unpunctuated result).
- [ ] Toggle ON → today's formatted output returns.
- [ ] `format:off` + `correct:off` together → inserted text is the raw transcript.
- [ ] Persists across restart; default ON after Reset.

---

## Deviations from the plan

- **2.1 collision guard implemented in TS via a `canonHotkey` normalizer** (maps presets →
  accelerators, normalizes/sorts modifiers) rather than a naive string compare, so the guard
  catches the toggle/⌥⇧V regardless of preset-vs-captured form or modifier order. It remains a
  *soft* UI guard (the plan's recommendation); the OS register-error is not relied upon.
- **`makeHotkeyCapture` factory chosen over an additive duplicate** (review Q3 slight
  preference). The toggle's existing Clear (→ `alt-space`) and presets rows are untouched; only
  the capture/keydown logic was extracted. Paste-last's Clear sets `""` directly, so the
  factory did not need an `allowEmptyClear` option — the two Clear buttons stay caller-owned.
- **Self-correction copy** neutralized (dropped "Cloud only", reworded the description to
  explain the off state) per review Q4; kept it an unlabeled switch rather than adding an
  "STT-only" tag.

## Parked / needs Mayank's input

- **Rust compile is unverified** (cloud limitation). Run `cargo check` on the Mac. Likely
  first failure points: the new handler branch inside the global-shortcut closure, and
  `apply_paste_last_hotkey`'s `#[cfg(desktop)]` gating / `GlobalShortcutExt` import.
- **`LAST_RESULT` is retained only in memory** (never persisted/logged), so paste-last does
  not survive an app restart — matches the plan's scope (it's the *session's* last transcript).
- **Implicit `inject_text` seam** (per review Q1): if a future change adds a second
  `inject_text` caller with non-final text, `LAST_RESULT` would drift — revisit the explicit
  `remember_last_transcript` command then.
- **Rotate the pasted PyAI test key** before public release (unchanged pre-existing gate).
