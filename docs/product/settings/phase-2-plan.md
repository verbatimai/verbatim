# Settings — Phase 2 (Wave 2 — "Small features") Implementation Plan

**Owner:** Mayank Banga · Saaslabs
**Date:** 13 Aug 2026
**Scope:** items 2.1–2.3 of `settings-plan.md` §3 ("Wave 2 — Small features"):
paste-last-transcript global hotkey (2.1), self-correction real toggle (2.2),
formatting toggle (2.3). Planner output only — **no code is written here.**

**Reads first:** `settings-plan.md` §0 (guardrails), §1 (config table), §3; and
`phase-1-progress.md` (current landed state — Phase 1 added `launch_at_login`,
`debug`, `theme`, `key_storage` + `secrets.rs`, all authored-but-uncompiled in the
cloud).

---

## 0. Cross-cutting facts established by reading the current code

These drive every item below; cited once here so each item can stay short.

- **The finalized transcript lives in the WEBVIEW, not Rust.** The backend
  (`apps/backend/src/server.ts`) computes the final text and sends it over WS as
  `{ type: "formatted", text }` (server.ts:146). `apps/widget/src/main.ts`
  `handle()` receives it (main.ts:289–295), stores it in the module-scoped
  `finalText` / `lastResult` (main.ts:124–125), and calls
  `injectFinal(m.text)` → `invoke("inject_text", { text })` (main.ts:255–277).
  **Rust's `inject_text` (main.rs:32–43) receives the string as an argument but
  does not retain it.** This is the 2.1 seam (see 2.1 · Risks).

- **The widget's runtime pipeline is the dev backend, NOT `packages/core`'s
  `Pipeline`.** `server.ts` re-implements finalize (server.ts:100–150) with its
  own `correction.correct` (server.ts:123) + format pass (server.ts:134–144).
  The core `Pipeline.startStreaming` finalize (pipeline.ts:233–255) is a parallel
  implementation exercised by vitest (`format.test.ts`), the integration tests,
  and `cli.ts`. **2.2/2.3 therefore need edits in BOTH places:** the core change
  (unit-testable in the cloud) and the backend change (the path the widget
  actually runs; typecheck cloud-runnable, behaviour on-Mac). The flag reaches
  the backend on the WS `start` message (server.ts:161–208 already parses
  `msg.sttProvider` / `msg.correctionProvider` / `msg.language`).

- **Hotkey infra (main.rs):** `CURRENT_TOGGLE: Mutex<Option<Shortcut>>` (24–25),
  `parse_accelerator` (593–615, accepts both preset ids and `"Alt+Shift+KeyD"`
  captured accelerators), `apply_hotkey` (651–662, unregister-old→register-new→
  remember), `set_toggle_hotkey` (664–669, thin wrapper over `set_config`), the
  global-shortcut handler closure (812–889) that already special-cases the
  `test_paste` ⌥⇧V accelerator (809–810, fires on `Released`) and otherwise
  compares against `CURRENT_TOGGLE`. Registration at startup: 799–892. Handlers
  registered in `generate_handler!` (948–971).

- **Capture UI (settings.ts):** `onCaptureKeydown` (285–310) reads modifiers + a
  Web `KeyboardEvent.code`, builds `"Alt+Shift+KeyD"`, calls
  `invoke("set_toggle_hotkey", { id })`. `hotkeyCaptureEl.onclick` (311–317) arms
  it; `hotkeyClearEl` (318–324) resets to `alt-space`; presets (325–333).
  `describeHotkey` (262–271) renders glyphs. **These are toggle-specific
  (hard-wired to `config.hotkey` + `set_toggle_hotkey`)** and must be
  parameterized to be reused for 2.1.

- **Decision — `correct`/`format` do NOT go in core `AppSettings`.** `AppSettings`
  (settings.ts:19–26) is the documented single source of truth for *provider
  selection + language*, consumed by `resolveProviders` (settings.ts:45–51),
  which returns providers only. `correct`/`format` are pipeline *behaviour*
  flags, not provider selection. Putting them in `AppSettings` would force
  `resolveProviders` to grow a non-provider concern. **They belong as `Pipeline`
  constructor options (core), the widget `AppConfig` (persisted), and the WS
  `start` message (runtime).** `resolveProviders`/`DEFAULT_SETTINGS` stay
  untouched.

