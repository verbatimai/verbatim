# Settings — Phase 3 (Wave 3 — "M5 features") Implementation Plan

**Owner:** Mayank Banga · Saaslabs
**Date:** 13 Aug 2026
**Scope:** items 3.1–3.5 of `settings-plan.md` §4 ("Wave 3 — M5 features"):
microphone device picker (3.1), auto-detect language (3.2), anonymous opt-in
telemetry (3.3), vocabulary (3.4), snippets (3.5). **Planner output only — no code
is written here.**

**Reads first:** `settings-plan.md` §0 (guardrails), §1 (config table), §4, §10
(risks); and `phase-1-progress.md` / `phase-2-progress.md` for the landed state.
Phase 1 added `launch_at_login`, `debug`, `theme`, `key_storage` + `secrets.rs`;
Phase 2 added `correct`, `format`, `paste_last_hotkey` + `PipelineOptions` + the WS
`start`-frame toggle thread. All Rust is authored-but-uncompiled in the cloud.

---

## 0. Cross-cutting facts established by reading the current code

Cited once here so each item can stay short. Line numbers are the current copy.

- **Mic capture lives in the OVERLAY webview `apps/widget/src/main.ts`, not
  `app.ts`.** `startLive()` calls
  `navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })`
  at **main.ts:371**. `app.ts` is the History/Settings app shell and does **no**
  capture (grep confirms: the only `getUserMedia` sites are `apps/widget/src/main.ts:371`
  and the reference web app `apps/web/src/main.ts:124`). The plan doc §3.1 says
  "app.ts" — that is stale; the edit is in **main.ts**. `startLive()` runs BEFORE
  `connect("live")` (main.ts:394), and `connect()` is the only place the overlay
  reads config today (`await invoke("get_config")`, main.ts:320) — so the device id
  must be fetched inside `startLive()` (or cached from a `config-changed` listener),
  not from the `connect()` cfg.

- **The Settings mic control is a hard-coded disabled `<select>`** with no `id`,
  one `<option>System Default</option>`, and a `Not in use` tag
  (**settings.html:282–290**). `settings.ts` does not reference it at all.

- **STT language plumbing.** `STTSessionConfig = { apiKey; language? }`
  (**providers/types.ts:38–41**). The pipeline passes `{ apiKey, language }` at
  **pipeline.ts:233**; the backend passes `{ apiKey, language }` at
  **server.ts:204**. Per-adapter language use:
  - **Deepgram** — `if (cfg.language) q.set("language", cfg.language)`
    (**deepgram.stt.ts:47**) on a `URLSearchParams` (35–46). Deepgram's streaming
    API accepts `detect_language=true` (nova-family) → auto-detect = set that param
    and DROP `language`.
  - **OpenAI** — language goes into `input_audio_transcription: { model, ...(language ? { language } : {}) }`
    (**openai.stt.ts:85**). OpenAI Realtime auto-detects when `language` is omitted →
    auto-detect = just don't send it.
  - **PyAI** — `startSession` ignores `cfg.language` entirely (**pyai.stt.ts:21–31**);
    Hear is English-only. Auto-detect is a no-op for PyAI and must stay guarded.

- **Capability guard (core + widget mirror).** Core `capabilityErrors`
  (**settings.ts:65–101**) uses `isEnglish` (54–57) to raise the PyAI-English-only
  error (94–98). The widget re-implements this in `settings.ts`
  `capabilityErrors()` (**settings.ts:89–101**, guard at 97–99) because core can't
  be imported into the Vite app. **Both** must learn the auto-detect relaxation.

- **Correction prompt injection point.** `userMessage(raw, priorContext?, language?)`
  (**prompt.ts:105–108**) builds the correction user turn; `CorrectionContext =
  { priorContext?; language? }` (**types.ts:31–36**). All three real adapters pass
  `userMessage(raw, ctx?.priorContext, ctx?.language)` — **pyai.ts:54**,
  **openai.ts:93**, **anthropic.ts:60**. `MockCorrection.correct` ignores ctx
  (**mock.ts:39**). The core `Pipeline` calls `this.correction.correct(raw, { language })`
  (**pipeline.ts:256**); the backend calls `correction.correct(raw)` with **no** ctx
  (**server.ts:127**). This is the vocabulary (3.4) injection seam.

- **Two finalize implementations, edit BOTH (same rule as 2.2/2.3).** Core
  `Pipeline.startStreaming`'s `finalizeOnce` (**pipeline.ts:245–274**) is what
  vitest exercises; the widget actually runs the backend `finalize`
  (**server.ts:102–160**). The snippet expander (3.5) hooks after the formatted text
  is produced in both: after `onFormatted` in core, after `send(ws, {formatted})` in
  the backend.

