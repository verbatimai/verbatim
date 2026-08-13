# Settings Audit — Correction Providers (PyAI / OpenAI / Anthropic)

**Scope:** Verify every correction-related setting is wired end-to-end and actually
changes the real vendor request on the authoritative path
(widget config → WS `start` frame → `apps/backend/src/server.ts` `finalize()` →
`packages/core/src/correction/{pyai,openai,anthropic}.ts` + `prompt.ts`).
**Method:** read-only trace. No code changed.
**Date:** 2026-08-13. **Auditor:** verification pass.

Authoritative path note: the backend does NOT use the core `Pipeline`. `server.ts`
`finalize()` calls `correction.correct()` / `correction.format()` directly, gated by
its own `doCorrect` / `doFormat` flags. All provider-agnostic gating therefore lives in
`server.ts` and applies identically to all three providers.

---

## PyAI correction verdict

PyAI correction is **substantially correct on the request it sends, but its per-user
model override is a dead setting — and doubly so.** The adapter
(`packages/core/src/correction/pyai.ts`) hits the right endpoint (`POST {PYAI_BASE}/messages`,
default `https://api.pyai.com/v1/messages`), uses the right model default (`gpt-5.6-sol`),
and correctly uses JSON-in-text mode rather than forced tool-use (matching finding F1 in
`docs/research/pyai-api-findings.md`, where tool-use 503s). The `correct` toggle, `format`
toggle + `localFormat` fallback, `vocabulary` (into the FORMAT prompt), and `language`
(non-English note) all reach the PyAI request correctly. The gap is `correctionModel`: it
is a real config field (Rust `correction_model`, Settings input `correctionModel`) that is
**never sent on the `start` frame, never read by `server.ts`, and never injected into the
sidecar env**, so `pyai.ts` always falls back to `process.env.PYAI_MODEL ?? "gpt-5.6-sol"`.
Even if it were wired, PyAI **silently ignores the `model` param** (findings-doc F4), so for
PyAI specifically the dropdown could never take effect regardless. API key reaches the
adapter via the Rust host injecting `PYAI_API_KEY` into the sidecar env. Telemetry for the
correction phase is metadata-only (counts + provider ids, no transcript text).

---

## Matrix

Legend: ✅ wired & effective · ⚠️ works but caveat · ❌ broken/dead · N-A not applicable.
Cells cite `file:line`.

| Setting | PyAI | OpenAI | Anthropic |
|---|---|---|---|
| **correct toggle** (skip cleanup pass) | ✅ gated in `server.ts:133` (provider-agnostic) | ✅ same gate `server.ts:133` | ✅ same gate `server.ts:133` |
| **format toggle** (skip LLM format AND localFormat) | ✅ `server.ts:152` skips both format() and localFormat fallback | ✅ same gate `server.ts:152` | ✅ same gate `server.ts:152` |
| **vocabulary → FORMAT prompt** | ✅ `server.ts:156` → `format(…, vocabulary)` `pyai.ts:67,75` → `formatMessage` → `vocabularyNote` `prompt.ts:51-57` | ✅ `openai.ts:110,118` same path | ✅ `anthropic.ts:73,80` same path |
| **vocabulary → CORRECT prompt** (parity, harmless) | ⚠️ passed `server.ts:136` → `userMessage` `pyai.ts:54`; system prompt forbids re-spelling (by design) | ⚠️ `openai.ts:93` same | ⚠️ `anthropic.ts:60` same |
| **language** (non-English note in correct+format prompts) | ✅ `server.ts:136,156` forward `langTag`; `languageNote` `prompt.ts:41-42` | ✅ `openai.ts:93,118` | ✅ `anthropic.ts:60,80` |
| **correction_model override** | ❌ never sent on start frame (`main.ts:336-348`), never read in `server.ts`, never injected to sidecar (`main.rs:508-518`); adapter reads only `process.env.PYAI_MODEL` `pyai.ts:46,68`. Also PyAI ignores `model` (F4). | ❌ same wiring gap; adapter reads only `process.env.OPENAI_CORRECTION_MODEL` `openai.ts:85,111` | ❌ same wiring gap; adapter reads only `process.env.ANTHROPIC_MODEL` `anthropic.ts:53,74` |
| **API key** reaches adapter | ✅ Rust injects `PYAI_API_KEY` into sidecar env `main.rs:502,513-516`; adapter ctor reads it `pyai.ts:17` | ✅ `OPENAI_API_KEY` same path `openai.ts:56` | ✅ `ANTHROPIC_API_KEY` same path `anthropic.ts:35` |
| **correction key pre-check** before finalize | ⚠️ none in `server.ts` (only STT key checked `server.ts:234-238`); 401 surfaces at finalize | ⚠️ same | ⚠️ same |
| **telemetry** = metadata only (no transcript) | ✅ `server.ts:172-182,241` emit counts/ids only | ✅ same | ✅ same |
| **endpoint / structured-output shape** | ✅ `/v1/messages`, JSON-in-text (F1-correct) `pyai.ts:21-22,59-61` | ✅ `/v1/chat/completions` + strict `json_schema` `openai.ts:60-61,95` | ✅ `/v1/messages` + forced tool-use `anthropic.ts:38-39,61-62` |

