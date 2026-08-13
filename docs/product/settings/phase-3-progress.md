# Settings — Phase 3 (Wave 3 — "M5 features") Implementation Progress

**Owner:** Mayank Banga · Saaslabs
**Date:** 13 Aug 2026
**Scope:** items 3.1–3.5 of `phase-3-plan.md`, implementing the reviewer's BINDING
corrections in `phase-3-review.md`. Author-only for Rust (`src-tauri` can't compile in
the cloud); TS/core is built + tested here.

---

## Summary per item

### 3.1 Microphone device picker
- `AppConfig.mic_device_id` (`""` = system default) added to Rust struct + Default + TS
  mirror (`micDeviceId`). Flows through the existing `get_config`/`set_config` (no new command).
- `settings.html` mic row is now `<select id="micDevice">` (first option `value=""` System
  Default) with a `<p class="hint" id="micHint">`; `disabled` + `Not in use` tag removed.
- `settings.ts` `initMicDevice()`: `enumerateDevices()` → `audioinput` only, rebuilds
  options with `d.label || "Microphone N"`, shows the permission hint when any label is
  blank, persists on change, refreshes on `ondevicechange`. Enumerate-once + `syncMicSelection()`
  on `config-changed` to avoid flicker.
- `apps/widget/src/main.ts` `startLive()` — the SOLE capture site — reads `micDeviceId`
  from `get_config` and adds `deviceId: { ideal: micId }` (only when non-empty). **`ideal`,
  not `exact`**, so a removed device falls back to system default (no `OverconstrainedError`).

### 3.2 Auto-detect language
- `AppConfig.auto_detect_language` (default `false`) added Rust + TS mirror; core
  `AppSettings.autoDetectLanguage?` + `DEFAULT_SETTINGS` (false).
- `STTSessionConfig.detectLanguage?` added. **Deepgram**: sets `detect_language=true` and
  drops `language`. **OpenAI**: omits the `language` key in `transcription_session.update`
  when detecting. **PyAI**: ignored (English-only; commented).
- Capability guard relaxed in BOTH core `settings.ts` and the widget mirror: for non-PyAI
  vendors auto-detect relaxes the fixed-language guard; for PyAI the English-only warning
  **still fires** with an added "Auto-detect doesn't apply" note (never silenced).
- Settings toggle `#autoDetect`: greyed + disabled when STT=pyai (with hint), re-evaluated
  on STT change.
- Runtime thread: overlay start frame carries `autoDetect: cfg.autoDetectLanguage`; backend
  parses `msg.autoDetect === true` and passes `detectLanguage` into `startSession`. Core
  `Pipeline` forwards `sttConfig.detectLanguage`.

### 3.3 Telemetry (HARD GATE — transport PARKED)
- New `packages/core/src/telemetry/telemetry.ts`: `ALLOWED_FIELDS` allow-list,
  `TelemetryEvent` type, `TelemetrySink` interface, `NoopSink` (default), `sanitize()`
  (allow-list copy — drops `transcript`/`text`/`audio`/`apiKey`/anything not whitelisted),
  and `Telemetry` whose `emit()` returns before any sink/sanitize/allocation when disabled.
- **NO `fetch`/beacon anywhere.** The injectable `sink` constructor arg is the seam; a clear
  `TODO(telemetry-transport, settings-plan §10.1)` marks the parked endpoint.
- `AppConfig.telemetry` (default false) Rust + TS mirror; Settings toggle `#telemetry` with
  an honest "what we collect" note (metadata only, never transcript/audio).
- Backend constructs one `Telemetry` per connection (`enabled: msg.telemetry === true`,
  default `NoopSink`) and emits `session_start` / `session_finalize` / `error` events with
  **counts (`rawLen`/`cleanLen`) and provider ids only — never text**.

### 3.4 Vocabulary
- New `vocabulary.json` store (key `terms` → `string[]`) with Rust CRUD `vocab_list` /
  `vocab_add` (rejects blanks, case-insensitive de-dupe) / `vocab_delete`, registered in
  `generate_handler!`. Separate file, NOT `AppConfig` → Reset leaves it intact.
- **Injected into the FORMAT prompt** (per review — correction forbids re-wording so it'd be
  a no-op there): `formatMessage(text, language?, vocabulary?)` appends a "Known terms" line;
  threaded through all three adapters' `format()` and the core `Pipeline`/backend. Carried
  into the correction ctx too, as a harmless extra.
- **Deepgram keyword-boost** branches on the resolved `DEEPGRAM_STT_MODEL`: `keywords` for
  nova-2 (default), `keyterm` for nova-3 — a mismatch would be a silent no-op. OpenAI/PyAI
  ignore `keywords` (prompt-only). `STTSessionConfig.keywords?` added.