- **Store & command patterns to copy.** The config store uses
  `STORE_FILE="settings.json"` + `CONFIG_KEY="config"` with `read_config`/`write_config`
  helpers over `app.store(STORE_FILE)` (**main.rs:148–168**). The `secrets.rs`
  adapter (Phase 1) is the model for a **separate JSON file with its own CRUD**
  (`secrets_path` → `app_config_dir/secrets.json`, atomic temp+rename, **secrets.rs:27–124**).
  Vocabulary/Snippets are **list data** → their own `tauri-plugin-store` files
  (`vocabulary.json` / `snippets.json`), NOT `AppConfig` fields (guardrail §1). New
  commands must be added to the `generate_handler!` list (**main.rs:1022–1045**).

- **Backend never sees the config store directly.** It receives selection/flags on
  the WS `start` frame (parsed at **server.ts:171–182**: `sttProvider`,
  `correctionProvider`, `language`, `correct`, `format`). The overlay `main.ts`
  builds that frame (**main.ts:328–336**). Any new runtime flag/data that the
  backend needs (auto-detect for 3.2; vocabulary terms + snippets are handled
  differently, see each item) rides the same frame.

---

## 1. Config schema delta (one place)

Three new **scalar** `AppConfig` fields. Add each to the Rust struct
(**main.rs:108–124**), the `Default` impl (**main.rs:126–146**) — every field is
already under `#[serde(rename_all="camelCase", default)]` so old stores still load —
and the TS mirror type in `settings.ts` (**settings.ts:9–25**).

| Rust (snake) / TS (camel) | Type | Default | Item | UI |
|---|---|---|---|---|
| `mic_device_id` / `micDeviceId` | String | `""` (= system default) | 3.1 | Dictation → Microphone `<select>` |
| `auto_detect_language` / `autoDetectLanguage` | bool | `false` | 3.2 | Dictation → Auto-detect toggle |
| `telemetry` / `telemetry` | bool | `false` | 3.3 | Advanced → Anonymous telemetry toggle |

**Vocabulary (3.4) and Snippets (3.5) are LIST data — NOT `AppConfig` fields.** They
get their own store files (`vocabulary.json`, `snippets.json`) with dedicated Rust
CRUD commands, per guardrail §1.

---

## 3.1 Microphone device picker

**Goal.** Populate the disabled Dictation `<select>` with real input devices, persist
the choice as `mic_device_id` (`""` = system default), and make `startLive()` capture
from the chosen device. Handle blank device labels when mic permission has not yet
been granted.

**Files & exact edits.**
- **main.rs** — add `mic_device_id: String` to `AppConfig` (struct 108–124 + Default
  126–146, default `String::new()`). No command needed — it flows through the existing
  `get_config`/`set_config`.
- **settings.html:282–290** — give the mic row a real control: `<select id="micDevice">`,
  remove `disabled`, drop the `<span class="tag off">Not in use</span>`. Keep a first
  `<option value="">System Default</option>`. Optionally add a `<p class="hint"
  id="micHint">` for the "grant mic permission to see device names" state.
- **settings.ts** — add `micDeviceEl = $<HTMLSelectElement>("micDevice")`,
  `micHintEl` (near 44–69). New `initMicDevice()`:
  - `const devices = await navigator.mediaDevices.enumerateDevices()`, filter
    `d.kind === "audioinput"`.
  - Rebuild `<option>`s: always keep `("", "System Default")`; then one per device
    using `d.label || \`Microphone ${i+1}\`` (blank labels ⇒ permission not yet
    granted — show the fallback name + set `micHintEl` text).
  - `micDeviceEl.value = config.micDeviceId ?? ""` (if the saved id is gone, the
    assignment silently no-ops and the select falls back to `""`/System Default).
  - `micDeviceEl.onchange = () => void patchConfig({ micDeviceId: micDeviceEl.value })`.
  - Optionally `navigator.mediaDevices.ondevicechange = () => initMicDevice()` to
    refresh on hot-plug.
  - Call `initMicDevice()` from `DOMContentLoaded` (571–591) and from
    `refreshControls()` (536–548) — value re-sync only; avoid re-enumerating on every
    `config-changed` to prevent flicker (guard: enumerate once, then only re-select).
- **apps/widget/src/main.ts** `startLive()` (**368–408**) — before the
  `getUserMedia` call at **371**, resolve the device id
  (`const micId = (await invoke("get_config").catch(() => ({} as any))).micDeviceId ?? ""`)
  and build constraints:
  `audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, ...(micId ? { deviceId: { ideal: micId } } : {}) }`.
  Use **`ideal`, not `exact`** — a removed/renamed device then falls back to the
  system default instead of throwing `OverconstrainedError` (which main.ts:379 would
  surface as "No microphone found").

**Config/store schema delta.** `mic_device_id: String = ""` on `AppConfig` (see §1).
No new store file.

**Test checklist.**
_Cloud-runnable (typecheck only — no vitest; this is webview/DOM + Rust):_
- [ ] `apps/widget` `npx tsc --noEmit` passes with `micDeviceEl`, `initMicDevice`,
      the `enumerateDevices` typing, and the `micDeviceId` field on the TS `AppConfig`.
