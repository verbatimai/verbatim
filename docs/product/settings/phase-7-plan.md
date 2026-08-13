# Phase 7 — Audit-fix implementation plan

_Planner output. Code-accurate, no code changed. Fixes the 3 "wired in the UI but dead on
the real path" bugs from `docs/product/settings/audit/` (F1 HIGH model overrides, Deepgram
batch keyword-boost MED, `dock_icon` MED). PyAI is the priority provider — every fix keeps
the PyAI path correct and must not regress the language / auto-detect fix (Phase 3)._

Line numbers below are against the current working copy (2026-08-13). Re-anchor by symbol if
the file has shifted.

**Threading model (shared by fixes 1 & 2).** Mirror exactly how `language` / `autoDetect` /
`vocabulary` already flow — TS-only, per-session, over the WS `start` frame; NO Rust, NO
sidecar-env bridge. Path per value:
`cfg.* (widget store)` → `main.ts` start frame → `server.ts` start handler (remember in a
connection-scoped `let`) → adapter `startSession` / `transcribeBatch` / `correct` / `format`
→ adapter resolves `cfg.model ?? env ?? default`.

**Empty-string contract (critical).** The store default for both model fields is `""` =
"provider default" (`settings.ts:97-98`, `main.rs:144`-adjacent). An empty/whitespace model
must NEVER override — resolution is:
```
resolved = (passedModel && passedModel.trim()) ? passedModel : (process.env.<VAR> ?? DEFAULT)
```
Enforce this at BOTH boundaries: `server.ts` converts an empty start-frame value to
`undefined`; each adapter additionally treats empty/whitespace as no-override (so the
adapter-level vitest cases hold when called directly with `model: ""`).

---

## Fix 1 — [HIGH] Wire `sttModel` + `correctionModel` end-to-end (TS-only)

### Goal
A model chosen in the Settings "Models" pane reaches the real vendor request on BOTH the
streaming and the authoritative batch/finalize paths, for STT (Deepgram/OpenAI; PyAI is
single-model) and correction (OpenAI/Anthropic; PyAI ignores `model`). No sidecar restart.

### Files & exact edits

**1. `apps/widget/src/main.ts`** — start frame object (currently lines 336-348). Add two
fields alongside the existing `language`/`autoDetect`/`vocabulary` forwards. In demo mode
`cfg = {}` so both are `undefined` → backend treats as default (correct).
```ts
telemetry: cfg.telemetry,
sttModel: cfg.sttModel,               // Phase 7 — STT model override ("" = provider default)
correctionModel: cfg.correctionModel, // Phase 7 — correction model override ("" = default)
```

**2. `apps/backend/src/server.ts`**
- Add two connection-scoped `let`s next to `langTag`/`vocabulary` (near lines 94-104) so
  `finalize()` (which runs `transcribeBatch` + `correct` + `format`) can read them:
  ```ts
  let sttModel: string | undefined;   // Phase 7 — STT model override ("" ⇒ undefined ⇒ default)
  let corrModel: string | undefined;  // Phase 7 — correction model override
  ```
- In the `start` handler (after the `vocabulary`/`snippets` parse, ~lines 211-216), parse
  with the empty-string guard:
  ```ts
  sttModel  = typeof msg.sttModel === "string"  && msg.sttModel.trim()  ? msg.sttModel  : undefined;
  corrModel = typeof msg.correctionModel === "string" && msg.correctionModel.trim() ? msg.correctionModel : undefined;
  ```
- Thread into `startSession` (line 245): add `model: sttModel` to the config object.
- Thread into `transcribeBatch` (line 119): add `model: sttModel` to the cfg object.
- Thread into `correct` (line 136): `correction.correct(raw, { language: langTag, vocabulary, model: corrModel })`.
- Thread into `format` (line 156): `correction.format(cleanText, langTag, vocabulary, corrModel)`.