- Settings pane replaced empty state with an add-input + deletable list (`initVocabulary`).
  Terms ride the WS start frame (fetched in `connect()` live-mode in parallel with `get_config`).

### 3.5 Snippets
- New `snippets.json` store (key `snippets` → `{trigger, expansion}[]`) with Rust CRUD
  `snip_list` / `snip_add` (rejects empty trigger/expansion) / `snip_delete`, registered in
  `generate_handler!`. Separate file, not `AppConfig`.
- New `packages/core/src/snippets.ts` `expandSnippets(text, snippets)`: deterministic,
  case-insensitive, whole-phrase (Unicode word-boundary lookaround), longest-trigger-first,
  regex-escaped (literal triggers). Pure function.
- Core `Pipeline.finalizeOnce`: ALL THREE `onFormatted` sites (LLM-formatted, unformatted-clean,
  and the **catch → raw** fallback) route through one `emitFormatted()` helper that applies
  `expandSnippets` once — so snippets fire on the error path too. Backend `finalize` applies
  `expandSnippets(finalText, snippets)` before `send({type:"formatted"})`.
- Settings pane replaced empty state with a trigger+expansion add row + deletable list
  (`initSnippets`). Snippets ride the WS start frame alongside vocabulary.

---

## Files changed

**Core (`packages/core/src`)**
- `providers/types.ts` — `STTSessionConfig.detectLanguage?`, `.keywords?`.
- `providers/deepgram.stt.ts` — detect_language branch + keyword-boost (nova-2 `keywords` /
  nova-3 `keyterm`).
- `providers/openai.stt.ts` — thread `detectLanguage` (omit `language` on detect).
- `providers/pyai.stt.ts` — comment: ignores detect/keywords (English-only).
- `correction/types.ts` — `CorrectionContext.vocabulary?`; `format?(text, language?, vocabulary?)`.
- `correction/prompt.ts` — `userMessage(..., vocabulary?)`, `formatMessage(..., vocabulary?)`, `vocabularyNote()`.
- `correction/pyai.ts` / `openai.ts` / `anthropic.ts` — thread `vocabulary` into correct + format.
- `settings.ts` — `AppSettings.autoDetectLanguage?` + default; capability guard relaxation.
- `pipeline.ts` — `PipelineOptions.vocabulary?`/`.snippets?`, `RunOptions.sttConfig.detectLanguage`/`.keywords`,
  `emitFormatted()` helper, vocab into format.
- `snippets.ts` (new), `telemetry/telemetry.ts` (new), `index.ts` (barrels).

**Backend (`apps/backend/src/server.ts`)** — parse `autoDetect`/`vocabulary`/`snippets`/`telemetry`
on start; connection-scoped state; `detectLanguage`+`keywords` into `startSession`; vocab into
format; snippet expansion on final text; per-connection `Telemetry` + metadata emits.

**Widget (`apps/widget`)**
- `src/main.ts` — `startLive()` mic `deviceId` constraint; `connect()` parallel fetch of
  `vocab_list`/`snip_list` + new start-frame fields.
- `src/settings.ts` — TS `AppConfig` fields; capability mirror; `initMicDevice`/`initAutoDetect`/
  `initTelemetry`/`initVocabulary`/`initSnippets`; refreshControls + DOMContentLoaded wiring.
- `settings.html` — mic/auto-detect/telemetry rows un-gated; vocabulary + snippets panes rebuilt.
- `src/settings.css` — list/control-row styles.
- `src-tauri/src/main.rs` — `AppConfig` fields + Default; `vocabulary.json`/`snippets.json`
  stores + `vocab_*`/`snip_*` commands; handler registration. **(Author-only — not compiled.)**

---

## Config / store schema added

| Field (Rust snake / TS camel) | Type | Default | Where |
|---|---|---|---|
| `mic_device_id` / `micDeviceId` | String | `""` | `AppConfig` (settings.json) |
| `auto_detect_language` / `autoDetectLanguage` | bool | `false` | `AppConfig` + core `AppSettings` |
| `telemetry` / `telemetry` | bool | `false` | `AppConfig` |

Separate stores (NOT `AppConfig`; survive Reset):
- `vocabulary.json` — `{ "terms": string[] }` (default empty).
- `snippets.json` — `{ "snippets": { trigger, expansion }[] }` (default empty).

