# Phase 3 fix — auto-detect language + Deepgram 400 (found in on-Mac testing)

_13 Aug 2026 — reported by Mayank: Deepgram 400 error; auto-detect toggle had no effect (fixed language dominated)._

## Root cause (two bugs, same feature)

**Bug A — Deepgram 400 on streaming.** The 3.2 streaming adapter sent `detect_language=true` on the live socket. **Deepgram does not support `detect_language` on streaming** — its docs state "Language Detection is not currently supported for streaming," and the handshake 400s. (Verified against Deepgram's language-detection docs.)

**Bug B — auto-detect (and even fixed non-English) ignored on the authoritative path.** Verbatim's final inserted text comes from `STTProvider.transcribeBatch()` (batch-transcribe the buffered audio on stop), NOT the live stream. But `transcribeBatch`'s signature was `{ apiKey, sampleRate }` — it never received `language` or `detectLanguage`, and the Deepgram/OpenAI implementations sent no language param at all. So the final output always fell back to the vendor default (English), regardless of the language dropdown or the auto-detect toggle. This is why the fixed language "dominated" — nothing else was ever applied on the path that matters.

The config threading (toggle → `autoDetect` on the WS start frame → `server.ts` → `startSession`) was already correct; the gap was entirely in the adapters + the batch call site.

## Fix

- **Streaming (`deepgram.stt.ts` `startSession`):** on auto-detect, send `language=multi` (Deepgram's multilingual-streaming model; best on nova-3, nova-2 multi is es/en only) instead of the unsupported `detect_language`. No more 400. The live preview may be imperfect for languages outside the model's `multi` set — acceptable because the final is the batch result.
- **Batch (`deepgram.stt.ts` + `openai.stt.ts` `transcribeBatch`):** widened the signature to `{ apiKey, sampleRate?, language?, detectLanguage? }` (interface `providers/types.ts` updated; PyAI widened too, still English-only/ignored). Deepgram batch now sends `detect_language=true` on auto-detect (**prerecorded DOES support it**) or `language=<code>` on a fixed choice. OpenAI/Whisper omits `language` on auto-detect (auto-detects) or passes the ISO code.
- **Call site (`apps/backend/src/server.ts`):** the finalize `transcribeBatch` call now forwards `{ language: langTag, detectLanguage: autoDetect }`.

## Tests (cloud, executed)
- `npm test` → **108/108** (was 106; +2). Deepgram integration suite now 7 tests.
- Streaming auto-detect test corrected: asserts `language=multi` and **no** `detect_language` on the socket (it previously asserted the buggy `detect_language=true`).
- New batch assertions: fixed language → `language=es` on the batch URL; auto-detect → `detect_language=true` (and no fixed `language=`).
- `packages/core` + `apps/backend` typecheck clean.

## On-Mac to confirm
- [ ] Deepgram STT + auto-detect ON → speak a non-English sentence → no 400, and the inserted final text is in the spoken language.
- [ ] Deepgram STT, auto-detect OFF, language = (e.g.) Spanish → inserted text is Spanish.
- [ ] Recommended for broad multilingual: set the Deepgram model to **nova-3** (Settings model field / `DEEPGRAM_STT_MODEL`) — nova-2 `multi` only covers Spanish/English on the live preview.

## Note
OpenAI STT got the same batch-language fix for consistency (it had the identical gap). PyAI remains English-only by design.