---

## Findings

### [HIGH] `correctionModel` override is a dead setting for all three correction providers
**Root cause:** The setting exists and is persisted —
- UI: `apps/widget/src/settings.ts:13,53,246,260` (input `correctionModel`, saved on blur).
- Store: `apps/widget/src-tauri/src/main.rs:116` (`correction_model: String`), default empty `main.rs:141`.

…but the value never reaches a request. The widget `start` frame explicitly enumerates the
fields it forwards and `correctionModel`/`model` is **not** among them
(`apps/widget/src/main.ts:336-348`). `server.ts` never reads any model from the start frame
and never passes a model into `getCorrectionProvider()` or `correct()`/`format()`
(`apps/backend/src/server.ts:127-166,205,220-231`). The adapters accept no model argument —
`correct()`/`format()` read the model **only** from `process.env` with a hardcoded default:
- `pyai.ts:46,68` → `process.env.PYAI_MODEL ?? "gpt-5.6-sol"`
- `openai.ts:85,111` → `process.env.OPENAI_CORRECTION_MODEL ?? "gpt-4o-mini"`
- `anthropic.ts:53,74` → `process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5"`

And the Rust sidecar env injector (`main.rs:508-518`, `inject_keys`) injects only
`HOST`, `PORT`, `HEAR_DEBUG`, and the four `VENDOR_KEYS` — it never maps `correction_model`
onto `PYAI_MODEL`/`OPENAI_CORRECTION_MODEL`/`ANTHROPIC_MODEL`. So there is **no path** from
the user's chosen model to any adapter. This is the same bug class as the auto-detect
exemplar: wired in config/UI, absent on the authoritative request path.

**User impact:** Changing the correction model in Settings silently does nothing; the app
always uses the built-in default per provider. Highest severity because it is a UI control
that misrepresents behavior (and affects cost/quality/repeatability for OpenAI/Anthropic,
where the model genuinely varies).

**Fix (choose the config-driven path, mirror it for `sttModel`):**
1. `main.ts` start frame: add `correctionModel: cfg.correctionModel`.
2. `server.ts` `start` handler: read `msg.correctionModel` (validate non-empty string) into a
   `corrModel` var.
3. Thread it into the adapter. Cleanest: add an optional ctor arg / `model` field to each
   correction adapter and have `correct()`/`format()` prefer it over `process.env`. Then
   `getCorrectionProvider(corrId, { model: corrModel })`. (Passing per-request via
   `CorrectionContext.model` also works for `correct()` but `format()` would need the same
   param.)
**PyAI caveat:** even after wiring, PyAI ignores the `model` param and always answers with
`gpt-5.6-sol` (`docs/research/pyai-api-findings.md` F4). So for PyAI the fix restores intent
but has no live effect until PyAI honors the param; the override is meaningful for
OpenAI/Anthropic.