**3. `packages/core/src/providers/types.ts`**
- Add to `STTSessionConfig` (interface at lines 38-56):
  ```ts
  /** Phase 7 — per-session STT model override. "" / whitespace / undefined ⇒ use env then
   *  the adapter default. PyAI Hear ignores it (single model). */
  model?: string;
  ```
- Widen the optional `transcribeBatch` cfg (line 68) to add `model?: string` (and, for Fix 2,
  `keywords?: string[]`):
  ```ts
  transcribeBatch?(pcm: Uint8Array, cfg: { apiKey: string; sampleRate?: number; language?: string; detectLanguage?: boolean; model?: string; keywords?: string[] }): Promise<string>;
  ```

**4. `packages/core/src/providers/deepgram.stt.ts`**
- `startSession` model resolution (line 34) — prefer cfg:
  ```ts
  const model = (cfg.model && cfg.model.trim()) ? cfg.model : (process.env.DEEPGRAM_STT_MODEL ?? DEFAULT_MODEL);
  ```
  The `keywords`/`keyterm` branch (lines 62-68) already keys off `model`, so it now correctly
  branches on the per-user model. Ordering is fine (model resolved at 34, branch at 62).
- `transcribeBatch` model resolution (line 80) — same prefer-cfg change. (Keyword handling in
  batch is Fix 2, below.)

**5. `packages/core/src/providers/openai.stt.ts`**
- `startSession` model resolution (line 37) — prefer cfg (same pattern; default
  `gpt-live-transcribe`). It is passed to `new OpenAiSession(ws, model, ...)` at line 44, which
  sends it in `transcription_session.update` (line 92) — no other change needed.
- `transcribeBatch` model (line 52) — prefer cfg, then `process.env.OPENAI_BATCH_MODEL`, then
  `"gpt-transcribe"`. NOTE: batch uses a DIFFERENT env var (`OPENAI_BATCH_MODEL`) than
  streaming (`OPENAI_STT_MODEL`); the single `cfg.model` overrides both when non-empty — see
  Open Questions.

**6. `packages/core/src/providers/pyai.stt.ts`** — single-model, no override.
- `startSession` (lines 21-35): keep the URL hardcoded `model=pyai-hear`. Add a one-line
  comment that `cfg.model` is intentionally ignored (Hear is single-model), mirroring the
  existing "language/detectLanguage/keywords ignored" note at lines 22-25.
- `transcribeBatch` (lines 39-53): keep `form.append("model", "pyai-hear")`; document that
  `cfg.model` is a no-op. (Threading still compiles because the cfg type is shared.)

**7. Correction adapters — thread the model into `correct` + `format`.**
- `packages/core/src/correction/types.ts`:
  - Add to `CorrectionContext` (interface lines 31-42):
    ```ts
    /** Phase 7 — per-request correction model override. "" / whitespace / undefined ⇒ env
     *  then the adapter default. PyAI honours the field on the wire but its server ignores
     *  it (findings F4): the answer is always gpt-5.6-sol. */
    model?: string;
    ```
  - Widen the `format` signature (line 57) to accept the same override:
    ```ts
    format?(text: string, language?: string, vocabulary?: string[], model?: string): Promise<{ text: string }>;
    ```
- `packages/core/src/correction/pyai.ts`:
  - `correct` model (line 46): `const model = (ctx?.model && ctx.model.trim()) ? ctx.model : (process.env.PYAI_MODEL ?? "gpt-5.6-sol");`
  - `format` (line 67): add the `model?` param and resolve the same way (line 68). The adapter
    SENDS the resolved model in the request body; the PyAI server ignores it (F4) — that's the
    documented no-op, threading is still uniform.
- `packages/core/src/correction/openai.ts`:
  - `correct` model (line 85): prefer `ctx?.model`, then `process.env.OPENAI_CORRECTION_MODEL`, then `"gpt-4o-mini"`.
  - `format` (line 110-111): add `model?` param; resolve the same. Meaningful override (OpenAI honours it).
