# Settings — Phase 3 (Wave 3 — "M5 features") Reviewer Cross-Check

**Reviewer pass:** pre-implementation · **Date:** 13 Aug 2026
**Reviews:** `phase-3-plan.md` against the live repo at `/home/claude/verbatim`.
**Scope checked:** 3.1 mic picker · 3.2 auto-detect · 3.3 telemetry (security gate) ·
3.4 vocabulary · 3.5 snippets · config deltas · no content/secret logging.

---

## Verdict: **APPROVED WITH REQUIRED CHANGES**

The plan is accurate against the code — every cited line/anchor I checked is correct
(see "Verification log"). The dual-pipeline lesson is honoured, the PyAI warning is
preserved, and telemetry is genuinely no-op with transport parked. Two substantive
corrections (one design, one completeness) plus a handful of small ones are required
before/while the dev implements; none are blockers. **Dev is cleared to start.** No item
is NEEDS REWORK.

---

## Answers to the three headline questions

1. **Does snippets need the `server.ts` path too? — YES, and the plan already has it.**
   The shipped widget runs the **backend** `finalize` (`apps/backend/src/server.ts:102–160`),
   NOT the core `Pipeline`. The final inserted text is produced at `send(ws, { type:
   "formatted", text: finalText })` (**server.ts:156**). The plan correctly hooks BOTH
   the backend (`finalize`, before line 156) AND core `Pipeline.finalizeOnce`. It did not
   miss the Phase-2 dual-pipeline lesson. (One completeness gap in the CORE path only —
   see correction #2.)

2. **Does auto-detect preserve the PyAI-English warning? — YES.**
   Core `capabilityErrors` raises the PyAI guard at `settings.ts:94–98`; the widget mirror
   at `settings.ts:97–99`. The plan explicitly keeps the warning firing when PyAI + a
   non-English language, adds a distinct "PyAI ignores auto-detect" note, AND greys the
   toggle when `sttProvider==="pyai"` (belt-and-suspenders). A dedicated vitest case
   asserts it. This satisfies risk §10.5.

3. **Is telemetry truly no-op? — YES.**
   The plan builds only: `NoopSink` (the default), an allow-list `sanitize()`, an
   `enabled`-gated `emit()` that returns before any sink/sanitize/allocation when off, and
   an injectable-sink seam with the real transport PARKED behind a TODO. No `fetch`/beacon
   is specified anywhere. The two headline vitest cases (no-op-when-disabled;
   whitelist-only-when-enabled) plus a `sanitize` drop test are specified and runnable in
   core. Nothing logs transcript/audio; counts (`rawLen`/`cleanLen`) not text. **No rework.**

---

## Required corrections (tied to items)

**#1 (3.4, DESIGN — applied inline).** Vocabulary injected into the **correction** prompt
is likely a **no-op** for OpenAI/PyAI. The correction `SYSTEM_PROMPT`
(`prompt.ts:6–17`) is a minimal disfluency pass that says *"DO NOT … change … wording.
DO NOT rephrase"* and limits edits to filler/false_start/self_correction/repetition. A
misheard proper noun is none of those, so the model is instructed NOT to re-spell it.
The effective prompt-side lever for prompt-only vendors is the **FORMAT** pass
(`FORMAT_PROMPT` permits grammar/rewrites). **Thread `vocabulary` into
`formatMessage`/`FORMAT_PROMPT`** (extend `format?(text, language?)` at `types.ts:49`,
which has no ctx today). Deepgram's STT-side `keywords` boost remains the strongest lever.
*(Inline note added under 3.4.)*

**#2 (3.5, COMPLETENESS — applied inline).** The core `Pipeline.finalizeOnce` has **three**
`onFormatted` call sites, not two: `pipeline.ts:264` (LLM-formatted), `:266`
(unformatted/clean), and **`:270` (the `catch` fallback → raw)**. The plan said "264/266"
and missed 270. Route all three through a single `emitFormatted(text)` helper that applies
`expandSnippets` once, so snippets also fire on the error path and the expand call isn't
duplicated. *(Inline note added under 3.5.)*

**#3 (3.2, TEST TARGETING — applied inline).** The plan proposed a new
`packages/core/src/providers/detect.test.ts`. Better: **add the cases to the existing
`deepgram.stt.integration.test.ts` and `openai.stt.integration.test.ts`.** Those files
already contain the mock-ws harnesses the tests need — `mockDeepgram` captures `seen.query`
(assert `detect_language=true` present / `language=` absent), and `mockRealtimeServer`
captures `seen.config` (assert `input_audio_transcription` has no `language` key). They run
a local `ws` server on port 0 (no vendor endpoint, no key), so they ARE in the default
`npm test` today (13/13 files green). A fresh file would only re-implement that harness.
*(Inline note added under 3.2 test checklist.)*

**#4 (3.4/3.5, MINOR).** Overlay `main.ts` builds the WS `start` frame inside `connect()`
(`main.ts:319–336`), which today reads only `get_config` (line 320). Sourcing vocabulary
/snippets means an **extra `await invoke("vocab_list")` / `invoke("snip_list")` in the
`live` path of `connect()`** (or a cached copy). Fetch them in parallel with `get_config`
(`Promise.all`) to avoid adding serial latency to dictation start. The plan mentions the
source but not the placement — do it in `connect()`, `live` mode only (skip for `demo`).

**#5 (3.3, PRODUCT — answer to open Q1).** Since the sink is `NoopSink` and transport is
parked, an ON toggle sends nothing. Keep the toggle **functional (persists the pref) but
honest**: the "what we collect" copy must not imply data leaves the device today. Simplest
safe framing: describe it as what *would* be shared (metadata only, never content) and,
because transport is parked, either keep a small "not yet active" hint or leave it plain —
do NOT word it as if collection is live. Ship it on-able; it's inert.

---

## Answers to the planner's open questions (code-grounded)

1. **Telemetry PARK — agree.** No transport this wave. Ship the toggle on-able but inert
   (NoopSink). Copy must stay honest (see #5).
2. **Deepgram param.** `DEFAULT_MODEL = "nova-2"` (`deepgram.stt.ts:25`), env-overridable
   via `DEEPGRAM_STT_MODEL`. For the shipped default (nova-2) the param is **`keywords`**
   (`keywords=term:intensity`); nova-3 uses **`keyterm`**. The adapter MUST branch on the
   resolved model — a mismatch is a **silent no-op**, not an error. Deepgram-only STT boost
   is acceptable; OpenAI/PyAI are prompt-only (now format-prompt per #1).
3. **Vocab/Snippets vs Reset — leave them.** `clear_config` writes `AppConfig::default()`
   to `settings.json` only (Phase-1 pattern; secrets were deliberately left untouched).
   `vocabulary.json`/`snippets.json` are separate `app.store()` files, so Reset can't touch
   them without new code. Plan's "leave" is consistent and correct. Confirmed.
4. **Entry shape — `string[]` for this wave.** Deepgram `keywords` needs only the term
   string (intensity optional). `{term, soundsLike}` is a future upgrade; don't block the
   UI on it. Confirmed.
5. **Batch path — vendor default is acceptable.** `transcribeBatch(pcm, { apiKey,
   sampleRate? })` (`types.ts:53`) has no language/detect arg, and the widget's
   **authoritative final IS `transcribeBatch`** (`server.ts:108–112`) — and it never passes
   `language`, so batch already auto-detects by default (Whisper/Deepgram prerecorded).
   Net: the streaming `detectLanguage` flag mainly improves the **live preview**; the final
   is already language-agnostic on the widget path. Wiring streaming detect explicitly and
   leaving batch on vendor-default is fine this wave. Call the nuance out in the on-Mac test.
6. **How vocab/snippets reach the backend — WS `start` frame (preferred).** `server.ts`
   never reads the config store; it takes flags on `start` (`server.ts:171–182`). Routing
   the lists the same way keeps the backend store-agnostic. Confirmed. (See #4 for the
   overlay-side fetch placement.)
7. **Snippet ordering — after formatting, on the final text.** Correct for determinism;
   the hook points (core `264/266/270`, backend `156`) are all post-format. Confirmed.
8. **Mic picker has no core vitest — acceptable.** 3.1 is pure webview + a scalar config
   field; the only core-testable logic would be trivial. Cloud gate = widget `tsc --noEmit`
   + static grep; behaviour verified on-Mac. Confirmed.

---

## Cloud-runnable check accuracy

- **No mislabeled cloud check found.** Notably, the 3.2/3.4 STT-adapter vitest cases really
  ARE cloud-runnable: `vitest.config.ts` `include: ["src/**/*.test.ts"]` matches the
  `*.integration.test.ts` files, and those use in-process mock `ws` servers (port 0) — no
  network, no keys. Phase-2 confirms 13/13 files green. Correction #3 just points them at
  the existing harnesses.
- Widget/backend `tsc --noEmit` are the correct cloud gates for the HTML/TS edits (Rust is
  authored-only in the cloud, as the plan states).

---

## Verification log (plan claim → confirmed in code)

- **3.1** Only widget `getUserMedia` = `apps/widget/src/main.ts:371` in `startLive()`;
  `app.ts` does no capture (grep clean; other hits are `apps/web` + docs). `startLive()`
  (368–408) runs BEFORE `connect("live")` (394); `connect()` reads config at 320, so the
  device id must be fetched inside `startLive()`. ✔ Mic `<select disabled>` with no `id`,
  one `System Default` option + `Not in use` tag at `settings.html:282–290`; `settings.ts`
  never references it. ✔ Blank-label-until-permission handling is real (enumerateDevices).
- **3.2** `STTSessionConfig = { apiKey; language? }` (`types.ts:38–41`). ✔ Deepgram
  `if (cfg.language) q.set("language",…)` at `deepgram.stt.ts:47` on the URLSearchParams
  (35–46); `detect_language` is the nova param. ✔ OpenAI `language` in
  `input_audio_transcription` at `openai.stt.ts:85`; ctor takes `language` (44/76). ✔ PyAI
  ignores language (`pyai.stt.ts:21–31`). ✔ Core `capabilityErrors`/`isEnglish`/PyAI guard
  at `settings.ts:65–101/54–57/94–98`; widget mirror `89–101` guard `97–99`. ✔
  `transcribeBatch` lacks a detect/language arg (`types.ts:53`). ✔
- **3.3** No network in the plan; NoopSink default + allow-list sanitize + enabled gate;
  transport parked. Backend has a natural per-connection construction point (`server.ts`
  `wss.on("connection")` 87–). ✔
- **3.4** `userMessage(raw, priorContext?, language?)` at `prompt.ts:105`; all three real
  adapters call it — `pyai.ts:54`, `openai.ts:93`, `anthropic.ts:60`. ✔
  `CorrectionContext = { priorContext?; language? }` (`types.ts:31–36`). ✔ Core `Pipeline`
  `correct(raw, { language })` at `pipeline.ts:256`; backend `correction.correct(raw)`
  with NO ctx at `server.ts:127`. ✔ Deepgram default model nova-2 → `keywords`
  (`deepgram.stt.ts:25`); OpenAI/PyAI have no boost param. ✔ Store pattern: `read_config`/
  `write_config` over `app.store(STORE_FILE)` (`main.rs:148–168`); `secrets.rs`
  separate-file model; `generate_handler!` at `main.rs:1022–1045`. ✔
- **3.5** Two finalize impls: core `finalizeOnce` (`pipeline.ts:245–274`, vitest-exercised)
  + backend `finalize` (`server.ts:102–160`, the shipped path). ✔ `PipelineOptions`
  (`pipeline.ts:39–42`). ✔ (Third `onFormatted` at 270 — correction #2.)
- **Config deltas** `AppConfig` struct `main.rs:108–124` + `Default` `126–146` under
  `#[serde(rename_all="camelCase", default)]` (old stores load); TS mirror
  `settings.ts:9–25`; init/refresh pattern `initDebug` 512–516, `refreshControls` 536–548,
  `DOMContentLoaded` 571–591. ✔ Rows: auto-detect `268–281`, mic `282–290`, telemetry
  `566–576`, vocab pane `502–520`, snippets pane `522–537`. ✔
- **No content/secret logging / `.env` read** introduced by any step. Backend already gates
  verbose lines on `HEAR_DEBUG` and never logs keys; telemetry emits counts, not text. ✔

---

## Go / no-go: **GO** — MUST-follow bullets

- **[MUST] 3.4:** inject vocabulary into the **FORMAT** prompt for OpenAI/PyAI (correction
  prompt forbids wording changes → likely no-op). Deepgram `keywords` stays the STT lever.
- **[MUST] 3.4:** branch the Deepgram param on the resolved `DEEPGRAM_STT_MODEL`
  (`keywords` for nova-2, `keyterm` for nova-3) — mismatch is a silent no-op.
- **[MUST] 3.5:** apply `expandSnippets` at ALL THREE core `onFormatted` sites
  (264/266/**270**) via one `emitFormatted` helper, AND at backend `server.ts:156`.
- **[MUST] 3.3:** ship telemetry as no-op only — `NoopSink` default, allow-list `sanitize`,
  enabled-gated `emit`, transport PARKED behind a TODO. NO `fetch`/beacon. Copy stays honest.
- **[MUST] 3.2:** keep the PyAI-English warning firing under auto-detect (both core + widget
  mirror); grey the toggle when STT=pyai.
- **[MUST]** vocab/snippets ride the WS `start` frame; overlay fetches them in `connect()`
  **live mode only**, in parallel with `get_config` (no serial start-latency).
- **[MUST]** add `#[serde(default)]`-covered fields only (`mic_device_id`,
  `auto_detect_language`, `telemetry`) to `AppConfig`+`Default`+TS mirror; vocabulary/
  snippets are separate stores, NOT config; register new `vocab_*`/`snip_*` commands in
  `generate_handler!`.
- **[MUST]** no step logs transcript/audio/secret content or reads `.env`; Reset leaves the
  two list stores intact.
- **[SHOULD]** add detect/vocab cases to the existing `*.integration.test.ts` harnesses,
  not a new file; keep `npm test` green (currently 83/83).
