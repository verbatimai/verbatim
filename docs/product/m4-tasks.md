# M4 — Desktop App + Multi-Vendor + Configuration: Task Breakdown

**Goal (North-Star slice):** deliver on the two promises the architecture was built for — **vendor-agnostic** STT/correction and **BYOK, local-only** keys — in a **real desktop app**. The single-window overlay is split into a **menu-bar app with a focusable settings window**; from that window the user picks an STT vendor and a correction vendor **independently** (mix-and-match), **types** keys that persist in the **OS keychain**, captures an arbitrary **hotkey**, optionally picks a **language**, and the widget runs the exact M2/M3 pipeline against whatever valid combination they chose — with **no dev backend** in the default path (an app-owned sidecar replaces it).

> **Merge note (13 Aug 2026):** the former standalone `desktop-app-plan.md` (the "Settings App + Streaming Overlay" window split) is **folded into this document** — it was the front half of M4 all along, not a separate track. The old file is retired to `_to_delete/`. This doc is now the single source of truth for M4.
>
> **Renumber note:** the completed phases keep their numbers (**4.0, 4.1 — done, unchanged**). The window-split phases were inserted ahead of the not-yet-started work, so what was "4.2 keychain" is now **4.3**, "4.3 Deepgram" is now **4.4**, and so on. Old cross-references shift by the same amount from 4.2 onward.

**Why now:** M0–M2 are done and M3's exit criteria are essentially met (hotkey → dictate over a 3rd-party app → corrected text inserted → widget never steals focus → password fields refused). The two items deliberately deferred as "M4-flavoured" were **Phase 3.5 (keychain BYOK)** and the **window split** that unlocks typed keys / real hotkey capture / provider-model dropdowns. M4 absorbs both as its backbone, because a focusable settings window + keychain + client-direct (sidecar) calls are what let us drop the dev backend and ship the open-core "local, no server" model.

---

## Progress at a glance (updated 13 Aug 2026)

Progress is tracked in three places: **this file** (per-phase checklist — the detail), **`STATUS.md`** (handoff snapshot — read first for context), and **`roadmap.md`** (milestone level).

- ✅ **4.0** decisions · ✅ **4.1** core config/capability · ✅ **4.2** settings window *(compiles on Mac; runtime pending)* · ✅ **4.3** config store + keychain *(compiles; committed `ea8ca9d`)* · ✅ **4.4** Deepgram STT *(cloud-tested)* · ✅ **4.5** OpenAI STT+correction *(cloud-tested)* · ✅ **4.6** Anthropic correction *(cloud-tested)*
- ⏳ **Remaining:** **4.7** settings UI + multilingual · **4.8** overlay/pipeline via sidecar · **4.9** slim the overlay · **4.10** wire-up + exit demo
- 🔎 **Pending verification (folds into 4.10):** on-Mac runtime for 4.2/4.3 (compiled, not yet exercised); live-vendor runs for 4.5/4.6 (mock-tested only so far).

---

## What already exists (starting point — don't rebuild)