- `packages/core/src/correction/anthropic.ts`:
  - `correct` model (line 53): prefer `ctx?.model`, then `process.env.ANTHROPIC_MODEL`, then `"claude-sonnet-4-5"`.
  - `format` (line 73-74): add `model?` param; resolve the same. Meaningful override.
- `packages/core/src/correction/mock.ts`: verify `format`/`correct` signatures still satisfy
  the widened interface (adding a trailing optional param is source-compatible — no change
  expected; confirm it compiles).

### Type / interface deltas
- `STTSessionConfig` gains `model?: string`.
- `transcribeBatch` cfg gains `model?: string` (+ `keywords?: string[]` from Fix 2).
- `CorrectionContext` gains `model?: string`.
- `CorrectionProvider.format` gains a 4th optional param `model?: string`.
All additive/optional → no breaking changes to existing callers or the `mock`/`fixture` adapters.

### Test checklist

Cloud-runnable (vitest, `packages/core`):
- [ ] `deepgram.stt.integration.test.ts` — new describe "DeepgramSTT model override (Phase 7)":
  extend the `connectQuery` helper to accept `model`.
  - [ ] `startSession({ model: "nova-3" })` → connect query contains `model=nova-3`.
  - [ ] `startSession({ model: "nova-3", keywords: ["Verbatim"] })` → query contains `keyterm=Verbatim` and NOT `keywords=` (branch keys off the per-user model).
  - [ ] `startSession({ model: "" })` with `DEEPGRAM_STT_MODEL` unset → `model=nova-2` (empty does NOT override).
  - [ ] `startSession({ model: "" })` with `process.env.DEEPGRAM_STT_MODEL = "nova-3"` → `model=nova-3` (env used when cfg empty).
  - [ ] `startSession({ model: "nova-custom" })` with env set → `model=nova-custom` (cfg wins over env). Remember to `delete process.env.DEEPGRAM_STT_MODEL` in `afterEach` (already cleaned there).
- [ ] `deepgram.stt.integration.test.ts` — `transcribeBatch`: extend `batchCall` to pass `model`; assert `r.url` contains `model=nova-3`; empty→`model=nova-2`; env-precedence case.
- [ ] `openai.stt.integration.test.ts` — extend `seenConfig` with `model`; assert `config.input_audio_transcription.model === "<passed>"`; empty→`gpt-live-transcribe`; env precedence (`OPENAI_STT_MODEL`).
- [ ] `openai.stt.integration.test.ts` — `transcribeBatch`: capture the raw multipart body in the mock (concat `req.on("data")`); assert the body string contains the passed model (e.g. `gpt-transcribe-custom`); empty→`gpt-transcribe`; `OPENAI_BATCH_MODEL` precedence.
- [ ] `pyai.integration.test.ts` — PyAI STT is single-model: `startSession({ model: "x" })` still connects with `model=pyai-hear`; `transcribeBatch(pcm, { apiKey, model: "x" })` still posts `pyai-hear` (documents the no-op; guards against accidentally threading it into the URL).
- [ ] `pyai.integration.test.ts` (correction) — extend `mockMessagesServer` to capture the request body; `correct(RAW, { model: "custom-x" })` → `body.model === "custom-x"` (adapter sends it); `correct(RAW, { model: "" })` with `PYAI_MODEL` unset → `body.model === "gpt-5.6-sol"`; `PYAI_MODEL` env precedence. Add a comment that the live server ignores it (F4).
- [ ] `correction/openai.integration.test.ts` — `mockChatServer` already captures `body`. `correct(RAW, { model: "gpt-4o-custom" })` → `seen.body.model === "gpt-4o-custom"`; empty→`gpt-4o-mini`; `OPENAI_CORRECTION_MODEL` precedence. `format("…", "en", [], "gpt-4o-custom")` → `body.model` matches.
- [ ] `correction/anthropic.integration.test.ts` — `requests[0].body.model` assertions for `correct(raw, { model: "claude-x" })`, empty→`claude-sonnet-4-5`, `ANTHROPIC_MODEL` precedence, and the `format(…, model)` param.