- [ ] Static: `settings.html` has exactly one `id="micDevice"`; the `Not in use` tag
      and the `disabled` attribute are gone from the mic row.

_On-Mac:_
- [ ] `cargo check` compiles with the new `mic_device_id` field + Default.
- [ ] With ≥2 input devices, the picker lists them by name; selecting a non-default
      device persists (reopen shows it) and capture uses it (speak into that device).
- [ ] Before granting mic permission, labels are blank → the fallback names
      ("Microphone 1/2") show and the hint appears; after granting + reopening,
      real names appear.
- [ ] Unplug the selected device, dictate → falls back to system default (no
      `OverconstrainedError`, no "No microphone found" banner).
- [ ] Reset (1.3) returns `mic_device_id` to `""` (System Default) live.

**Risks/notes.** `enumerateDevices` returns blank `label` until `getUserMedia` has
been granted once in the WKWebView — that's why the fallback names + hint are
required, not optional. `deviceId`s are stable per-app but can rotate across OS
reinstalls; the `ideal` constraint keeps that graceful. This item has **no core
vitest** — it is entirely webview + a scalar config field.

---

## 3.2 Auto-detect language

**Goal.** Let Deepgram/OpenAI auto-detect the spoken language. Add
`auto_detect_language` (default false). Core STT adapters accept a detect flag and
translate it per vendor; the capability layer (core + widget mirror) **relaxes the
fixed-language guard when auto-detect is on but keeps the PyAI-English-only warning**;
the Settings toggle is disabled/greyed when STT = pyai.

**Files & exact edits.**
- **packages/core/src/providers/types.ts:38–41** — extend `STTSessionConfig` with
  `detectLanguage?: boolean`.
- **deepgram.stt.ts:35–52** `startSession` — when `cfg.detectLanguage`, set
  `q.set("detect_language", "true")` and do **not** set `language` (skip line 47);
  otherwise keep today's `if (cfg.language) q.set("language", cfg.language)`.
- **openai.stt.ts:76–89** `OpenAiSession` ctor — thread `detectLanguage` in (add a
  param alongside `language`, passed from `startSession` at **44**); in the
  `transcription_session.update` (81–88) omit the `language` key when detecting
  (auto-detect = model default). `input_audio_transcription: { model, ...(detect ? {} : language ? { language } : {}) }`.
- **pyai.stt.ts:21–31** — ignore `detectLanguage` (English-only); optionally add a
  one-line comment. No wire change.
- **packages/core/src/settings.ts** — add `autoDetectLanguage?: boolean` to
  `AppSettings` (**19–26**) + `DEFAULT_SETTINGS` (**28–32**, default `false`). In
  `capabilityErrors` (**65–101**), change the PyAI guard (94–98) so that:
  - if `sttProvider === "pyai"`: the PyAI-English-only error still fires **and** — if
    `autoDetectLanguage` is on — add a distinct note that PyAI ignores auto-detect
    (English only). i.e. auto-detect never SILENCES the PyAI warning.
  - if `sttProvider !== "pyai"` **and** `autoDetectLanguage`: skip the fixed-language
    mismatch entirely (there is no fixed-language error for non-PyAI today, so this is
    mainly forward-safety + a shared helper the widget mirrors).
- **apps/widget/src/settings.ts** — mirror the same relaxation in the widget
  `capabilityErrors()` (**89–101**); add `autoDetectLanguage?: boolean` to the TS
  `AppConfig` (9–25). New `initAutoDetect()`:
  - `autoDetectEl.checked = !!config.autoDetectLanguage`.
  - **Disable/grey when `config.sttProvider === "pyai"`** (add `.disabled` to the
    `.switch` label + set the checkbox `disabled`), showing the English-only hint.
    Re-evaluate this in `initProviderControls`'s `sttProviderEl.onchange` (231) and in
    `refreshControls`.
  - `autoDetectEl.onchange = () => void patchConfig({ autoDetectLanguage: autoDetectEl.checked })`.
- **settings.html:268–281** — un-gate the Auto-detect row: add
  `<input type="checkbox" id="autoDetect">`, remove the `disabled` on the switch and
  the `Not in use` tag (the greying is now dynamic, driven by settings.ts).
- **Runtime thread (widget path).** For the widget to actually detect, the flag must
  reach the backend: add `autoDetect: cfg.autoDetectLanguage` to the WS `start` frame
  (**main.ts:328–336**); parse `const autoDetect = msg.autoDetect === true` on `start`
  (**server.ts:171–182**) and pass `detectLanguage: autoDetect` into
  `stt.startSession({ apiKey, language, detectLanguage: autoDetect })` (**server.ts:204**).
  Also pass it in the core `Pipeline` if/when a caller sets it — `startStreaming`
  forwards `sttConfig` (pipeline.ts:232–233); add `detectLanguage` to the
  `RunOptions["sttConfig"]` shape (**pipeline.ts:22–26**) and forward it at 233.
