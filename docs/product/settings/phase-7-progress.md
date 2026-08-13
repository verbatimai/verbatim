# Phase 7 — Audit-fix implementation progress

_Implementation of the 3 audit fixes from `docs/product/settings/audit/`, per
`docs/product/settings/phase-7-plan.md` with the reviewer's open-question resolutions baked
in. Authored 2026-08-13. TS fixes are cloud-verified (vitest + tsc); the Rust dock_icon fix
is author-only (can't compile in the cloud env) and is UNCHECKED for Mac verification._

## Summary per fix

### Fix 1 — [HIGH] `sttModel` + `correctionModel` wired end-to-end (TS)
A model chosen in Settings now reaches the real vendor request. The value rides the WS
`start` frame exactly like `language`/`autoDetect`/`vocabulary`, is remembered in
connection-scoped `let`s in `server.ts`, and is threaded into `startSession`,
`transcribeBatch`, `correct`, and `format`. Each adapter resolves
`(passed && passed.trim()) ? passed : (env ?? default)` so an empty/whitespace value never
overrides. Belt-and-suspenders empty-string guard: `server.ts` converts an empty start-frame
value to `undefined` AND each adapter re-checks (so adapter-level unit tests hold when called
directly with `model: ""`).

Per-vendor behaviour:
- **Deepgram** — `cfg.model` on BOTH streaming and batch (nova-x valid on both).
- **OpenAI STT** — `cfg.model` on STREAMING only (`OPENAI_STT_MODEL`). Batch KEEPS its own
  `OPENAI_BATCH_MODEL ?? "gpt-transcribe"` and deliberately ignores `cfg.model` — a
  streaming-only Realtime model name would 400 the Whisper-family batch endpoint. A code
  comment in `openai.stt.ts::transcribeBatch` documents the split.
- **PyAI STT** — ignored (single model; URL/body always `pyai-hear`). Documented no-op.
- **OpenAI / Anthropic correction** — honour the per-request model (meaningful override).
- **PyAI correction** — SENDS the resolved model in the request body for uniform threading,
  but the PyAI server ignores it (findings F4). Documented no-op, not a regression.

### Fix 2 — [MED] Deepgram vocabulary keyword-boost on the batch/finalize path (TS)
`server.ts` now passes `keywords: vocabulary` into the `transcribeBatch` call, and
`deepgram.stt.ts::transcribeBatch` applies the same model-branched boost as streaming
(`keyterm` on nova-3, `keywords` otherwise). Since the inserted text is the batch output,
custom terms are now boosted on the authoritative path, not just the live preview. OpenAI/PyAI
have no STT-side boost param and are unaffected.

### Fix 3 — [MED] `dock_icon` activation-policy toggle (Rust — author-only, UNVERIFIED on Mac)
Added `desired_activation_policy(dock_icon) -> Regular | Accessory` near
`configure_non_activating_panel`. Wired it into four places:
1. **Startup honour** — `configure_non_activating_panel` reads the configured `dock_icon`
   instead of hard-coding `Accessory`.
2. **Live toggle** — `set_config` applies the policy when `dock_icon` flips (no restart).
3. **Settings-close revert** — the `CloseRequested` handler reverts to the CONFIGURED policy
   (not a hard `Accessory`), so with the Dock icon on, open+close Settings no longer hides it.
4. **Reset** — `clear_config` re-applies the default policy so a Reset that clears a
   previously-on dock icon takes effect live.

The "remove the toggle from the UI" idea (audit F2 fallback) is kept ONLY as a documented
escape hatch if on-device testing shows `Regular` breaks overlay injection — NOT implemented.

## Files changed
- `apps/widget/src/main.ts` — add `sttModel`/`correctionModel` to the `start` frame.
- `apps/backend/src/server.ts` — connection-scoped `sttModel`/`corrModel` lets; empty-string
  parse; thread into `startSession` / `transcribeBatch` (+ `keywords: vocabulary` for Fix 2) /
  `correct` / `format`.
- `packages/core/src/providers/types.ts` — `STTSessionConfig.model?`; `transcribeBatch` cfg
  gains `model?` + `keywords?`.
- `packages/core/src/providers/deepgram.stt.ts` — prefer-cfg model on streaming + batch; Fix 2
  keyword boost on batch.
- `packages/core/src/providers/openai.stt.ts` — prefer-cfg model on streaming; batch keeps its
  own resolution with an explanatory comment.
- `packages/core/src/providers/pyai.stt.ts` — documented `cfg.model` no-op (streaming + batch).
- `packages/core/src/correction/types.ts` — `CorrectionContext.model?`; `format` 4th param `model?`.
- `packages/core/src/correction/{pyai,openai,anthropic}.ts` — prefer-ctx/param model in
  `correct` + `format`.
- `packages/core/src/correction/mock.ts` — unchanged (trailing optional params are
  source-compatible; verified it still compiles).
- `apps/widget/src-tauri/src/main.rs` — `desired_activation_policy` helper + 4 call sites (Fix 3).
- Tests: `deepgram.stt.integration.test.ts`, `openai.stt.integration.test.ts`,
  `pyai.integration.test.ts`, `correction/openai.integration.test.ts`,
  `correction/anthropic.integration.test.ts` (+29 cases).

## Interface deltas (all additive/optional — no breaking changes)
- `STTSessionConfig` gains `model?: string`.
- `transcribeBatch` cfg gains `model?: string` and `keywords?: string[]`.
- `CorrectionContext` gains `model?: string`.
- `CorrectionProvider.format` gains a 4th optional param `model?: string`.

## Cloud test results (executed)
- [x] `npm test` — **137 passed (16 files)**. Baseline was 108 → **+29** new cases
  (deepgram: 5 streaming + 6 batch; openai stt: 3 streaming + 2 batch; pyai: 2 stt + 3
  correction; openai correction: 4; anthropic correction: 4).
- [x] `cd apps/widget && npx tsc --noEmit` — clean (exit 0).
- [x] `cd apps/backend && npx tsc --noEmit` — clean (exit 0).
- [x] `cd packages/core && npx tsc --noEmit` — clean (exit 0).
- [ ] Rust (`src-tauri`) — NOT compilable in the cloud env (project convention). See below.

## On-Mac checklist (UNCHECKED — must be run on the Mac)

### Fix 1 (model overrides)
- [ ] `cargo build` / `npm run widget` compiles with the `main.ts` start-frame change.
- [ ] Pick a non-default **Deepgram** model (e.g. `nova-3`) in Settings, dictate; confirm the
  request uses it (backend `[hear]` debug log / vendor dashboard), on BOTH streaming and batch.
- [ ] Pick a non-default **OpenAI STT** streaming model; confirm streaming uses it and batch
  still uses `gpt-transcribe` (per-vendor takes effect).
- [ ] Pick a non-default **OpenAI / Anthropic correction** model; confirm the request body model.
- [ ] **PyAI end-to-end with an empty model** still works (default `pyai-hear` / `gpt-5.6-sol`)
  — no regression to the priority provider.
- [ ] Switching the model in Settings takes effect on the NEXT dictation with NO app restart.

### Fix 2 (Deepgram batch keyword boost)
- [ ] Add a custom term, dictate a sentence containing it with Deepgram, confirm the INSERTED
  (final, batch) text recognizes it — not just the live preview.

### Fix 3 (dock_icon — Rust, UNVERIFIED)
- [ ] `cargo build` / `npm run widget` compiles.
- [ ] dock_icon OFF (default): launches with NO Dock icon, menu-bar only.
- [ ] Toggle ON in Settings → Dock icon appears immediately, no restart; toggle OFF → disappears.
- [ ] Launch with dock_icon already ON (persisted) → Dock icon shows on startup.
- [ ] With dock_icon ON: open Settings, close it → Dock icon PERSISTS (does not revert to
  Accessory). With dock_icon OFF: open+close Settings → stays Accessory (no stray Dock icon).
- [ ] **Overlay injection under `Regular` (HIGHEST RISK)** — with the Dock icon shown, trigger
  the overlay while typing in another app, dictate, and confirm the corrected text lands in the
  other app's focused field and the overlay does NOT steal focus (panel stays non-key). This is
  the behaviour that must not regress.
- [ ] Under `Regular` the app appears in Cmd-Tab; confirm toggle hotkey, PTT, paste-last still
  work and the overlay still shows over full-screen apps.
- [ ] Reset (`clear_config`) with dock_icon previously ON → Dock icon clears live.

## Deviations / decisions
- **OpenAI batch-model split** (open-question #2, resolution baked in): `cfg.model` overrides
  the STREAMING model only; batch keeps `OPENAI_BATCH_MODEL ?? "gpt-transcribe"`. A code
  comment in `openai.stt.ts` explains why (avoids a streaming-only name 400ing the batch
  endpoint). Verified by the two new "ignores cfg.model on batch" tests.
- **PyAI correction no-op** (open-question #3): the adapter sends the resolved model on the wire
  (uniform threading); the PyAI server ignores it (F4). Verified the wire body carries it.
- **Plan line-anchor fix:** the plan wrote `read_config(&app.handle())` for the startup honour;
  `App::handle()` already returns `&AppHandle`, so the correct call is `read_config(app.handle())`
  (matches the existing pattern at the `apply_autostart(app.handle(), ...)` line). Adjusted.
- **dock_icon toggle NOT removed** — the F2 fallback stays a documented escape hatch only.

## Risks
- **`server.ts` has no backend unit test** — the start-frame parse + threading is verified only
  on-Mac. Edits mirror the existing `vocabulary`/`autoDetect` parse to minimise risk.
- **Fix 3 is unverified on-device.** The overlay's non-activating/non-key behaviour comes from
  the `SpikePanel` class (orthogonal to activation policy), so `Regular` SHOULD keep injection
  working — but this must be Mac-verified. If it breaks, fall back to removing the UI toggle (F2).
- **Single model field, two OpenAI STT env vars** — one `sttModel` overrides streaming only now;
  batch is insulated. Stale-model-on-provider-switch remains a pre-existing UI concern (out of scope).