On-Mac (author-verified, no cloud coverage of `server.ts` wiring — there is no backend test):
- [ ] Build the widget (`cargo build` / `npm run widget`), pick a non-default Deepgram model
  (e.g. `nova-3`) in Settings, dictate, and confirm the request uses it (backend `[hear]`
  debug log / vendor dashboard). Repeat for OpenAI STT + OpenAI/Anthropic correction.
- [ ] Confirm PyAI end-to-end still works with an empty model (default `pyai-hear` /
  `gpt-5.6-sol`) — no regression to the priority provider.
- [ ] Confirm switching the model in Settings takes effect on the NEXT dictation with no app
  restart (per-session start frame).

### Risks
- **`server.ts` is not unit-tested** — no backend test file exists. The adapter contract is
  cloud-tested, but the start-frame parse + threading in `server.ts` is verified only on-Mac.
  Keep the `server.ts` edits minimal and mirror the existing `vocabulary`/`autoDetect` parse
  exactly to reduce risk.
- **Single config field, two OpenAI STT env vars.** One `sttModel` overrides BOTH
  `OPENAI_STT_MODEL` (streaming) and `OPENAI_BATCH_MODEL` (batch). If a user enters a
  streaming-only model name, the batch call may 400. See Open Questions.
- **Stale model on provider switch.** `sttModel`/`correctionModel` are single fields not keyed
  per provider; a value typed for provider A is passed to provider B after a switch. Pre-existing
  UI concern; out of scope here but worth a follow-up (validate/clear on provider change).
- **PyAI correction override is inert** (F4): wiring it restores intent but has no live effect
  until PyAI honours `model`. Documented, not a regression.

---

## Fix 2 — [MED] Deepgram vocabulary keyword-boost on the batch/finalize path

### Goal
The custom-term STT boost that already works on streaming (`keywords`/`keyterm`) also applies
to the authoritative batch transcription, since the inserted text = batch output. PyAI/OpenAI
have no STT-side boost param and are unaffected.

### Files & exact edits

**1. `packages/core/src/providers/types.ts`** — already widened in Fix 1 to add
`keywords?: string[]` to the `transcribeBatch` cfg (line 68).

**2. `apps/backend/src/server.ts`** — `transcribeBatch` call (line 119): add
`keywords: vocabulary` to the cfg object (the same `vocabulary` array already forwarded to
`startSession` at line 245).

**3. `packages/core/src/providers/deepgram.stt.ts`** — `transcribeBatch` (lines 78-102):
after the `language`/`detect_language` branch (line 91) and using the already-resolved `model`
(line 80), append the boost with the SAME model-branch logic as streaming (lines 62-68).
Deepgram's prerecorded `/v1/listen` supports both `keywords` (nova-2) and `keyterm` (nova-3):
```ts
if (cfg.keywords && cfg.keywords.length) {
  const param = /nova-3/i.test(model) ? "keyterm" : "keywords";
  for (const term of cfg.keywords) { const t = term.trim(); if (t) q.append(param, t); }
}
```

### Type / interface deltas
- `transcribeBatch` cfg gains `keywords?: string[]` (shared with Fix 1). No other change.

### Test checklist

Cloud-runnable (vitest):
- [ ] `deepgram.stt.integration.test.ts` — `transcribeBatch`: extend `batchCall` to pass
  `keywords`.
  - [ ] `keywords: ["Verbatim", "PyAI"]` with default model nova-2 → `r.url` contains
    `keywords=Verbatim` and `keywords=PyAI`.
  - [ ] `keywords: ["Verbatim"]` with `DEEPGRAM_STT_MODEL = "nova-3"` (or `model: "nova-3"`
    via Fix 1) → `r.url` contains `keyterm=Verbatim`, not `keywords=`.
  - [ ] no `keywords`/empty array → url has neither `keywords=` nor `keyterm=` (unchanged).