- **main.rs** — add `auto_detect_language: bool` to `AppConfig` + Default (default
  `false`). No command; flows through `get_config`/`set_config` and the start frame.

**Config/store schema delta.** `auto_detect_language: bool = false` on `AppConfig`
(§1). Core `AppSettings.autoDetectLanguage?: boolean` default false. No new store.

**Test checklist.**
_Cloud-runnable (core vitest — REUSE the existing mock-ws harnesses; do NOT hand-roll
a new one. Add cases to `deepgram.stt.integration.test.ts` (its `mockDeepgram` already
captures `seen.query`) and `openai.stt.integration.test.ts` (its `mockRealtimeServer`
already captures `seen.config`). These `*.integration.test.ts` files ARE part of the
default `npm test` — they use local `ws` servers on port 0, no vendor endpoint/key —
so they run in the cloud today (13/13 files green). A fresh `detect.test.ts` would only
duplicate that harness.):_
- [ ] `deepgram detectLanguage sets detect_language=true and omits language` — start
      a session against the mock `DEEPGRAM_WS_URL` and assert `seen.query` contains
      `detect_language=true` and NOT `language=` when `detectLanguage: true`; and the
      inverse (`detectLanguage` unset ⇒ `language=fr` present, no `detect_language`).
- [ ] `openai detectLanguage omits the language field in transcription_session.update`
      — assert `seen.config.input_audio_transcription` has no `language` key when
      detecting; has it when not (the mock captures `seen.config` on the update frame).
- [ ] `pyai ignores detectLanguage` — `startSession({ detectLanguage: true })` builds
      the same URL as without it (no throw, English-only unaffected).
- [ ] `capabilityErrors: autoDetect on + non-PyAI STT relaxes the language guard`
      (Deepgram + `fr` + autoDetect ⇒ no language error).
- [ ] `capabilityErrors: autoDetect on + PyAI still warns English-only` (PyAI + `fr` +
      autoDetect ⇒ the PyAI-English error still present).
- [ ] `npm test` stays green (currently 83/83).

_On-Mac:_
- [ ] `cargo check` compiles with the new field.
- [ ] STT = Deepgram/OpenAI, toggle Auto-detect on, speak a non-English phrase → it
      transcribes without a fixed-language mismatch.
- [ ] STT = PyAI → the Auto-detect toggle is greyed/disabled with the English-only
      hint; switching STT to Deepgram re-enables it live.
- [ ] Persists across restart; Reset returns it to off.

**Risks/notes.** Confirm the exact Deepgram param name for the configured model
(`detect_language` on nova-2/nova-3; older models differ) — the adapter reads
`DEEPGRAM_STT_MODEL`. `transcribeBatch` (the authoritative widget final,
deepgram.stt.ts:57 / openai.stt.ts:50) does **not** currently take a language/detect
option; auto-detect on the batch path is a follow-up (batch Whisper/Deepgram
auto-detect by default when no language is given, so the practical gap is small — call
it out for the reviewer). Keep the guard change minimal: **never** let auto-detect
mask the PyAI-English warning (risk §10.5).

---

## 3.3 Anonymous telemetry (opt-in, default OFF, metadata-only, NEVER content) — TRANSPORT **PARKED**

**Goal.** A new `packages/core` telemetry emitter that is a **pure no-op unless
enabled**, emits **only whitelisted metadata fields** (never transcript/audio
content), is gated by a `telemetry` config field (default false) in main.rs, and is
surfaced by a Settings toggle + a one-line "what we collect" note. **The network
sink/endpoint is UNDECIDED (risk §10.1) — build the no-op emitter + toggle + event
schema, and PARK the actual transport behind a clear seam + TODO.**

**Files & exact edits.**
- **New `packages/core/src/telemetry/telemetry.ts`** (+ barrel line in
  `packages/core/src/index.ts` after 1–9):
  - `TelemetryEvent` union / type — **metadata only**. A closed whitelist, e.g.:
    `type` (`"session_start" | "session_finalize" | "error"`), `sttProvider`,
    `correctionProvider`, `language` (tag only), `autoDetect` (bool),
    `correct`/`format` (bool), `sttLatencyMs`, `correctionLatencyMs`,
    `formatLatencyMs`, `rawLen`/`cleanLen` (integer character COUNTS, not text),
    `errorCode`/`errorPhase` (short slug, not the message), `appVersion`. Define this
    as an explicit `ALLOWED_FIELDS` set so sanitization is data-driven.
  - `interface TelemetrySink { send(event: Record<string, unknown>): void }`.
  - `class NoopSink implements TelemetrySink { send() {} }` — the **default**.
  - `function sanitize(raw): Record<string, unknown>` — returns a NEW object copying
    ONLY keys in `ALLOWED_FIELDS`; anything else (e.g. `transcript`, `text`, `audio`)
    is dropped. This is the hard safety boundary — the whitelist is allow-list, not
    deny-list.
  - `class Telemetry { constructor(opts: { enabled: boolean; sink?: TelemetrySink }) }`
    with `emit(event: TelemetryEvent): void` that returns immediately when
    `!enabled` (no sink call, no sanitize, no allocation beyond the guard), and when
    enabled calls `this.sink.send(sanitize(event))`.
  - **PARKED transport seam + TODO comment:** the real HTTP/beacon sink is NOT built.
    Leave `// TODO(telemetry-transport, settings-plan §10.1): endpoint UNDECIDED —
    wire a real TelemetrySink here once the sink is chosen. Default stays NoopSink so
    nothing leaves the device.` The constructor accepting an injectable `sink` IS the
    seam.