- **Interfaces are locked** (`packages/core/src/providers/types.ts`, `correction/types.ts`): `STTProvider` / `STTSession` / `TranscriptEvent {stableText, activeText, endpoint}`, and `CorrectionProvider` with the compact-edits `CorrectionResult`. Nothing above the adapter boundary references a vendor.
- **Registries + factory exist** (`providers/registry.ts`, `correction/registry.ts`): add a vendor = one line. `STT_PROVIDER` / `CORRECTION_PROVIDER` env selection already resolved through them.
- **Capability check exists for both roles** — STT `assertKeys(provider)` and (as of 4.1) correction `assertCorrectionKeys`, plus `capabilityErrors()` / `assertCapability()` in `settings.ts` fail fast on missing keys.
- **Core config layer is DONE (4.1)** — `AppSettings` + `DEFAULT_SETTINGS` + `resolveProviders()` in `packages/core/src/settings.ts`, 12 tests green. See 4.1.
- **`language` is on `STTSessionConfig`** and returned by the resolver; still to be wired into session start + prompts (4.7).
- **Deepgram STT adapter is ~60% built** (`providers/deepgram.stt.ts`): interim/`is_final`/`UtteranceEnd` → stable/active/endpoint mapping is coded, but it uses a Node-`ws` `Authorization` header (won't work from a browser/webview), has no endpointing/`utterance_end_ms` tuning, and has **no tests**.
- **OpenAI and Anthropic adapters are commented-out stubs** in both registries — net-new.
- **Research is done** (`docs/architecture/vendor-apis.md`, `multilingual.md`, `vendor-transport.md`): Deepgram + Anthropic confirmed live; OpenAI Realtime URL/beta header marked **[verify]** (resolved in 4.0).
- **M3 widget shell (the surface this builds on):** the widget is a **single window** (`main` in `tauri.conf.json`) reclassed into a non-activating, **non-key** `NSPanel` (`can_become_key_window:false`, `is_floating_panel:true`), running as `ActivationPolicy::Accessory`. It hosts *both* the orb/streaming card *and* today's inline settings panel. Keychain BYOK partially exists via **`key_save_clipboard`** (the non-key panel can't accept a *typed* key, so entry is clipboard-only today — the window split fixes this). Configurable hotkey exists via a preset list → `set_toggle_hotkey`, persisted to a hotkey file (`hotkey_config_path`) and re-registered live via a `CURRENT_TOGGLE` static. Accessibility status via `ax_trusted`. These fold into the Rust config store in 4.3.

So M4 is **split the window, persist one config store + keychain, finish one adapter, add three, build the real settings UI, and localize prompts** — all behind interfaces that already exist.

---

## The single macOS gotcha the window split introduces — activation policy