### [LOW] No correction-key pre-check on the backend; missing key fails only at finalize
**Root cause:** `server.ts` validates the **STT** key presence before starting
(`server.ts:234-238`) but never checks the correction provider's key. `assertCorrectionKeys`
(`packages/core/src/correction/registry.ts:34-44`) and `assertCapability`
(`packages/core/src/settings.ts:122`) exist but are not called on the backend path — the
adapter constructs with `apiKey = process.env.X ?? ""` and a missing key surfaces as a vendor
401 during `finalize()` (logged via `logPyaiError`, banner shown).
**User impact:** Low. The Settings UI already warns via `capabilityErrors()`
(`settings.ts` ~line 105) and a live 401 is logged with copy-details. But the user records a
whole dictation before learning the correction key is absent.
**Fix:** call `assertCorrectionKeys(correction)` right after resolving `correction` in the
`start` handler and emit an early `error` (parallel to the STT check).

### [INFO] `vocabulary` is intentionally injected into BOTH correct() and format()
`server.ts:136` passes `vocabulary` into `correct()` for parity even though the correction
SYSTEM_PROMPT forbids re-wording (`prompt.ts:6-17`). This is by design (comment
`server.ts:135`, `types.ts:37-41`) and consistent across all three providers; the effective
lever is the FORMAT prompt (`prompt.ts:51-57`). No action — noted so it isn't mistaken for a
leak of terms into a prompt that can't use them.

### [INFO] Correction telemetry is metadata-only (spot check passed)
`session_start` (`server.ts:241`), `session_finalize` (`server.ts:172-182`), and error events
(`server.ts:141,159`) emit provider ids, `language`, `autoDetect`, `correct`, `format`, and
character **counts** (`rawLen`, `cleanLen`) — never transcript, edits, vocabulary terms, or
instruction text. Consistent for all three providers.

---

## Per-setting notes

- **correct toggle:** `doCorrect = msg.correct !== false` (`server.ts:209`); `if (doCorrect)`
  guards the only `correction.correct()` call (`server.ts:133-144`). When off, no `correct()`
  call and no `correction` message; `cleanText = raw`. Provider-agnostic — holds for PyAI,
  OpenAI, Anthropic identically. ✅
- **format toggle:** `doFormat = msg.format !== false` (`server.ts:210`); `if (doFormat)`
  guards BOTH `correction.format()` and the `localFormat()` fallback (`server.ts:152-166`).
  When off, `finalText = cleanText`. ✅ (verified the fallback is inside the `doFormat`
  block, so it is skipped too).
- **vocabulary:** reaches each provider's `format()` request text via `formatMessage` →
  `vocabularyNote` ("Known terms (preserve and spell exactly): …", `prompt.ts:53`). Identical
  wiring across providers. ✅
- **language:** `langTag` (default `"en"`, `server.ts:206`) forwarded to both `correct()` and
  `format()`; `languageNote` appends the "keep output in that same language" instruction for
  any non-English tag (`prompt.ts:29-43`). Identical across providers. ✅
- **API key:** injected into the sidecar env by the Rust host for every present vendor
  (`main.rs:502,513-516`); each adapter's constructor reads its own `process.env.*_API_KEY`
  default. The webview never sends a secret (`main.ts:315-317,416`). ✅

## Unverifiable without a live key / runtime
- Whether PyAI *actually* honors or ignores a supplied `model` today (relied on findings-doc
  F4, dated 11 Aug 2026, sandbox key).
- That OpenAI/Anthropic honor `OPENAI_CORRECTION_MODEL`/`ANTHROPIC_MODEL` overrides at
  runtime (defaults `gpt-4o-mini` / `claude-sonnet-4-5` are plausible but not exercised here).
- End-to-end Rust behavior (`inject_keys`, sidecar spawn) — Rust can't be compiled/run in the
  cloud env; verified by reading source only.