- **main.rs** — add `telemetry: bool` to `AppConfig` + Default (default `false`).
  A `telemetry` **gate** field: when the flag is off, no telemetry is emitted. Because
  core is where events originate and the widget's runtime pipeline is the backend, the
  flag rides the WS `start` frame (main.ts:328–336 add `telemetry: cfg.telemetry`) and
  the backend constructs its `Telemetry` with `enabled: msg.telemetry === true`
  (server.ts:171–182). **Do NOT emit any event before the flag is read.** (Rust itself
  emits nothing in this wave — the gate is the config field + passing it through.)
- **apps/backend/src/server.ts** — construct one `Telemetry` per connection with
  `enabled` from the start frame; call `telemetry.emit(...)` at the natural metadata
  points (after `ready`, after `finalize` with latencies/counts, in the error paths)
  using COUNTS not text. Default sink = `NoopSink`, so with the endpoint parked this
  is inert but exercises the schema.
- **apps/widget/src/settings.ts** + **settings.html:566–576** — un-gate the Advanced
  "Anonymous telemetry" row: add `<input type="checkbox" id="telemetry">`, remove
  `disabled` + `Not in use`, and add a one-line **"what we collect"** note in the row
  `<p>` (e.g. "Only anonymous metadata — latencies, provider names, error codes.
  Never your transcript or audio."). `settings.ts`: add `telemetry?: boolean` to the
  TS `AppConfig`; `initTelemetry()` mirrors `initDebug()` (**512–516**) —
  `telemetryEl.checked = !!config.telemetry; onchange → patchConfig({ telemetry })`.
  Wire into `refreshControls` (536–548) + `DOMContentLoaded` (571–591).

**Config/store schema delta.** `telemetry: bool = false` on `AppConfig` (§1). No new
store file. Event schema lives in `telemetry.ts` (`ALLOWED_FIELDS` / `TelemetryEvent`).

**Test checklist.**
_Cloud-runnable (core vitest — new `packages/core/src/telemetry/telemetry.test.ts`):_
- [ ] `emitter is a no-op when disabled` — construct `new Telemetry({ enabled: false,
      sink: spy })`, call `emit({...})`, assert `spy.send` was **never** called.
- [ ] `enabled emitter forwards only whitelisted fields` — `new Telemetry({ enabled:
      true, sink: spy })`, `emit({ type:"session_finalize", sttProvider:"pyai",
      sttLatencyMs:120, transcript:"secret words", text:"secret", rawLen:11 })`;
      assert the object `spy.send` received **contains** `type/sttProvider/
      sttLatencyMs/rawLen` and **does NOT contain** `transcript` or `text`.
- [ ] `sanitize drops any non-whitelisted key` — direct `sanitize({ audio:[...],
      apiKey:"x", type:"error", errorCode:"429" })` ⇒ keys are exactly the
      whitelisted subset (`type`,`errorCode`).
- [ ] `default sink is NoopSink` — `new Telemetry({ enabled: true })`.emit(...) does
      not throw and performs no network (NoopSink).
- [ ] `npm test` stays green.
- [ ] `apps/backend` + `apps/widget` `tsc --noEmit` pass with the new emitter usage,
      the start-frame `telemetry` flag, and the Settings toggle.

_On-Mac:_
- [ ] `cargo check` compiles with the `telemetry` field.
- [ ] Toggle is OFF by default on a fresh config / after Reset; flipping it persists.
- [ ] With telemetry ON, grep backend logs during a dictation → **no** transcript /
      audio content in any emitted event (counts/latencies only).
- [ ] (Transport parked) confirm no network egress happens — NoopSink is still wired.

**Risks/notes. TRANSPORT IS PARKED** — do not build the HTTP sink; the endpoint is
undecided (§10.1). **Scope-creep risk (call out to reviewer):** the temptation is to
"just add a fetch" — resist it; the allow-list `sanitize` + injectable sink is the
whole safety story and must land first. Hard requirement (product-plan §14/§8): the
emitter must be provably no-op when disabled and provably content-free when enabled —
that's exactly what the two headline vitest cases assert. Because the widget runs the
backend (not core `Pipeline`), the emit calls that matter for the shipped app are in
`server.ts`; the core `Telemetry` class is the reusable, unit-tested primitive.

---

## 3.4 Vocabulary

**Goal.** A `vocabulary.json` store (separate file, own CRUD) of custom terms, a
Settings pane that replaces the empty state with an add/edit/delete list, and
`packages/core` correction-prompt injection of the term list (plus Deepgram
keyword-boost where the API allows).

**Files & exact edits.**
- **New Rust store + commands (main.rs).** Model on `read_config`/`write_config`
  (148–168) and the `secrets.rs` separate-file pattern:
  - `const VOCAB_FILE: &str = "vocabulary.json";` with a `"terms"` key holding
    `Vec<String>` (or `Vec<VocabEntry{ term, sounds_like? }>` if we want spelling
    hints — recommend starting with `Vec<String>` for simplicity; note the option for
    the reviewer).
  - Commands `vocab_list(app) -> Vec<String>`, `vocab_add(app, term)`,
    `vocab_delete(app, term)` (and optionally `vocab_set(app, terms)` for bulk edit).
    Register all in `generate_handler!` (**1022–1045**).
  - These write their own store via `app.store(VOCAB_FILE)`, mirroring
    `read_config`/`write_config`. NOT part of `AppConfig`, so Reset (1.3) leaves
    vocabulary untouched (like secrets) — confirm that's desired (open question).
- **Settings pane (settings.html:502–520 + settings.ts).** Replace the `.card.empty`
  block with an editable list: an input + Add button, and a list of rows each with the
  term + a delete (⋯/trash) control (reuse the vendor-row menu affordances). Remove the
  `Not in use` tag on the `<h1>` (505). In `settings.ts` add an `initVocabulary()`:
  `invoke("vocab_list")` to render; Add → `invoke("vocab_add", { term })` then
  re-render; Delete → `invoke("vocab_delete", { term })`. Wire into `DOMContentLoaded`.
- **Correction-prompt injection (packages/core).**
  - `types.ts:31–36` — add `vocabulary?: string[]` to `CorrectionContext`.
  - `prompt.ts:105–108` — `userMessage(raw, priorContext?, language?, vocabulary?)`
    appends, when non-empty, a line like:
    `\n\nKnown terms (preserve/spell exactly): ${vocabulary.join(", ")}.` Keep it
    additive and behind a truthy check so existing calls/tests are unaffected.
    **⚠ REVIEWER CORRECTION — inject into the FORMAT step, not (only) correction.**
    The correction `SYSTEM_PROMPT` (prompt.ts:6–17) is a MINIMAL disfluency pass that
    explicitly says "DO NOT ... change ... wording. DO NOT rephrase" and restricts
    edits to filler/false_start/self_correction/repetition. A misheard proper noun is
    none of those, so a term list appended to the correction user turn is likely a
    NO-OP for OpenAI/PyAI (the model is told not to re-spell). The place where re-spelling
    is permitted is the FORMAT pass (`FORMAT_PROMPT` allows grammar/rewrites). So for the
    prompt-only vendors, thread `vocabulary` into `formatMessage(text, language, vocabulary)`
    / `FORMAT_PROMPT` — that is the effective lever. (Correction-side injection can stay
    as a harmless extra, but do not rely on it.) Note `format?(text, language?)`
    (types.ts:49) has no ctx today — extend its signature to carry the term list.
  - The three real adapters pass it through: **pyai.ts:54**, **openai.ts:93**,
    **anthropic.ts:60** → `userMessage(raw, ctx?.priorContext, ctx?.language, ctx?.vocabulary)`.
  - **Pipeline** (pipeline.ts:256) and **backend** (server.ts:127) build the ctx with
    the term list. For the widget path, the terms reach the backend on the WS `start`
    frame: overlay `main.ts` fetches `vocab_list` (or reads a cached copy) and sends
    `vocabulary: [...]` (main.ts:328–336); `server.ts` parses it on `start`
    (171–182) into a connection-scoped `vocabulary` and passes
    `correction.correct(raw, { vocabulary })` (server.ts:127). Core `Pipeline` can take
    it via a new `PipelineOptions.vocabulary?` (pipeline.ts:39–42) or a `sttConfig`-
    like channel — recommend adding to the finalize ctx directly.
- **Deepgram keyword-boost (feasibility-gated).** `deepgram.stt.ts:35–46` — when a
  term list is available, append `keywords` params (nova-2: `keywords=term:intensity`;
  nova-3 uses `keyterm`). This requires the term list to reach `startSession` — add
  `keywords?: string[]` to `STTSessionConfig` (types.ts:38–41) and set them in the
  query. **OpenAI Realtime and PyAI Hear have no equivalent keyword-boost param** — so
  STT-side boost is **Deepgram-only**; for OpenAI/PyAI the vocabulary influence is via
  the correction prompt only. Make the adapter change defensive (only add params when
  present) so the other vendors are unaffected.

**Config/store schema delta.** New store file `vocabulary.json`, key `"terms"` →
`string[]` (default empty). `CorrectionContext.vocabulary?: string[]`. Optional
`STTSessionConfig.keywords?: string[]` (Deepgram-only consumer). No `AppConfig` field.

**Test checklist.**
_Cloud-runnable (core vitest — new `packages/core/src/correction/vocabulary.test.ts`):_
- [ ] `userMessage injects the term list when provided` — `userMessage("call me
      Xa Long", undefined, undefined, ["Xa Long","Verbatim"])` contains both terms in
      the appended "Known terms" line.
- [ ] `userMessage with empty/undefined vocabulary is byte-identical to today` —
      `userMessage(raw)` and `userMessage(raw, undefined, undefined, [])` add no vocab
      line (guards existing prompt.test.ts assertions from regressing).
- [ ] `deepgram startSession adds keywords params when given` — with
      `keywords:["Verbatim"]` the constructed query includes a `keywords` entry; without
      it, the query is unchanged.
- [ ] `npm test` stays green.
- [ ] `apps/widget` + `apps/backend` `tsc --noEmit` pass (new commands, ctx field,
      start-frame `vocabulary`).

_On-Mac:_
- [ ] `cargo check` compiles with the `vocabulary.json` store + `vocab_*` commands in
      `generate_handler!`.
- [ ] Add a term in Settings → it persists across restart (`vocabulary.json` exists in
      app_config_dir); delete works; the empty state is replaced by the list.
- [ ] Dictate a fixture containing a known unusual term → the correction output
      preserves/spells it (prompt injection effective).
- [ ] (Deepgram) with a boosted keyword, the raw STT is measurably more likely to get
      the term right vs. without it.
- [ ] Reset (1.3) leaves the vocabulary intact (confirm this is the intended behavior).

**Risks/notes. Keyword-boost feasibility differs per adapter (call out to reviewer):**
Deepgram has real `keywords`/`keyterm` support and is the only STT-side boost;
OpenAI Realtime and PyAI Hear have **no** keyword param, so for those vendors
vocabulary is prompt-only (correction step). Verify the Deepgram param name against
`DEEPGRAM_STT_MODEL` (nova-2 `keywords` vs nova-3 `keyterm`) — getting this wrong is a
silent no-op, not an error. Prompt-injected terms grow the correction input token
count; keep the list short / cap it. Decide the term shape (`string[]` vs
`{term, soundsLike}`) before building the UI.

---

## 3.5 Snippets

**Goal.** A `snippets.json` store (separate file, own CRUD), a **deterministic
post-transcript expander** in `packages/core` (spoken trigger → replacement), and a
Settings list UI replacing the empty state.

**Files & exact edits.**
- **New Rust store + commands (main.rs).** Same pattern as 3.4:
  `const SNIPPETS_FILE: &str = "snippets.json";` holding a list of
  `{ trigger: String, expansion: String }`. Commands `snip_list`, `snip_add(trigger,
  expansion)`, `snip_delete(trigger)` (+ optional `snip_set`), registered in
  `generate_handler!` (1022–1045). Not an `AppConfig` field.
- **New `packages/core/src/snippets.ts`** (+ barrel line in `index.ts`):
  - `interface Snippet { trigger: string; expansion: string }`.
  - `function expandSnippets(text: string, snippets: Snippet[]): string` — a
    **deterministic** matcher. Recommended semantics: case-insensitive,
    whole-phrase/word-boundary match of `trigger` in `text`, replaced with
    `expansion`; longest-trigger-first to avoid partial-shadowing; no regex injection
    from user triggers (escape them). Pure function, no I/O — trivially unit-testable.
- **Hook the expander into finalize (BOTH paths).**
  - Core `Pipeline.finalizeOnce` (**pipeline.ts:245–274**): after the formatted/clean
    text is computed and BEFORE `onFormatted`, apply `expandSnippets(text, snippets)`.
    Add `snippets?: Snippet[]` to `PipelineOptions` (**39–42**). **NOTE there are THREE
    `onFormatted` call sites** — line 264 (LLM-formatted), 266 (unformatted/clean), and
    **270 (the `catch` fallback → raw)**. Route all through a single local
    `emitFormatted(text)` that applies `expandSnippets` once, so snippets fire on the
    error path too and you don't duplicate the expand call. (The plan's "264/266" missed
    the catch at 270.)
  - Backend `finalize` (**server.ts:141–156**): after `finalText` is computed and
    before `send(ws, { type: "formatted", text: finalText })` (156), apply
    `expandSnippets(finalText, snippets)`. Terms reach the backend on the WS `start`
    frame (`snippets: [...]`, main.ts:328–336 + server.ts:171–182 parse). Overlay
    `main.ts` sources them from `invoke("snip_list")`.
  - **Ordering decision:** expansion runs on the FINAL formatted text (so it isn't
    re-punctuated/altered by the formatter). Document that snippet expansions are
    inserted verbatim.