Type additions: `STTSessionConfig.detectLanguage?`, `.keywords?`; `CorrectionContext.vocabulary?`;
`format?(…, vocabulary?)`; `PipelineOptions.vocabulary?`/`.snippets?`; telemetry `ALLOWED_FIELDS`/`TelemetryEvent`.

---

## Test results — Cloud (executed)

- [x] `npm test` — **106 passed (16 files)** — was 83/13. **+23 tests, +3 files.**
  - 3.2 detect: `deepgram.stt.integration.test.ts` (+2), `openai.stt.integration.test.ts` (+2) — reused harnesses.
  - 3.2 capability: `settings.test.ts` (+2).
  - 3.3 telemetry: `telemetry/telemetry.test.ts` (+4 — no-op-when-disabled, whitelist-only-when-enabled, sanitize-drops, default-NoopSink).
  - 3.4 vocabulary: `correction/vocabulary.test.ts` (+6 — format-prompt-has-terms, userMessage parity, byte-identical-when-empty, deepgram nova-2 `keywords`, nova-3 `keyterm`, none-given).
  - 3.5 snippets: `snippets.test.ts` (+7 — expansion, case-insensitive/whole-phrase, longest-wins, identity, literal-regex, blank-trigger, Pipeline-applies).
- [x] `apps/widget` `npx tsc --noEmit` — pass.
- [x] `apps/backend` `npx tsc --noEmit` — pass.
- [x] `packages/core` `npx tsc --noEmit` — pass (bonus).

Real summary line: `Test Files  16 passed (16)` · `Tests  106 passed (106)`.

---

## On-Mac checklist (UNCHECKED — Rust not compiled in cloud)

**3.1 Mic picker**
- [ ] `cargo check` compiles with `mic_device_id` + Default.
- [ ] ≥2 devices listed by name; selecting a non-default persists (reopen shows it) and capture uses it.
- [ ] Before granting mic permission, labels blank → "Microphone 1/2" + hint show; after grant + reopen, real names.
- [ ] Unplug selected device → falls back to system default (no `OverconstrainedError` / "No microphone" banner).
- [ ] Reset returns `mic_device_id` to `""` (System Default) live.

**3.2 Auto-detect**
- [ ] `cargo check` compiles with `auto_detect_language`.
- [ ] STT=Deepgram/OpenAI + toggle on → non-English phrase transcribes with no fixed-language mismatch.
- [ ] STT=PyAI → toggle greyed/disabled with English-only hint; switching to Deepgram re-enables it live.
- [ ] Persists across restart; Reset → off.

**3.3 Telemetry**
- [ ] `cargo check` compiles with `telemetry`.
- [ ] OFF by default on fresh config / after Reset; flipping persists.
- [ ] With telemetry ON, grep backend logs during dictation → NO transcript/audio content (counts/latencies only).
- [ ] (Transport parked) confirm no network egress — NoopSink still wired.

**3.4 Vocabulary**
- [ ] `cargo check` compiles with `vocabulary.json` store + `vocab_*` in `generate_handler!`.
- [ ] Add a term → persists across restart (`vocabulary.json` in app_config_dir); delete works; list replaces empty state.
- [ ] Dictate a fixture with a known unusual term → format output preserves/spells it.
- [ ] (Deepgram) boosted keyword measurably improves raw STT vs. without.
- [ ] Reset leaves vocabulary intact.

**3.5 Snippets**
- [ ] `cargo check` compiles with `snippets.json` store + `snip_*` commands.
- [ ] Add a snippet → persists across restart; delete works; list replaces empty state.
- [ ] Dictate the trigger phrase → expansion inserted deterministically.
- [ ] Reset leaves snippets intact.

---

## Deviations
- Backend `correct()` now also receives `{ language: langTag, vocabulary }` (previously no
  ctx). Vocabulary is a harmless extra on the correction turn (the effective lever is FORMAT
  per review); passing `language` also fixes a latent gap where the backend never told the
  correction pass the language. No behavioural regression (English default unchanged).
- 3.1 has no core vitest (webview + scalar config only, per review Q8); its cloud gate is
  widget `tsc` + the HTML edits. Verified by typecheck.

## Parked items
- **Telemetry network transport — PARKED (settings-plan §10.1).** No `fetch`/beacon exists.
  Default sink is `NoopSink`; the injectable `sink` arg + `TODO(telemetry-transport)` comment
  in `telemetry.ts` are the seam for a future real sink. The toggle ships on-able but inert.
- **Auto-detect on the batch path** — `transcribeBatch` still has no detect/language arg;
  the authoritative widget final already auto-detects by vendor default (no `language` sent),
  so only the streaming preview is affected. Explicit batch detect is a follow-up (review Q5).