The app runs as `ActivationPolicy::Accessory` (no dock icon, never frontmost — that's what keeps the overlay from stealing focus). A **focusable settings window needs the app to be able to activate**.

**Decision (locked, §4.0): menu-bar-only via a temporary activation switch.**
- Keep `Accessory` as the default.
- When **opening** settings: `set_activation_policy(Regular)` → `show()` → `set_focus()` → activate the app.
- When settings **closes/blurs**: revert to `set_activation_policy(Accessory)`.
- The overlay panel stays **non-key** throughout (unchanged) — never make it focusable to "fix" typing; that would break injection. Typing belongs in the settings window only.

> **Verify on-device (part of the 4.2 acceptance):** an Accessory app toggled to Regular does take keyboard focus for the settings window, and the overlay panel remains non-key and still injects while settings is open.

---

## Phase 4.0 — Design spike / decisions (do FIRST, de-risk)  ·  ✅ DONE (13 Aug 2026)

**Decided → full analysis in `docs/architecture/vendor-transport.md`.** The real unknowns, resolved before any adapter or window code.

- [x] **WS-auth transport decided: (C′) Rust-managed local sidecar.** The WS-header limit only bites **streaming STT** — correction/format/batch are HTTPS and take a header from any `fetch`. Verified: PyAI Hear is **header-only**, and **OpenAI Realtime needs a server-minted ephemeral token** for browsers (raw key only allowed on a "secure backend") — so a renderer-direct design (B) is a dead end and leaks keys. Chosen: the app **spawns the existing Node backend as a bundled Tauri sidecar**; Rust reads the Keychain and hands the selected keys to it via env/stdin (**never through the renderer**); the webview streams mic PCM over loopback as today. Reuses 100% of the tested TS core; fixes the key-in-renderer smell. **(A) Rust-native STT kept as a future (M6) optimization.** → this is the transport for 4.8 ("drop the dev backend" = the app owns the sidecar's lifecycle; no manual `npm run`, no renderer key-path; the code stays).
- [x] **[verify] items confirmed** (logged in `vendor-transport.md` §2): OpenAI Realtime `wss://api.openai.com/v1/realtime?model=…`, raw key OK on a secure backend / ephemeral+WebRTC for browsers, **models renamed** `gpt-live-transcribe` (stream) / `gpt-transcribe` (post-turn), 24 kHz PCM, `…transcription.delta`/`.completed` events → **`vendor-apis.md` §2 needs the model-id update (fold into 4.5)**. Deepgram token-subprotocol + short-lived-token auth confirmed. Anthropic forced tool-use confirmed (already live in `vendor-apis.md`).
- [x] **Core `AppSettings` schema locked** (see `vendor-transport.md` §5): `{ sttProvider, correctionProvider, language }` — **no keys in it** (secrets stay in the Keychain, keyed by each provider's `requiredKeys[]`). This is the provider-selection slice consumed by `resolveProviders()`; it is **shipped and tested** in 4.1 and is not changed by the window split. The Rust widget config store (4.3) *persists* this object **plus** widget-only prefs (`hotkey`, `dockIcon`); those extra prefs live in the store, not in the core type. Optional per-provider **model** ids (`sttModel`/`correctionModel`) are an additive field introduced with the settings dropdowns in 4.7 — deferred until then, so they don't churn the shipped type now.
- [x] **Window-split decisions locked** (merged from the desktop-app plan):
  1. **Dock icon:** menu-bar-only via the temporary `Regular` switch **(chosen)**, not a permanent dock icon. Exposed as a `dockIcon` widget pref only if we later want the choice.
  2. **Settings UI stack:** stay **vanilla-TS** (matches the app), no framework.
  3. **Prefs storage:** **`tauri-plugin-store`** for non-secret settings (also resolves the desktop plan's open "hand-rolled JSON vs plugin-store" question — the store wins, consistent with the schema lock above).

**Gate:** ✅ cleared — transport + window-split decisions + the schema are fixed, so 4.2–4.10 can start against stable plumbing.

---

## Phase 4.1 — Config & capability layer (core)  ·  ✅ DONE (13 Aug 2026)

Make provider selection first-class and independent for the two roles. Implemented in `packages/core/src/settings.ts` (+ `settings.test.ts`).

- [x] `AppSettings` type + `DEFAULT_SETTINGS` + `resolveProviders()` that builds the STT provider and the correction provider **independently** from settings (mix-and-match, e.g. Deepgram STT + Anthropic correction). No keys in the type — secrets stay in the Keychain.
- [x] `assertCorrectionKeys` added to the **correction** registry (mirrors STT `assertKeys`; named distinctly so the barrel's `export *` doesn't collide), plus `capabilityErrors()` / `assertCapability()` in settings.ts that validate the *selected combination* against env and **fail fast with one message** listing every missing key.
- [x] `language` plumbed at the core level: on `AppSettings`, returned by the resolver, with the **PyAI-English-only guard** in the capability check. (Wiring `language` into `STTSessionConfig` at session start + localizing the correction/format prompts is 4.7, as planned.)
- [x] Unit tests (12, all green): defaults, independent mix-and-match resolution, blank-language fallback, missing-key messages per role, shared-key satisfies-both, English-only guard (+ `en-US` allowed), multilingual vendor allows non-English, unknown-vendor id message, `assertCapability` throw/no-throw. Full-package `tsc --noEmit` clean.

## Phase 4.2 — Settings window + activation policy (the window split)  ·  ✅ DONE (code; compiles on Mac — runtime acceptance pending)

Scaffold the focusable second window before any real inputs can exist. *(from the desktop-app plan, Phase 1.)* **Code-level implementation plan: `m4.2-settings-window-plan.md`.** Implemented across `tauri.conf.json`, `vite.config.ts`, `settings.html`/`src/settings.ts`, `src-tauri/src/main.rs`, `capabilities/default.json`, `src/main.ts`; **`cargo build` clean on the Mac** (confirms `AppHandle::set_activation_policy`).

- [x] `tauri.conf.json`: added the `settings` window (`decorations:true`, `focus:true`, `alwaysOnTop:false`, `visible:false`, `resizable:true`, ~`480×620`). `main` overlay unchanged.
- [x] Vite multi-page: `settings.html` + `src/settings.ts` added; both registered as Rollup inputs in `vite.config.ts`.
- [x] Rust `show_settings_window` command + `open_settings_window` helper: Accessory→Regular→`show`→`set_focus`. Tray **"Settings…"** and the overlay gear (`main.ts`) both call it.
- [x] Window-close handling: `CloseRequested` → prevent-close + hide + revert to Accessory (never quits).
- [ ] **On-Mac runtime acceptance (pending):** type into the settings window; overlay still injects while settings is open; closing settings drops the Dock icon without quitting. *(the injection-while-settings-focused check is the one to watch.)*

## Phase 4.3 — Rust config store + keychain BYOK (the backbone; absorbs M3 Phase 3.5)  ·  ✅ DONE (code; compiles on Mac) (13 Aug 2026)

One persistence layer in Rust — the widget's single source of truth — read/written by both windows, with a live-refresh event. *(merges desktop-app Phase 2 + the M3-deferred keychain BYOK. The core `AppSettings` type from 4.1 is unchanged; this phase persists it and adds widget-only prefs.)* **Code-level implementation plan: `m4.3-config-store-plan.md`.** Committed in `ea8ca9d`; **`cargo build` clean on the Mac.**

- [x] **Prefs store:** `tauri-plugin-store` config module persisting `AppConfig` (superset of core `AppSettings` + `hotkey`/`dockIcon`) as `settings.json`. `get_config()` / `set_config(patch)` (shallow-merge). Legacy `hotkey` file migrated once via `migrate_legacy_config`. Every write emits **`config-changed`**.
- [x] **Keychain (secrets):** per-vendor `set_key`/`has_key`/`delete_key` (pyai/deepgram/openai/anthropic → `*_API_KEY`); existing `key_*` kept. Keys stay Rust-side (never the renderer).
- [ ] **On-Mac runtime acceptance (pending):** config round-trips + survives relaunch; `config-changed` fires; a saved key persists across restart; migrated hotkey still drives dictation. *(compiles; behaviour to confirm at runtime, folds into the 4.10 exit demo.)*

## Phase 4.4 — Finish the Deepgram STT adapter  ·  ✅ DONE (core, cloud-tested) (13 Aug 2026)

**Code-level implementation plan: `m4.4-deepgram-plan.md`.** *(The adapter runs in the Node sidecar, so its existing `ws` `Authorization` header is fine — the "webview can't set WS headers" worry doesn't apply.)* Deepgram is **STT-only** (no correction adapter, by design — no text LLM); pair it with a correction vendor (e.g. Deepgram STT + Anthropic correction).

- [x] Sidecar socket with the Node-`ws` `Token` header (no webview token needed); added `DEEPGRAM_WS_URL`/`DEEPGRAM_STT_MODEL`/`DEEPGRAM_BASE` overrides (read at call time) for testability + the 4.7 dropdown.
- [x] Endpointing: `model=nova-2`, `smart_format`, `punctuate`, `endpointing=300`, `utterance_end_ms=1000` (+ existing `interim_results`, `vad_events`, `language`). `speech_final` **and** `UtteranceEnd` both close a segment, **de-duplicated** to one `final`+`endpoint` per utterance. `finalize()` sends `Finalize` then `CloseStream`.
- [x] Added **`transcribeBatch`** (prerecorded `POST /v1/listen`) for finalize parity with PyAI/OpenAI.
- [x] **Integration test** `providers/deepgram.stt.integration.test.ts` — mock WS (auth + endpointing query, interim→active, is_final→stable, speech_final/UtteranceEnd→one final+endpoint) + mock HTTP for batch. **3 tests green in cloud** (`vitest`). Live on-Mac run vs real Deepgram deferred to 4.10.

## Phase 4.5 — OpenAI adapters (STT + correction)  ·  ✅ DONE (core, cloud-tested) (13 Aug 2026)

Both adapters shipped behind the existing interfaces + registered. **Cloud-tested against mock servers; live on-Mac run against real OpenAI still pending (4.10 exit demo).**

- [x] **STT — Realtime WS** adapter (`providers/openai.stt.ts`): declares 24 kHz pcm16, sends `transcription_session.update` (server_vad), base64 `input_audio_buffer.append`, `commit` on finalize; `...transcription.delta`→active / `.completed`→final+endpoint → `TranscriptEvent` (accumulate-deltas mapping, like Deepgram). Model ids `gpt-live-transcribe` (stream) / `gpt-transcribe` (batch), env-overridable. Plus **batch** `transcribeBatch` (`POST /v1/audio/transcriptions`, multipart) for the finalize path. Registered `openai` in `providers/registry.ts`.
- [x] **Correction** adapter (`correction/openai.ts`): `POST /v1/chat/completions` with strict `response_format:{type:"json_schema", strict:true}` → compact-edits schema; reuses `SYSTEM_PROMPT`/`userMessage`/`reconstruct`/`validate` + `FORMAT_PROMPT` unchanged; retry-with-backoff + refusal guard. Registered `openai` in `correction/registry.ts`.
- [x] Folded the model-id update into `vendor-apis.md` §2 (renamed models, secure-backend-vs-ephemeral note, `transcription_session.update`/`commit` flow).
- [x] Mock-server integration tests, **all green in cloud**: correction (auth + json_schema request shape, reconstruct-validates, refusal, retry, exhaustion) = 5; STT (headers, pcm16 config, base64 append, delta→active / completed→final+endpoint, batch multipart) = 2. Full-package `tsc --noEmit` clean.
- [ ] **Live on-Mac verification** (deferred to 4.10): real Realtime session (the `transcription_session.*` message names + ephemeral-token path are documented-but-unproven) and real batch transcription; `sendAudio` assumes capture feeds the provider's declared 24 kHz (wire it in 4.8).

## Phase 4.6 — Anthropic correction adapter  ·  ✅ DONE (13 Aug 2026)

- [x] `POST /v1/messages` with **forced tool-use** (`emit_correction` tool, `input_schema` = compact-edits schema, `tool_choice:{type:"tool"}`) → parse the `tool_use` block's `input`; reuse the shared reconstructor. This is the "structured ops done right" path (native tool-use, unlike PyAI's JSON-in-text workaround). Implemented in `packages/core/src/correction/anthropic.ts`, registered in `correction/registry.ts`. `format()` also implemented (plain-text pass, no forced tool) for parity with the other adapters and so the real pipeline's formatting step works when "anthropic" is selected.
- [x] Mock-server integration test (tool_use response → edits → `reconstruct` valid) — `packages/core/src/correction/anthropic.integration.test.ts` (4 tests: request shape/auth, happy path, drift fallback, non-2xx, format). Full core suite green (64 tests), `tsc --noEmit` clean.

*(4.4 / 4.5 / 4.6 have no interdependencies once 4.0 + 4.1 land — they can be built in parallel against mock servers using dev `.env` keys, before or alongside the window/keychain phases.)*

## Phase 4.7 — Settings UI: real inputs + provider/model selection + multilingual

Move settings into the focusable window with **real** controls. *(merges desktop-app Phase 3 + the M4 provider-selection UI + multilingual.)*

- [ ] Port the settings DOM/logic out of `index.html`/`main.ts` into `settings.html`/`settings.ts`:
  - **Typed** password field for the API key per vendor (Save → keychain, 4.3). Keep clipboard-paste as an optional convenience only.
  - **Provider + model dropdowns** for STT and correction — independent = mix-and-match. Introduce the optional `sttModel`/`correctionModel` prefs here (additive to the store; core resolver defaults per-provider when absent).
  - **Hotkey capture** — a focusable window can read `keydown`; record the combo into an accelerator string. Keep presets as quick picks.
  - **Language** select; live **permission status** (`ax_trusted`, mic) with deep-links.
- [ ] Wire `language` into `STTSessionConfig` at session start and **localize the cleanup + format prompts** in `prompt.ts` (or instruct the model to "respond in the transcript's language"). The core English-only guard (4.1) already blocks non-English on PyAI — surface it in the UI as **"English-only on PyAI — pick Deepgram/OpenAI for this language"** (don't silently fail).
- [ ] Live **capability check** with a clear inline error when a chosen combination is missing a key (surface `assertCapability`/`capabilityErrors`, not just a thrown error).
- [ ] Overlay gear → `show_settings_window`.
- **Acceptance:** you can **type** a key, pick STT/correction provider + model, capture an arbitrary hotkey, and choose a language in the settings window; an invalid combo shows an inline error.

## Phase 4.8 — Wire overlay + pipeline to config, via the sidecar

Make settings changes take effect live, with keys never crossing the renderer. *(merges desktop-app Phase 4 + the "drop the dev backend" step — reconciled to the 4.0 sidecar transport, NOT the old desktop plan's `start`-message-carries-`apiKey` path.)*

- [ ] **App owns the sidecar:** the widget spawns the bundled Node backend as a Tauri sidecar; **Rust reads the Keychain and passes the selected keys to it via env/stdin** — the renderer never sees a key. The webview streams mic PCM over loopback as today. `apps/backend` remains an optional standalone proxy, clearly marked; the default run path no longer needs a manual `npm run`. Update `npm run widget` so the sidecar lifecycle is automatic.
- [ ] **Live re-config:** on `config-changed`, the overlay re-registers the hotkey and the next dictation session uses the selected STT/correction provider + model + language. The `start` message carries **only** non-secret session config (provider/model/language) — the key is resolved Rust-side into the sidecar.
- **Acceptance:** switching provider/model/hotkey/language in settings changes overlay behaviour **without a restart** and **without any key passing through the webview**.

## Phase 4.9 — Slim the overlay

- [ ] Delete the inline settings panel from `index.html`/`main.ts`/`style.css`; the overlay becomes purely orb + card + inject. Gear → `show_settings_window`.
- **Acceptance:** overlay has no settings UI; all config is in the settings window; nothing regressed (still streams + injects, still non-key).

## Phase 4.10 — Wire-up, docs & exit demo

- [ ] Switch STT and correction vendors **at runtime from settings**; confirm the running pipeline picks up the change.
- [ ] Update docs: confirm the [verify] items in `vendor-apis.md`, refresh `README`, `.env.example` (all four vendor keys), `docs/architecture/overview.md` (two-window shell), and `STATUS.md`.
- [ ] Full test pass green in cloud (all adapters vs mock servers) + `typecheck`. **Rust note:** all `src-tauri` changes must be `cargo build` / `npm run widget`-verified on the Mac before sign-off (they can't be compiled in the cloud authoring env). TS typechecks with `npx tsc --noEmit`.
- [ ] **Exit demo on the Mac:** open the **settings window**, **type** a key, capture an arbitrary hotkey; run a full dictation with **each valid combination** (PyAI, Deepgram, OpenAI STT × PyAI/OpenAI/Anthropic correction); switch vendors from settings mid-session; restart the app and confirm keys persist in the keychain; dictate a **non-English** sentence via Deepgram/OpenAI; confirm the overlay still injects while settings is open and closing settings doesn't quit the app.

---

## Files likely to change

- `apps/widget/src-tauri/tauri.conf.json` — add the `settings` window.
- `apps/widget/vite.config.ts` — multi-page (add `settings.html` input).
- `apps/widget/settings.html` + `apps/widget/src/settings.ts` — **new** settings UI.
- `apps/widget/src-tauri/src/main.rs` — `show_settings_window` + activation-policy switch; config store module (`get_config`/`set_config`, `config-changed`, migrate hotkey file); keychain `set_key`/`has_key`/`delete_key` (fold in `key_*`, `get|set_toggle_hotkey`, `ax_trusted`); sidecar spawn + key hand-off; tray/gear rewiring.
- `apps/widget/index.html` / `src/main.ts` / `src/style.css` — remove the inline settings panel (4.9); gear → open settings window.
- `packages/core/...` — Deepgram/OpenAI/Anthropic adapters; localized prompts in `prompt.ts`; optional `sttModel`/`correctionModel` on `AppSettings` when the 4.7 dropdowns land. *(The core config/capability layer — `settings.ts` — is already done in 4.1.)*
- `apps/backend/src/server.ts` — accept keys via env/stdin from the Rust host (sidecar); read provider/model/language from the `start` payload (no key in the payload).
- Docs — `vendor-apis.md` (OpenAI model ids), `overview.md` (two-window shell), `README`, `.env.example`, `STATUS.md`.

---

## Exit criteria for M4

The app is a **menu-bar app with a focusable settings window**: you can **type** a key and capture an arbitrary hotkey there while the overlay keeps injecting and never steals focus. You can switch STT **and** correction vendors (and their models) from settings; keys **persist in the OS keychain** across restarts and **never pass through the renderer**; the app runs correctly with **any valid combination** (including a mixed pair like Deepgram STT + Anthropic correction); non-English dictation works through a multilingual STT vendor. The dev backend is no longer required to run (the app owns a bundled sidecar).

---

## Risks

1. **Activation-policy toggle (window split)** — an Accessory→Regular switch must give the settings window keyboard focus while the overlay panel stays non-key and keeps injecting. → **4.2 on-device acceptance**; the overlay must never be made focusable to "fix" typing.
2. **WS header-auth in the webview** — the load-bearing transport unknown. Browsers can't set WS `Authorization` headers; PyAI is header-only. → resolved in **4.0** (Rust-managed sidecar keeps keys out of the renderer); 4.8 must not regress to a renderer key-path.
3. **OpenAI Realtime [verify]** — confirmed in 4.0; batch Whisper is a fallback for finalize if Realtime slips.
4. **Keychain friction on macOS** — unsigned dev builds may re-prompt / lose the keychain item on rebuild. → test with a stable-identity build early (shares the M3 signing note).
5. **Cost / rate-limit divergence** across vendors — segment-level (not continuous) correction keeps call volume low; keep the telemetry hooks from the plan §8.
6. **Multilingual prompt quality** — localized cleanup/format may regress vs the tuned English `FORMAT_PROMPT`. → keep English as the tuned default; treat other locales as best-effort in M4.
7. **Structured-output parity** — three different structured-output mechanisms (OpenAI `json_schema`, Anthropic `tool_use`, PyAI JSON-in-text). All must reduce to the same compact-edits schema; the shared reconstructor + `valid` fallback already guard malformed output.

---

## Sequencing

`4.0 decisions (gate) → 4.1 config/capability (core) → 4.2 settings window → 4.3 config store + keychain (backbone) → { 4.4 Deepgram · 4.5 OpenAI · 4.6 Anthropic } in parallel → 4.7 settings UI + multilingual → 4.8 wire overlay+pipeline via sidecar → 4.9 slim the overlay → 4.10 wire-up + exit demo`

**Done:** 4.0, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6 (see *Progress at a glance* above) — **all three vendor adapters complete**. **Remaining:** 4.7 (settings UI + multilingual), 4.8 (sidecar wiring), 4.9 (slim overlay), 4.10 (exit demo). **4.7 needs 4.2** (real inputs need the focusable window); the **4.10 exit demo needs the full chain**, including the on-Mac runtime checks still pending for 4.2/4.3 and the live-vendor runs for 4.4/4.5/4.6.