- **Settings pane (settings.html:522–537 + settings.ts).** Replace the `.card.empty`
  with a two-field add row (trigger + expansion) + Add, and a list of
  trigger→expansion rows each with delete. Remove the `Not in use` tag (525).
  `initSnippets()` in settings.ts: `invoke("snip_list")` render; Add →
  `invoke("snip_add", { trigger, expansion })`; Delete → `invoke("snip_delete",
  { trigger })`. Wire into `DOMContentLoaded`.

**Config/store schema delta.** New store file `snippets.json` → `Snippet[]`
(`{trigger, expansion}`), default empty. `PipelineOptions.snippets?: Snippet[]`. No
`AppConfig` field.

**Test checklist.**
_Cloud-runnable (core vitest — new `packages/core/src/snippets.test.ts`):_
- [ ] `expandSnippets replaces a trigger with its expansion` — `expandSnippets("please
      insert sig block here", [{trigger:"sig block", expansion:"Best,\nMayank"}])`
      contains `Best,` and no longer contains `sig block`.
- [ ] `expansion is case-insensitive and whole-phrase` — `"Sig Block"` matches;
      a substring inside another word does NOT (`"assignment"` not matched by
      trigger `"sign"`).
- [ ] `longest trigger wins on overlap` — with triggers `"sig"` and `"sig block"`, the
      longer one is applied.
