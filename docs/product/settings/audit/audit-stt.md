# STT Settings Audit — end-to-end wiring verification

**Scope:** Verify every settings change is correctly wired end-to-end for the STT providers (PyAI → Deepgram → OpenAI) and actually reaches the real vendor API on BOTH the streaming (live-preview) path AND the authoritative **batch/finalize** path (`transcribeBatch`, which produces the inserted text).

**Method:** traced widget config → WS `start` frame (`apps/widget/src/main.ts`) → `apps/backend/src/server.ts` (start handler + `finalize()`/`transcribeBatch` call) → adapter (`packages/core/src/providers/{pyai,deepgram,openai}.stt.ts`) → the actual request params. PyAI correctness grounded in `docs/research/pyai-api-findings.md` (F6/F7/F8/F10) + `docs/architecture/vendor-apis.md`.

**Read-only audit — no code changed.**

---

## PyAI STT verdict (priority)

**PyAI STT is correctly wired for every setting that applies to it, but the story is simple because PyAI Hear is English-only and single-model.** The streaming endpoint (`wss://api.pyai.com/v1/audio/transcriptions/stream?model=pyai-hear&sample_rate=16000&encoding=pcm_s16le&channels=1`, Bearer auth, raw PCM, no start frame — `pyai.stt.ts:26-33`) and the batch endpoint (`POST /v1/audio/transcriptions`, multipart `model=pyai-hear` + `file`, returns `body.text` — `pyai.stt.ts:39-53`) both match the reverse-engineered protocol in the findings report (F8, F7, Appendix). `language`, `detectLanguage`, and `keywords` are **intentionally ignored** on both paths because Hear is English-only and has no keyword-boost param (F6) — and that limitation is **properly guarded in the UI**: `capabilityErrors()` raises a blocking notice when `sttProvider==="pyai"` and the language isn't English (`settings.ts:122-123`), and the auto-detect toggle is disabled for PyAI (`settings.ts:627-633`). The API key (`PYAI_API_KEY`) flows correctly (inject_keys → env → `server.ts:234` → `cfg.apiKey` → Bearer). The **only** PyAI gap is shared with the other vendors: the `sttModel` override is dead — but for PyAI this is effectively N/A since `pyai-hear` is the sole STT model and is hardcoded (`pyai.stt.ts:29,43`). **Net: PyAI STT settings are correct; no PyAI-specific bug found.**

---

## Matrix

Legend: ✅ effective · ⚠️ partial · ❌ broken · N/A not applicable. `S`=streaming path, `B`=batch/finalize path.

| Setting | PyAI | Deepgram | OpenAI |
|---|---|---|---|
| **language** (fixed) | N/A — English-only, ignored by design; UI-guarded `settings.ts:122,281` | ✅ S `deepgram.stt.ts:56-58` · ✅ B `deepgram.stt.ts:89-91` | ✅ S `openai.stt.ts:92` · ✅ B `openai.stt.ts:59-61` |
| **auto_detect_language** | N/A — ignored; toggle disabled + capability error `settings.ts:122-123,627-633`; adapter `pyai.stt.ts:22-25` | ✅ S `language=multi` `deepgram.stt.ts:54-56` · ✅ B `detect_language=true` `deepgram.stt.ts:87-88` | ✅ S omit-language `openai.stt.ts:92` · ✅ B omit-language `openai.stt.ts:59` |
| **vocabulary** (STT keyword boost) | N/A — no STT param; still used in format prompt `server.ts:136,156` | ⚠️ S only `deepgram.stt.ts:62-68` · ❌ B — `transcribeBatch` omits keywords `deepgram.stt.ts:78-102`; **final=batch ⇒ boost is a no-op on inserted text** | N/A — no STT boost param `types.ts:52-55` |
| **stt_model** override | ❌ dead / N/A — hardcoded `pyai-hear`, no env or config path `pyai.stt.ts:29,43` | ❌ dead — adapter reads only `process.env.DEEPGRAM_STT_MODEL` `deepgram.stt.ts:34,80`; never set from `config.sttModel` | ❌ dead — adapter reads only `process.env.OPENAI_STT_MODEL` `openai.stt.ts:37`; never set from `config.sttModel` |
| **mic_device_id** | ✅ webview `getUserMedia` `main.ts:386-393` (N/A to adapters) | ✅ same | ✅ same |
| **API key** | ✅ `PYAI_API_KEY` inject→env→`server.ts:234`→Bearer `pyai.stt.ts:32,47` | ✅ `DEEPGRAM_API_KEY` `deepgram.stt.ts:70,94` | ✅ `OPENAI_API_KEY` `openai.stt.ts:40,63` |

---

## Findings

### [SEV: high] `sttModel` (STT model dropdown) is a fully dead setting — never reaches the adapter on either path

**Root cause (the value dead-ends at every hop):**
- UI persists it: `settings.ts:259` (`sttModelEl.onblur → patchConfig({ sttModel })`), stored as `AppConfig.stt_model` (`main.rs:115`).
- **Sidecar env injection does NOT set it:** `inject_keys()` injects only `HOST`, `PORT`, `HEAR_DEBUG`, and the four vendor API keys — never `DEEPGRAM_STT_MODEL` / `OPENAI_STT_MODEL` / `PYAI_STT_MODEL` (`main.rs:508-518`).
- **Start frame does NOT send it:** the widget's `start` message carries `sttProvider, correctionProvider, language, correct, format, autoDetect, vocabulary, snippets, telemetry` — no `sttModel`/`model` (`main.ts:336-348`).
- **Backend does NOT read it:** the `start` handler never reads `msg.sttModel` and never passes a `model` to `startSession`/`transcribeBatch` (`server.ts:198-245, 119`).
- **Contract has no slot for it:** `STTSessionConfig` has no `model` field, and `transcribeBatch(...)`'s `cfg` has no `model` (`types.ts:38-56, 68`).
- Adapters therefore fall back to `process.env.*_STT_MODEL ?? DEFAULT_MODEL` every time (`deepgram.stt.ts:34,80`; `openai.stt.ts:37`). The env vars are only settable via a hand-edited `.env` / shell — never from the app.