On-Mac:
- [ ] Add a custom term, dictate a sentence containing it with Deepgram, confirm the inserted
  (final) text recognizes it (not just the live preview).

### Risks
- Low. Prerecorded `keyterm` requires a nova-3-family model; if the user pins nova-2 the
  `keywords` form is used — matches streaming, no new failure mode.
- Very long vocabularies produce a long query string; acceptable (same as streaming today).

---

## Fix 3 — [MED] `dock_icon` activation-policy toggle (Rust — author-only, Mac build)

### Goal
`config.dock_icon` drives the macOS activation policy: `Regular` (Dock icon shown) when true,
`Accessory` (menu-bar only, no Dock icon) when false — honoured on startup AND live on toggle
— WITHOUT breaking the non-activating overlay panel or the settings-window focus dance.

### Files & exact edits (`apps/widget/src-tauri/src/main.rs`)

Add a tiny helper near `configure_non_activating_panel`:
```rust
#[cfg(target_os = "macos")]
fn desired_activation_policy(dock_icon: bool) -> tauri::ActivationPolicy {
    if dock_icon { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory }
}
```

1. **Startup honour** — `configure_non_activating_panel` (line 921). Replace the hard-coded
   `Accessory` with the configured policy:
   ```rust
   let _ = app.set_activation_policy(desired_activation_policy(read_config(&app.handle()).dock_icon));
   ```
   (This runs in `setup` at line 975; the panel reclass + style mask below are unchanged and
   remain the mechanism that keeps the overlay non-activating regardless of policy.)

2. **Live toggle** — `set_config` change-guards (lines 209-228). Add, alongside the other
   `next.* != old.*` guards:
   ```rust
   #[cfg(target_os = "macos")]
   if next.dock_icon != old.dock_icon {
       let _ = app.set_activation_policy(desired_activation_policy(next.dock_icon));
   }
   ```

3. **Settings-close revert must respect the config** — the `CloseRequested` handler (line 989)
   currently hard-reverts to `Accessory`. With the dock icon shown, that would wrongly hide it
   after the user opens+closes Settings. Change it to revert to the CONFIGURED policy:
   ```rust
   #[cfg(target_os = "macos")]
   let _ = app_h.set_activation_policy(desired_activation_policy(read_config(&app_h).dock_icon));
   ```
   (`open_settings_window` at line 88 still bumps to `Regular` to grab keyboard focus — that's a
   superset of `Regular` and harmless; the revert now lands on the real configured policy.)

4. **Reset** — `clear_config` (lines 252-272) resets `dock_icon` to its default (`false`). Add a
   policy re-apply there for correctness so a Reset that clears a previously-on dock icon takes
   effect live:
   ```rust
   #[cfg(target_os = "macos")]
   let _ = app.set_activation_policy(desired_activation_policy(def.dock_icon));
   ```

### Type / interface deltas
None — `dock_icon: bool` already exists (`main.rs:119`, default `false` ~`:144`). This fix only
adds readers/side-effects.

### Test checklist