- [ ] `no snippets / empty list is identity` — `expandSnippets(t, [])` === `t`.
- [ ] `special-regex triggers are treated literally` — a trigger containing `.` or `(`
      matches literally, not as regex.
- [ ] `Pipeline applies snippets to the final output` — a `Pipeline` run with
      `{ snippets:[...] }` in `PipelineOptions` yields an `onFormatted` text with the
      expansion applied (FixtureSTT + MockCorrection, same harness as format.test.ts).
- [ ] `npm test` stays green.
- [ ] `apps/widget` + `apps/backend` `tsc --noEmit` pass.

_On-Mac:_
- [ ] `cargo check` compiles with the `snippets.json` store + `snip_*` commands.
- [ ] Add a snippet in Settings → persists across restart; delete works; empty state
      replaced by the list.
- [ ] Dictate the trigger phrase → the expansion is inserted deterministically.
- [ ] Reset (1.3) leaves snippets intact (confirm intended).

**Risks/notes.** Keep expansion **deterministic** — no LLM (that's the acceptance
criterion). Decide match granularity (whole-phrase vs word) and case rules up front;
document that expansion runs on the FINAL formatted text so it isn't reformatted.
Guard against user triggers being interpreted as regex (escape them). An empty/whitespace
trigger must be rejected at the CRUD layer to avoid a match-everything bug.