**Why it fails:** A user who picks a non-default STT model in Settings (e.g. Deepgram `nova-3`, or an OpenAI transcription model) gets it silently ignored on the **authoritative final path** — the adapter always uses `nova-2` / `gpt-live-transcribe` / `gpt-transcribe`. The dropdown looks functional and persists, so this is invisible. (Note: the code comments at `deepgram.stt.ts:22-23` and `openai.stt.ts:22` explicitly claim the env var backs "the 4.7 model dropdown" — but nothing threads the dropdown to that env var, so the comment is aspirational.) Affects Deepgram + OpenAI on both streaming and batch. PyAI is N/A (single hardcoded model) but the field is equally dead for it.

**Recommended fix (pick one, must reach BOTH `startSession` AND `transcribeBatch`):**
- **Preferred (no restart):** add `model?: string` to `STTSessionConfig` and to `transcribeBatch`'s `cfg`; send `sttModel` on the start frame (`main.ts`), read `msg.sttModel` in `server.ts` and thread it into both `startSession({..., model})` and `transcribeBatch(pcm, {..., model})`; in each adapter use `cfg.model ?? process.env.*_STT_MODEL ?? DEFAULT_MODEL`. (Deepgram's `keywords`/`keyterm` branch keys off the resolved model, so the per-user model must resolve before that branch — another reason to thread it in rather than rely on env.)
- **Alternative (restart-based):** in `inject_keys()` map `config.stt_model` → the correct `*_STT_MODEL` env var based on `config.stt_provider`, and `restart_backend` on change (parity with how keys/debug already work).

---

### [SEV: med] Deepgram vocabulary keyword-boost never applies to the authoritative (batch) output

**Root cause:** `startSession` applies the STT keyword boost — `keywords` (nova-2) / `keyterm` (nova-3) — on the **streaming** socket (`deepgram.stt.ts:62-68`), but `transcribeBatch` builds its query with only `model, smart_format, punctuate, language|detect_language` and **omits keywords entirely** (`deepgram.stt.ts:78-102`). The plumbing can't carry them anyway: `server.ts` finalize calls `transcribeBatch(pcm, { apiKey, sampleRate, language, detectLanguage })` with no `keywords` (`server.ts:119`), and `transcribeBatch`'s `cfg` type has no `keywords` field (`types.ts:68`).

**Why it fails:** The inserted text comes from the batch transcription on stop — the streaming result is live-preview only and is discarded. So the keyword boost that is supposed to make Deepgram actually recognize custom terms (product names, jargon) in the audio has **zero effect on the text the user gets**. This is the same class as the `detect_language` bug: a setting effective on streaming but a no-op on the batch/finalize path. (Partial mitigation, not a fix: the format-prompt vocabulary path still runs on the final via `correction.format` at `server.ts:156`, so custom terms can still be re-spelled downstream — but that's LLM re-spelling, not STT-side recognition, and won't recover a term Hear/Deepgram never heard correctly.)

**Recommended fix:** add `keywords?: string[]` to `transcribeBatch`'s `cfg` (`types.ts:68`); pass `keywords: vocabulary` from `server.ts:119`; in `deepgram.stt.ts` `transcribeBatch`, append `keywords`/`keyterm` (branch on the resolved model, same logic as `deepgram.stt.ts:62-68`) to the prerecorded query — Deepgram's prerecorded `/v1/listen` supports both params.

---

## Verified correct (no action)

- **language on the batch/finalize path** for Deepgram (`detect_language=true` on auto, else pinned) and OpenAI (Whisper omit-on-auto) — the recently-fixed class is clean on both `transcribeBatch` implementations (`deepgram.stt.ts:87-91`, `openai.stt.ts:59-61`).
- **auto_detect_language** reaches both paths for Deepgram/OpenAI, with the correct per-vendor/per-path param (streaming `language=multi` vs batch `detect_language=true` for Deepgram; omit-language on both for OpenAI). `server.ts` forwards `autoDetect` to `startSession` (`:245`) and `transcribeBatch` (`:119`).
- **PyAI English-only guard** — auto-detect disabled + capability error in the UI; adapter ignores `language`/`detectLanguage`/`keywords` by design (matches F6 English-only reality).
- **API keys** — all three providers: `inject_keys` (`main.rs:513-517`) → `process.env` → `server.ts:234` → `cfg.apiKey` → correct auth header/scheme (`Bearer` for PyAI/OpenAI, `Token` for Deepgram).
- **mic_device_id** — read from config and applied via `getUserMedia({ deviceId: { ideal } })` with a safe fallback to system default (`main.ts:386-393`); webview-only, correctly does not touch adapters.

## Could NOT verify (needs live key / Mac runtime)

- Whether PyAI Hear ever emits a real `transcript.final` event — the findings only observed `transcript.partial` (F8/F10). The adapter handles `.final` defensively (`pyai.stt.ts:70-82`) but the finalize path relies on batch regardless, so this is moot for output correctness.
- Live vendor acceptance of the exact batch/streaming params (Deepgram prerecorded `keywords`/`keyterm`, OpenAI `gpt-transcribe`/`gpt-live-transcribe` model names) — validated against the repo docs, not exercised against live APIs.
- Rust `inject_keys` behavior can only be compiled/run on the Mac (per project conventions); wiring gaps above are read from source, not a running build.
