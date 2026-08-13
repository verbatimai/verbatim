# M4 — Multi-Vendor + Configuration: Task Breakdown

**Goal (North-Star slice):** deliver on the two promises the architecture was built for — **vendor-agnostic** STT/correction and **BYOK, local-only** keys. From a settings screen the user picks an STT vendor and a correction vendor **independently** (mix-and-match), enters keys that persist in the **OS keychain**, optionally picks a **language**, and the widget runs the exact M2/M3 pipeline against whatever valid combination they chose — with **no dev backend** in the default path.

**Why now:** M0–M2 are done and M3's exit criteria are essentially met (hotkey → dictate over a 3rd-party app → corrected text inserted → widget never steals focus → password fields refused). The one M3 item deliberately deferred as "M4-flavoured" was **Phase 3.5 (keychain BYOK)** — M4 absorbs it as its backbone, because keychain + client-direct calls are what let us drop the dev backend and ship the open-core "local, no server" model.

---

## What already exists (starting point — don't rebuild)

- **Interfaces are locked** (`packages/core/src/providers/types.ts`, `correction/types.ts`): `STTProvider` / `STTSession` / `TranscriptEvent {stableText, activeText, endpoint}`, and `CorrectionProvider` with the compact-edits `CorrectionResult`. Nothing above the adapter boundary references a vendor.
- **Registries + factory exist** (`providers/registry.ts`, `correction/registry.ts`): add a vendor = one line. `STT_PROVIDER` / `CORRECTION_PROVIDER` env selection already resolved through them.
- **Capability check exists on the STT side** — `assertKeys(provider)` fails fast on missing keys. (Correction registry has **no** `assertKeys` yet — 4.1.)
- **`language` is already on `STTSessionConfig`** — plumbing exists, just not wired to settings or prompts.
- **Deepgram STT adapter is ~60% built** (`providers/deepgram.stt.ts`): interim/`is_final`/`UtteranceEnd` → stable/active/endpoint mapping is coded, but it uses a Node-`ws` `Authorization` header (won't work from a browser/webview), has no endpointing/`utterance_end_ms` tuning, and has **no tests**.
- **OpenAI and Anthropic adapters are commented-out stubs** in both registries — net-new.
- **Research is done** (`docs/architecture/vendor-apis.md`, `multilingual.md`): Deepgram + Anthropic confirmed live; OpenAI Realtime URL/beta header marked **[verify]**.

So M4 is **finish one adapter, add three, add a keychain + settings layer, and localize prompts** — all behind interfaces that already exist.

---

## Phase 4.0 — Design spike / decisions (do FIRST, de-risk)

The one real unknown that can reshape the build. Resolve before writing adapter code.

- [ ] **Decide the WS-auth transport for client-direct STT.** Browsers/webviews **cannot set WebSocket `Authorization` headers**. PyAI Hear and Deepgram both authenticate via header today; Deepgram also supports a **token subprotocol** (`["token", KEY]`), OpenAI Realtime uses a query/beta-header path. Three viable models — pick one and document it:
  - **(A) Rust-side STT client (recommended).** The widget already has a Rust core; run the STT WebSocket **in Rust** (it can set headers, holds the keychain key, never exposes it to the webview) and bridge normalized `TranscriptEvent`s to the webview over the existing Tauri event channel. Cleanest security story; biggest Rust lift.
  - **(B) Subprotocol/query auth from the webview.** Works for Deepgram (subprotocol) and OpenAI (query), **not** for PyAI-header-only — would keep a thin local proxy for PyAI. Least Rust, but leaks keys into the renderer.
  - **(C) Keep `apps/backend` as an optional local proxy.** Simplest, but contradicts "drop the dev backend" as the default. Reserve as the commercial hosted-proxy path (per plan §13), not the OSS default.
- [ ] **Confirm the [verify] items** from `vendor-apis.md`: OpenAI Realtime WS URL + `intent=transcription` + beta header; Anthropic forced-tool-use for structured ops (works natively — PyAI's tool-use 503 is a PyAI-only limitation, F1).
- [ ] **Lock the settings/config schema** (`AppSettings`): `{ sttProvider, correctionProvider, language, keys: Record<vendor,string> }` — one shape shared by core, Rust keychain, and the settings UI.

**Gate:** the WS-auth decision (A/B/C) is documented in `docs/architecture/` before 4.3–4.5, because it determines where each STT adapter's socket lives.

---

## Phase 4.1 — Config & capability layer (core)

Make provider selection first-class and independent for the two roles.

- [ ] `AppSettings` type + a small resolver that builds the STT provider and the correction provider **independently** from settings (mix-and-match, e.g. Deepgram STT + Anthropic correction).
- [ ] Add `assertKeys` to the **correction** registry (mirror the STT side) and a single `assertCapability(settings)` that validates the *selected combination* and **fails fast with one clear message** listing every missing key.
- [ ] Plumb `language` end-to-end: settings → `STTSessionConfig.language` → correction/format prompt locale (see 4.6).
- [ ] Unit tests: unknown provider id, missing-key messages, valid mix-and-match resolution.

## Phase 4.2 — Keychain BYOK (absorbs M3 Phase 3.5) — the backbone

- [ ] Rust **`keyring`** integration: store / read / delete per-vendor keys (`PYAI_API_KEY`, `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). Never plaintext to disk, never bundled, never logged.
- [ ] Tauri commands: `set_key(vendor, value)`, `has_key(vendor)`, `delete_key(vendor)`, and the guarded hand-off (`get_key` → webview, **or**, under 4.0-A, keys stay in Rust and only `TranscriptEvent`s cross the boundary).
- [ ] **Drop the dev backend from the default run path**: the widget calls vendors directly (per 4.0). `apps/backend` remains an optional proxy, clearly marked. Update `npm run widget` accordingly.
- [ ] Verify keys **persist across app restarts** and survive a rebuild (part of the exit demo).

## Phase 4.3 — Finish the Deepgram STT adapter

- [ ] Apply the 4.0 auth decision (subprotocol token from webview, or Rust-side socket).
- [ ] Add endpointing: `endpointing`, `utterance_end_ms>=1000`, `smart_format`/`punctuate`; confirm `speech_final` + `UtteranceEnd` both map to our segment boundary (`endpoint:true`).
- [ ] **Integration test vs a Deepgram mock server** (mirror `providers/pyai.integration.test.ts`): auth handshake, interim → `activeText`, `is_final` → `stableText`, `UtteranceEnd` → final+endpoint. Green in cloud, no network.

## Phase 4.4 — OpenAI adapters (STT + correction)

- [ ] **STT — Realtime WS** adapter: 24 kHz mono resample, base64 `input_audio_buffer.append`, `server_vad`, `...transcription.delta`→active / `.completed`→stable+endpoint → `TranscriptEvent`. Plus **batch Whisper** (`POST /v1/audio/transcriptions`) for `transcribeBatch` (the finalize path).
- [ ] **Correction** adapter via `POST /v1/chat/completions` with strict `response_format:{type:"json_schema", strict:true}` → the compact-edits schema; reuse `prompt.ts` + the shared reconstructor unchanged.
- [ ] Mock-server integration tests for both (auth, event parse, mapping, reconstruct-validates).

## Phase 4.5 — Anthropic correction adapter

- [ ] `POST /v1/messages` with **forced tool-use** (`emit_correction` tool, `input_schema` = compact-edits schema, `tool_choice:{type:"tool"}`) → parse the `tool_use` block's `input`; reuse the shared reconstructor. This is the "structured ops done right" path (native tool-use, unlike PyAI's JSON-in-text workaround).
- [ ] Mock-server integration test (tool_use response → edits → `reconstruct` valid).

*(4.3 / 4.4 / 4.5 have no interdependencies once 4.0 + 4.1 land — they can be built in parallel against mock servers using dev `.env` keys, before or alongside 4.2.)*

## Phase 4.6 — Provider selection UI + multilingual

- [ ] **Settings screen** in the widget: choose STT vendor, correction vendor (independent dropdowns = mix-and-match), and language; enter/clear keys per vendor (→ 4.2 keychain). Live **capability check** with a clear inline error when a combination is missing a key.
- [ ] **Multilingual:** add the `language` setting; **localize the cleanup + format prompts** in `prompt.ts` (or instruct the model to "respond in the transcript's language"). PyAI Hear is **English-only** → when a non-English language is chosen on PyAI, show a clear **"English-only on PyAI — pick Deepgram/OpenAI for this language"** guard (don't silently fail).
- [ ] Startup capability check surfaced in the UI (not just a thrown error).

## Phase 4.7 — Wire-up, docs & exit demo

- [ ] Switch STT and correction vendors **at runtime from settings**; confirm the running pipeline picks up the change.
- [ ] Update docs: confirm the [verify] items in `vendor-apis.md`, refresh `README`, `.env.example` (all four vendor keys), and `STATUS.md`.
- [ ] Full test pass green in cloud (all adapters vs mock servers) + `typecheck`.
- [ ] **Exit demo on the Mac:** run a full dictation with **each valid combination** (PyAI, Deepgram, OpenAI STT × PyAI/OpenAI/Anthropic correction), switch vendors from settings mid-session, restart the app and confirm keys persist in the keychain, and dictate a **non-English** sentence via Deepgram/OpenAI.

---

## Exit criteria for M4

Switch STT **and** correction vendors from the settings screen; keys **persist in the OS keychain** across restarts; the app runs correctly with **any valid combination** (including a mixed pair like Deepgram STT + Anthropic correction), and non-English dictation works through a multilingual STT vendor. The dev backend is no longer required to run.

---

## Risks

1. **WS header-auth in the webview** — the load-bearing unknown. Browsers can't set WS `Authorization` headers; PyAI is header-only. → **Phase 4.0 gate** (favour the Rust-side STT client, which also keeps keys out of the renderer).
2. **OpenAI Realtime [verify]** — URL / `intent=transcription` / beta header unconfirmed from a live doc. → confirm in 4.0; batch Whisper is a fallback for finalize if Realtime slips.
3. **Keychain friction on macOS** — unsigned dev builds may re-prompt / lose the keychain item on rebuild. → test with a stable-identity build early (shares the M3 signing note).
4. **Cost / rate-limit divergence** across vendors — segment-level (not continuous) correction keeps call volume low; keep the telemetry hooks from the plan §8.
5. **Multilingual prompt quality** — localized cleanup/format may regress vs the tuned English `FORMAT_PROMPT`. → keep English as the tuned default; treat other locales as best-effort in M4.
6. **Structured-output parity** — three different structured-output mechanisms (OpenAI `json_schema`, Anthropic `tool_use`, PyAI JSON-in-text). All must reduce to the same compact-edits schema; the shared reconstructor + `valid` fallback already guard malformed output.

---

## Sequencing

`4.0 decisions (gate) → 4.1 config/capability → 4.2 keychain (backbone) → { 4.3 Deepgram · 4.4 OpenAI · 4.5 Anthropic } in parallel → 4.6 settings UI + multilingual → 4.7 wire-up + exit demo`

Adapters (4.3–4.5) can be developed and tested against mock servers as soon as 4.0 + 4.1 land, without waiting on 4.2; but the **exit demo** needs 4.2 (keychain) and 4.6 (UI) complete. Only start each phase once the previous is demoable; **4.0 is a hard gate** because the WS-auth decision determines where every STT socket lives.