---

## Open questions for reviewer

1. **Telemetry sink is undecided (§10.1) — confirmed PARK.** Do we agree the whole
   transport stays out of this wave (no-op emitter + toggle + schema only), and the
   toggle ships ON-able but inert (NoopSink)? Or should the toggle stay disabled/"Planned"
   until an endpoint exists, to avoid implying data is being sent when it isn't?
2. **Vocabulary keyword-boost per adapter.** Confirm Deepgram-only STT boost is
   acceptable for this wave (OpenAI/PyAI get prompt-only). Which Deepgram param —
   `keywords` (nova-2) or `keyterm` (nova-3) — matches the shipped `DEEPGRAM_STT_MODEL`?
3. **Vocabulary/Snippets vs Reset.** Should Reset (1.3) clear these list stores, or
   leave them (like secrets)? Plan assumes **leave** (separate files, not `AppConfig`)
   — confirm.
4. **Vocabulary entry shape.** `string[]` (simple) vs `{term, soundsLike}` (spelling
   hints, better for STT boost)? Plan starts with `string[]`.
5. **Auto-detect on the batch path.** `transcribeBatch` (the authoritative widget
   final) has no language/detect arg today. Is relying on vendor default auto-detect
   for batch acceptable this wave, with streaming detect wired explicitly?
6. **How do vocabulary/snippets reach the backend?** Plan routes them through the WS
   `start` frame (like `correct`/`format`) sourced from the new Rust stores via
   `invoke`. Alternative: have the backend read the store files directly. The start-frame
   route keeps the backend store-agnostic (preferred) — confirm.
7. **Snippet expansion ordering.** Run AFTER formatting on the final text (plan's
   choice) vs before formatting (lets the formatter tidy the inserted text)? Plan picks
   after, for determinism.
8. **Mic picker item has no core vitest** (webview + scalar config only). Acceptable
   that 3.1's automated cloud gate is typecheck + static grep, with behavior on-Mac?