---

## Item 2.1 — Paste last transcript (global hotkey)

### Goal
A configurable global accelerator (default unset) that, when pressed, injects the
**last formatted transcript** into the currently-focused field via the existing
`axinject`/`inject_text` path — refusing gracefully when there is nothing to
paste. A second hotkey-capture row in Settings (Shortcuts pane) sets it, reusing
the toggle's capture UI.

### Files & exact edits

**`apps/widget/src-tauri/src/main.rs`**
1. **Store the last transcript.** Add a static next to `CURRENT_TOGGLE`
   (near 16–25):
   ```rust
   static LAST_RESULT: Mutex<Option<String>> = Mutex::new(None);
   ```
2. **Capture it.** In `inject_text` (32–43) — which is invoked *exclusively* from
   main.ts `injectFinal` with the finalized formatted text — record the argument
   before injecting:
   ```rust
   fn inject_text(text: String) -> Result<String, String> {
       *LAST_RESULT.lock().unwrap() = Some(text.clone());   // remember for paste-last (2.1)
       // …existing macOS / non-macOS branches, unchanged…
   }
   ```
   (Primary seam — needs **zero** webview change. Alternative in Risks.)
3. **Track the registered accelerator.** Add a second static mirroring
   `CURRENT_TOGGLE` (guard `#[cfg(desktop)]`):
   ```rust
   #[cfg(desktop)]
   static CURRENT_PASTE_LAST: Mutex<Option<tauri_plugin_global_shortcut::Shortcut>> = Mutex::new(None);
   ```
4. **Register / re-register helper.** Add `apply_paste_last_hotkey` next to
   `apply_hotkey` (651–662). Unlike the toggle it must accept the empty string
   (= unset → unregister only):
   ```rust
   #[cfg(desktop)]
   fn apply_paste_last_hotkey(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
       use tauri_plugin_global_shortcut::GlobalShortcutExt;
       let gs = app.global_shortcut();
       if let Some(old) = CURRENT_PASTE_LAST.lock().unwrap().take() {
           let _ = gs.unregister(old);
       }
       if id.trim().is_empty() { return Ok(()); }              // "" = disabled
       let sc = parse_accelerator(id).ok_or_else(|| format!("unrecognized hotkey: {id}"))?;
       gs.register(sc).map_err(|e| e.to_string())?;
       *CURRENT_PASTE_LAST.lock().unwrap() = Some(sc);
       Ok(())
   }
   ```
5. **Wire into `set_config`.** In `set_config` (160–189), after the existing
   toggle re-register (173–176), add a **change-guarded** re-register (mirrors the
   `launch_at_login`/`debug` guards at 179–185):
   ```rust
   #[cfg(desktop)]
   if next.paste_last_hotkey != old.paste_last_hotkey {
       let _ = apply_paste_last_hotkey(&app, &next.paste_last_hotkey);
   }
   ```
   No new Tauri command is needed — the Settings UI calls `set_config` via the
   existing `patchConfig` path. (`clear_config` at 209–225 should also call
   `apply_paste_last_hotkey(&app, "")` so Reset unregisters it — add one line.)