Cloud-runnable: none (Rust can't compile/run in the cloud env, per project conventions).

On-Mac (author-verified):
- [ ] `cargo build` / `npm run widget` compiles.
- [ ] dock_icon OFF (default): launches with NO Dock icon, menu-bar only (today's behaviour).
- [ ] Toggle dock_icon ON in Settings → Dock icon appears immediately, no restart.
- [ ] Toggle OFF → Dock icon disappears immediately.
- [ ] Launch with dock_icon already ON (persisted) → Dock icon shows on startup.
- [ ] With dock_icon ON: open Settings, close it → Dock icon PERSISTS (does not revert to
  Accessory). With dock_icon OFF: open+close Settings → stays Accessory (no stray Dock icon).
- [ ] **Overlay injection under `Regular`** — the critical interaction: with the Dock icon
  shown, trigger the overlay while typing in another app, dictate, and confirm the corrected
  text still lands in the other app's focused field and the overlay does NOT steal focus
  (panel stays non-key). This is the behaviour that must not regress.
- [ ] Under `Regular` the app appears in Cmd-Tab / app switcher — confirm the toggle hotkey,
  PTT, and paste-last still work and the overlay panel still shows over full-screen apps.
- [ ] Reset (`clear_config`) with dock_icon previously ON → Dock icon clears live.

### Risks
- **Activation-policy ↔ overlay interaction (highest risk).** The overlay's non-activating,
  non-key behaviour comes from the `SpikePanel` class (`NonactivatingPanel` style mask +
  `can_become_key_window: false`, lines 899-936), which is ORTHOGONAL to the app's activation
  policy — so `Regular` should not let the panel take focus. But this is unverified on-device;
  `Regular` makes the app eligible to become frontmost/active, and macOS treats a Regular app
  with an active Dock icon differently (app-switcher membership, focus-on-launch). Must be
  Mac-verified that injection still works under `Regular`.
- **Focus dance regression.** Three places now touch the policy (`open_settings_window`
  bump-to-Regular, the close-revert, and the new toggle guard). They must stay consistent — the
  close-revert reads config so it can't fight the toggle. Verify open→close→toggle sequences in
  any order leave the policy matching `dock_icon`.
- **Regular app with no visible window.** If Settings is hidden and the overlay is a panel,
  a `Regular` app may have a Dock icon but "no windows" — confirm clicking the Dock icon / app
  behaves acceptably (ideally opens Settings or is a no-op; must not crash or grab focus from
  the target app).
- **Scope option.** If honouring `Regular` cleanly proves to break the overlay on-device, the
  audit's fallback (F2) is to remove the toggle from the UI rather than ship a dead control —
  keep that as the escape hatch.

---

## Open questions for reviewer

1. **Correction threading mechanism.** Plan uses per-request `CorrectionContext.model` +
   a 4th `format(…, model)` param (mirrors STT's `cfg.model`, minimal diff, no registry
   change). The audit floated an alternative: a constructor arg via
   `getCorrectionProvider(id, { model })`. The per-request approach is chosen because it keeps
   resolution logic identical across `correct`/`format` and avoids changing the registry
   signature and the fallback-provider construction at `server.ts:230`. OK to proceed, or
   prefer the ctor approach?
2. **OpenAI STT: one field, two env vars.** A single `sttModel` overrides both streaming
   (`OPENAI_STT_MODEL`, default `gpt-live-transcribe`) and batch (`OPENAI_BATCH_MODEL`, default
   `gpt-transcribe`). A user entering a streaming-only name could 400 the batch. Options:
   (a) accept it (document that the field must be a name valid for both), (b) only override the
   batch model and leave streaming on its default, (c) add a second UI field later. Recommend
   (a) for Phase 7 with a UI hint; confirm.
3. **PyAI correction: send or suppress the model?** Plan has the PyAI adapter SEND the resolved
   model in the request body (uniform threading) even though the server ignores it (F4). Prefer
   that, or force `gpt-5.6-sol` on the wire to avoid confusion?
4. **`dock_icon` escape hatch.** If on-device testing shows `Regular` breaks overlay injection,
   is removing the toggle from the UI (audit F2 fallback) an acceptable Phase-7 outcome, or must
   the toggle ship working?
5. **Empty-string guard placement.** Plan enforces the "empty ≠ override" rule at BOTH
   `server.ts` (→ undefined) and each adapter (trim check). Belt-and-suspenders is intentional
   so adapter unit tests hold when called directly with `model: ""`. Acceptable duplication?