6. **Register at startup.** `apply_paste_last_hotkey` calls `app.global_shortcut()`,
   which requires the global-shortcut plugin to already be **built** (main.rs:812–889).
   So place this **after line 892** (`app.global_shortcut().register(test_paste)?;`),
   not earlier in the `~799–892` block:
   ```rust
   let _ = apply_paste_last_hotkey(app.handle(), &read_config(app.handle()).paste_last_hotkey);
   ```
   (Placing it before the `.plugin(global_shortcut::Builder…).build()` at 889 would
   panic/err — the plugin isn't registered yet.)
7. **Handle the keypress.** In the global-shortcut handler closure (814–887), add
   a branch **before** the `CURRENT_TOGGLE` comparison (parallel to the
   `test_for_handler` branch at 816–830), firing on `Released` like `test_paste`
   (so physical modifiers are up before the synthetic ⌘V):
   ```rust
   let is_paste_last = CURRENT_PASTE_LAST.lock().unwrap().as_ref().map_or(false, |t| t == shortcut);
   if is_paste_last {
       if event.state() == ShortcutState::Released {
           #[cfg(target_os = "macos")]
           if let Some(text) = LAST_RESULT.lock().unwrap().clone() {
               if !text.trim().is_empty() { let _ = axinject::inject(&text); }
           }
       }
       return;
   }
   ```
   Empty/None `LAST_RESULT` = graceful no-op (nothing dictated yet).

**`apps/widget/settings.html`** — replace the static "Paste last transcript" row
(354–364, currently a `<span class="kbd-group">⌘⌃V</span>` + `Not in use` tag)
with a capture row mirroring "Toggle dictation" (321–345): drop the tag, and add
```html
<div class="control-col align-end">
  <div class="hotkey-row">
    <input id="pasteLastCapture" class="hotkey" type="text" readonly value="Click, then press a combo" />
    <button id="pasteLastClear" class="btn ghost" title="Clear">Clear</button>
  </div>
</div>
```
(No presets row — paste-last has no default presets; free capture only.)

**`apps/widget/src/settings.ts`**
- Add to the `AppConfig` type (9–22): `pasteLastHotkey?: string;`.
- **Parameterize the capture logic.** Refactor so `onCaptureKeydown` /
  `stopRecording` / the arming click aren't hard-wired to the toggle. Cleanest:
  extract a `makeHotkeyCapture(inputEl, onAccel, { allowEmptyClear })` factory
  that owns its own `recording` flag + keydown listener and calls
  `onAccel(accel)` on a valid combo. Re-express the existing toggle wiring
  (285–333) through it with `onAccel = (id) => invoke("set_toggle_hotkey",{id})`,
  and add a second instance:
  ```ts
  const pasteLastCaptureEl = $<HTMLInputElement>("pasteLastCapture");
  const pasteLastClearEl  = $<HTMLButtonElement>("pasteLastClear");
  makeHotkeyCapture(pasteLastCaptureEl, (accel) => patchConfig({ pasteLastHotkey: accel }));
  pasteLastClearEl.onclick = () => void patchConfig({ pasteLastHotkey: "" });
  ```
- Add `refreshPasteLastUI()` (sets `pasteLastCaptureEl.value` from
  `config.pasteLastHotkey` via the existing `describeHotkey`, or a "Click, then
  press a combo" placeholder when `""`), and call it from `refreshControls`
  (447–456) and `DOMContentLoaded` (479–496).

*(No `main.ts` change: `injectFinal` already routes every final through
`inject_text`, which now records `LAST_RESULT`.)*

### Config schema delta
| Rust (snake) / TS (camel) | Type | Default | Default-impl | TS mirror |
|---|---|---|---|---|
| `paste_last_hotkey` / `pasteLastHotkey` | `String` / `string` | `""` | add `paste_last_hotkey: String::new()` to `AppConfig::default` (112–129) | `pasteLastHotkey?: string;` in settings.ts `AppConfig` (9–22) |

Struct field added to `AppConfig` (95–110) under `#[serde(rename_all="camelCase", default)]` (already container-level `default`, so old `settings.json` still loads — §0 guardrail satisfied).

### Test checklist

**Cloud-runnable (core vitest / typecheck):**
- [ ] `apps/widget` `npx tsc --noEmit` passes with the new `pasteLastHotkey`
      field, the `makeHotkeyCapture` refactor, and the new refs.
- [ ] Static check: `settings.html` has exactly one `id="pasteLastCapture"`; the
      old `Not in use` tag on that row is gone.
- [ ] Static check (Rust, read-only — cannot compile in cloud): `LAST_RESULT`
      and `CURRENT_PASTE_LAST` declared; `apply_paste_last_hotkey` handles `""`;
      `paste_last_hotkey` present in struct **and** `Default`; `clear_config`
      unregisters it.

**On-Mac (cargo build / npm run widget):**
- [ ] `cargo build` compiles the two new statics, `apply_paste_last_hotkey`, the
      handler branch, the `set_config`/`clear_config`/startup wiring.
- [ ] Set a paste-last combo in Settings → it persists (reopen shows it) and does
      not collide with the toggle or ⌥⇧V.
- [ ] Dictate once; focus another app's text field; press the combo → the last
      formatted transcript is injected.
- [ ] Press the combo before any dictation → nothing happens (graceful no-op), no
      crash.
- [ ] Clear the combo → pressing it no longer pastes; Reset also clears it.
- [ ] Change the combo live → old accelerator stops firing, new one works
      (re-register path).

### Risks / notes
- **Last-transcript ownership seam (the headline risk).** The final string is
  owned by the webview today; Rust must retain a copy for the global handler,
  which runs with no webview involvement. The chosen seam (record inside
  `inject_text`) is minimal and needs no WS/backend change, and is correct because
  `inject_text` is invoked *only* by `injectFinal` with the finalized text. **But
  it is implicit** — if a future change calls `inject_text` for some other string
  (or stops routing finals through it), `LAST_RESULT` silently drifts.
  **Alternative (more explicit, slightly more code):** a dedicated
  `#[tauri::command] fn remember_last_transcript(text)` invoked from main.ts's
  `formatted` handler (main.ts:289–295), decoupled from injection. `settings-plan`
  §2.1 / §10.2 flag this as "cleanest after the 4.8 sidecar" — 4.8 has landed
  (Rust owns the backend), but the *final string* still travels webview→Rust, not
  backend→Rust, so this does **not** require further sidecar work.
- **Accelerator collisions.** `parse_accelerator` will happily register a combo
  equal to the toggle or to ⌥⇧V; the OS may reject a duplicate registration or
  the handler ordering may shadow one. Add a UI guard (reject a paste-last combo
  equal to `config.hotkey`) and/or surface the register error. Flag for on-Mac
  validation.
- **`Released`-only fire** is deliberate (matches `test_paste`); do not also act
  on `Pressed` or the synthetic ⌘V can race the physical modifiers.

---

## Item 2.2 — Self-correction real toggle (`correct`)

### Goal
Turn the decorative, `disabled checked` "Self-correction" row (settings.html
Labs, 435–449) into a real switch. `correct` default `true`. When **false**, the
pipeline skips the correction pass entirely → the final output is the raw
(STT-only) transcript, with **no** strike-through diff shown.

### Files & exact edits

**`packages/core/src/pipeline.ts` (core seam — unit-tested):**
- Add an options type + optional 4th constructor arg (backward compatible;
  `cli.ts:53` and `format.test.ts:25/41/57` pass only 3 args and keep working):
  ```ts
  export interface PipelineOptions { correct?: boolean; format?: boolean; }
  // constructor (213–218):
  constructor(
    private stt: STTProvider,
    private correction: CorrectionProvider,
    private h: PipelineHandlers = {},
    private opts: PipelineOptions = {},
  ) {}
  ```
- In `finalizeOnce` (233–255) gate the correction call. Replace lines **240–248**
  (KEEP the `try {` at 238 and `const language = sttConfig?.language;` at 239 —
  the snippet below relies on `language` being in scope, and the existing
  `catch (e)` at 249–252 must still wrap the new body so a thrown provider still
  finalizes with `onFormatted({ text: raw })`)
  so that when `opts.correct === false` the pipeline **does not call**
  `this.correction.correct`, emits **no** `onCorrection`, and treats `cleaned =
  raw`:
  ```ts
  const doCorrect = this.opts.correct !== false;   // default true
  const doFormat  = this.opts.format  !== false;   // 2.3
  let cleaned = raw;
  if (doCorrect) {
    const result = await this.correction.correct(raw, { language });
    this.h.onCorrection?.({ raw, result });
    cleaned = result.cleanText || raw;
  }
  if (doFormat && this.correction.format) {
    const f = await this.correction.format(cleaned, language);
    this.h.onFormatted?.({ text: f.text });
  } else {
    this.h.onFormatted?.({ text: cleaned });
  }
  ```
  (This single rewrite covers 2.2 **and** 2.3.)

**`apps/backend/src/server.ts` (runtime seam — the path the widget runs):**
- Parse the flag on `start` (161–208), defaulting to true for old clients:
  ```ts
  // near sttId/corrId/language (167–169):
  const doCorrect = msg.correct !== false;
  const doFormat  = msg.format  !== false;   // 2.3
  ```
  Store them in the connection scope (alongside `sttId`/`corrId`, 94–95) so
  `finalize` can read them.
- In `finalize` (100–150) gate the cleanup at 121–128: when `!doCorrect`, skip the
  `await correction.correct(raw)` call and the `{ type: "correction" }` send;
  set `cleanText = raw`. The formatting block (133–144) already runs off
  `cleanText`, so it correctly formats the raw text when correction is off.

**`apps/widget/src/main.ts` (pass the flag):** in `connect()`'s start frame
(328–334) add `correct: cfg.correct` (and `format: cfg.format` for 2.3). `cfg`
comes from `get_config` (320) and is typed `any`, so no TS type change here; demo
mode sends `{}` so the backend defaults both to true.

**`apps/widget/settings.html`:** on the Self-correction row (435–449) remove
`disabled`, give the input `id="selfCorrect"`, and drop the `Cloud only` tag (or
change it to a neutral state note). Keep the descriptive copy.

**`apps/widget/src/settings.ts`:** add `correct?: boolean;` to `AppConfig`
(9–22); add `const selfCorrectEl = $<HTMLInputElement>("selfCorrect");` and
```ts
function initSelfCorrect() {
  if (!selfCorrectEl) return;
  selfCorrectEl.checked = config.correct !== false;   // default on
  selfCorrectEl.onchange = () => void patchConfig({ correct: selfCorrectEl.checked });
}
```
call it from `refreshControls` (447–456) and `DOMContentLoaded` (479–496).

### Config schema delta
| Rust (snake) / TS (camel) | Type | Default | Default-impl | TS mirror |
|---|---|---|---|---|
| `correct` / `correct` | `bool` / `boolean` | `true` | add `correct: true` to `AppConfig::default` (112–129) | `correct?: boolean;` in settings.ts `AppConfig` |

Field added to `AppConfig` struct (95–110). WS `start` gains optional `correct`
(backend defaults `!== false` → true). Core `PipelineOptions.correct` defaults true.

### Test checklist

**Cloud-runnable (core vitest / typecheck):** add to
`packages/core/src/correction/format.test.ts` (same harness: `FixtureSTT` +
`MockCorrection`, asserting via `onCorrection`/`onFormatted`):
- [ ] **`"correct:false bypasses the correction pass (STT-only)"`** — construct
      `new Pipeline(new FixtureSTT(events), new MockCorrection(), handlers, { correct: false })`
      where the fixture transcript contains a filler `MockCorrection` would strip
      (e.g. a repeated word / `"r"` from `mock.ts` FILLERS 15). Assert
      `onCorrection` **never fired** (spy flag stays false) and the `onFormatted`
      text still contains the un-removed word (correction did not run). Use a
      fixture whose raw survives formatting so the word is observable.
- [ ] **`"correct:true (default) still runs correction"`** — same fixture, no
      opts; assert `onCorrection` fired and the filler is gone from the corrected
      `result.cleanText`. (Guards against the default flipping.)
- [ ] **`"correct:false + a throwing correction provider still finalizes"`** —
      pass a correction stub whose `.correct` rejects; with `correct:false` it is
      never called, so `onFormatted` fires with the raw/formatted text and no
      `onError`. (Proves the bypass is a true skip, not a caught failure.)
- [ ] `npm test` stays green (77 existing tests, per phase-1-progress).
- [ ] `apps/backend` + `apps/widget` `npx tsc --noEmit` pass with the new flag.

**On-Mac (cargo build / npm run widget):**
- [ ] `cargo build` compiles the `correct` field + `Default`.
- [ ] Toggle Self-correction **off** in Settings → dictate → final output is the
      raw transcript (no strike-through diff animation, no `correction` message).
- [ ] Toggle **on** → today's behaviour returns (diff animates, fillers struck).
- [ ] Restart app with it off → still off (persisted); default is on for a fresh
      config / after Reset.

### Risks / notes
- **Two implementations must agree.** The vitest covers `Pipeline`; the widget
  runs `server.ts`. Both edits above are required — a passing unit test does NOT
  prove the widget honours the flag. Keep the bypass semantics identical
  (skip call, `cleaned = raw`, no `correction`/`onCorrection` emission).
- With `correct:false`, `finalOut` gets its text only from the `formatted`
  message (main.ts:289–295); confirm on-Mac the output box isn't left on the
  typing spinner when the correction message is suppressed.

---

## Item 2.3 — Formatting toggle ("Alpha") (`format`)

### Goal
Expose the finalize `FORMAT_PROMPT` pass as an on/off `format` flag (default
`true`). When **false**, skip formatting → the inserted text is the
cleaned-but-unformatted transcript (or the raw transcript if `correct` is also
off). Enable the currently `disabled` "Formatting" row (settings.html Dictation,
291–302); **keep the "Alpha" tag** per scope.

### Files & exact edits

**`packages/core/src/pipeline.ts`:** already covered by the 2.2 rewrite —
`doFormat = this.opts.format !== false` gates the `this.correction.format` call;
when off, `onFormatted({ text: cleaned })` emits the unformatted text.
`PipelineOptions.format` added there.

**`apps/backend/src/server.ts`:** `doFormat` parsed on `start` (see 2.2). In
`finalize`, gate the format block (133–144): when `!doFormat`, **skip both** the
LLM `correction.format` (134–141) **and** the `localFormat` fallback (142–143) —
set `finalText = cleanText` directly. (Today when a provider lacks `format`, the
backend falls back to `localFormat`; the `format:false` path must bypass *that
too*, otherwise the toggle wouldn't actually turn formatting off.)

**`apps/widget/src/main.ts`:** send `format: cfg.format` in the start frame
(328–334) — same edit as 2.2.

**`apps/widget/settings.html`:** on the Formatting row (291–302) remove
`disabled`, give the input `id="formatToggle"`, and **retain** `<span
class="tag alpha">Alpha</span>`.

**`apps/widget/src/settings.ts`:** add `format?: boolean;` to `AppConfig`; add
`const formatToggleEl = $<HTMLInputElement>("formatToggle");` and
```ts
function initFormat() {
  if (!formatToggleEl) return;
  formatToggleEl.checked = config.format !== false;   // default on
  formatToggleEl.onchange = () => void patchConfig({ format: formatToggleEl.checked });
}
```
call from `refreshControls` + `DOMContentLoaded`.

### Config schema delta
| Rust (snake) / TS (camel) | Type | Default | Default-impl | TS mirror |
|---|---|---|---|---|
| `format` / `format` | `bool` / `boolean` | `true` | add `format: true` to `AppConfig::default` (112–129) | `format?: boolean;` in settings.ts `AppConfig` |

Field added to `AppConfig` struct. WS `start` gains optional `format` (backend
defaults true). Core `PipelineOptions.format` defaults true.

### Test checklist

**Cloud-runnable (core vitest / typecheck):** add to `format.test.ts`:
- [ ] **`"format:false skips the FORMAT_PROMPT pass"`** — NOTE: format.test.ts:8
      is a *direct* `new MockCorrection().format("…")` call, NOT a reusable STT
      fixture. To drive `format:false` THROUGH the pipeline you must build a custom
      `new FixtureSTT(events, 10)` whose `acc.final()` yields the enumeration string
      (mirror the u1/u2 events pattern at format.test.ts:34–39, e.g. text
      `"i have two things to do 1 shopping and 2 swimming"`). Then
      `new Pipeline(stt, new MockCorrection(), handlers, { format: false })`.
      Assert `onFormatted.text` equals the **cleaned** text (lowercase / no
      `"1. Shopping"` numbered-list structure that `MockCorrection.format` would
      produce) — i.e. formatting demonstrably did not run.
- [ ] **`"format:true (default) still formats"`** — same fixture, default opts;
      assert `onFormatted.text` contains the formatted structure (e.g.
      `"1. Shopping"`), proving the pass ran. (Mirror of the existing
      MockCorrection.format assertions so a regression is obvious.)
- [ ] **`"correct:false + format:false emits the raw transcript"`** — both flags
      off; assert `onFormatted.text` === the raw accumulated transcript and
      neither `onCorrection` nor any formatting ran. (Covers the combined bypass
      branch of the rewritten `finalizeOnce`.)
- [ ] `npm test` stays green.
- [ ] `apps/backend` `npx tsc --noEmit` passes (backend `doFormat` gate,
      including the skipped-`localFormat` path).

**On-Mac (cargo build / npm run widget):**
- [ ] `cargo build` compiles the `format` field + `Default`.
- [ ] Toggle Formatting **off** → dictate → inserted text is unformatted (no
      added punctuation/capitalization/list structure); the `localFormat`
      fallback is also skipped (confirm a lowercased, unpunctuated result).
- [ ] Toggle **on** → today's formatted output returns.
- [ ] `format:off` + `correct:off` together → inserted text is the raw
      transcript.
- [ ] Persists across restart; default on after Reset.

### Risks / notes
- **`localFormat` must be bypassed too.** The subtle backend point: the format
  toggle isn't "skip the LLM formatter" — it's "skip formatting". The existing
  `localFormat` fallback (server.ts:142–143) would otherwise still format when
  the toggle is off, so the toggle must gate the *whole* block.
- **Alpha tag stays** — quality of the raw-clean output is not the point of this
  toggle; it exposes a real switch, not a polished feature.
- Same two-implementation caveat as 2.2 (core `Pipeline` vs backend `finalize`).

---

## Shared implementation notes

- **One `AppConfig` edit covers all three fields.** Add `correct: bool`,
  `format: bool`, `paste_last_hotkey: String` to the struct (main.rs:95–110) and
  the `Default` impl (112–129) in a single change; the container already carries
  `#[serde(rename_all="camelCase", default)]` so old stores deserialize (§0
  backward-compat guardrail). Mirror all three in the settings.ts `AppConfig`
  type (9–22).
- **`main.ts` start-frame edit is shared by 2.2 + 2.3** (add `correct` +
  `format`); do it once.
- **No secrets touched.** None of these paths read `.env` or log key values; the
  paste-last text is a user transcript (not a secret) and is only held in a Rust
  in-memory `Mutex`, never written to disk or logged.
- **Sequencing:** land 2.2 + 2.3 together (they share the `finalizeOnce` rewrite,
  the backend `start`/`finalize` gates, the `main.ts` start frame, and the core
  vitest file). 2.1 is independent (Rust hotkey + capture-UI refactor) and can
  land in either order.

---

## Open questions for reviewer

1. **2.1 seam — implicit vs explicit?** Record `LAST_RESULT` inside `inject_text`
   (zero webview change, but implicitly coupled to "inject_text is only ever the
   final text"), or add an explicit `remember_last_transcript` command called from
   main.ts's `formatted` handler? Plan recommends the implicit seam; flag if you
   want the explicit one.
2. **2.1 collision policy.** Should the UI actively reject a paste-last combo that
   equals the toggle hotkey (or ⌥⇧V `test_paste`), or just let the OS
   register-error surface? Recommend a soft UI guard against `config.hotkey`.
3. **2.1 capture-UI refactor scope.** OK to refactor the toggle's capture
   (`onCaptureKeydown` etc., settings.ts:285–333) into a reusable
   `makeHotkeyCapture` factory now, or keep changes additive (duplicate a second
   handler) to minimize churn on the already-working toggle path?
4. **2.2 `correct:false` UX.** When self-correction is off there is no diff
   animation — should the live transcript still show, and should the "Self-
   correction" Labs tag become e.g. "STT-only" when off, or just an unlabeled
   switch? (Copy decision.)
5. **Core `AppSettings` boundary.** Confirm the decision to keep `correct`/`format`
   OUT of core `AppSettings`/`resolveProviders` (they're `Pipeline` options +
   widget config + WS message). If you'd rather have a single core settings
   object thread them, that changes the `Pipeline` construction sites
   (`cli.ts`, `server.ts`, tests).
6. **Backend flag defaulting.** Confirm `msg.correct !== false` / `msg.format !==
   false` (undefined → true) is the desired back-compat rule for a start frame
   from an older/demo client.
