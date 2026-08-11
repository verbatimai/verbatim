# Multilingual Support — Assessment

**Question:** can the dictation product support languages beyond English?
**Short answer:** **Not via PyAI's Hear today (it's English-only), but YES via the vendor-agnostic adapter layer** — route STT through Deepgram or OpenAI for non-English. This is a concrete payoff of the multi-vendor architecture.

## PyAI capability today (verified against docs, 11 Aug 2026)
| Surface | Multilingual? | Detail |
|---|---|---|
| **Hear (STT)** — what we use for dictation | ❌ **English only** | `language` param exists (ISO-639-1) but `en` is the only accepted value; non-English → `400 unsupported_language` at request/upgrade. |
| **Speak (TTS)** | ❌ English voices only | Catalog includes Indian-English accents, but all English. (We don't use TTS anyway.) |
| **Omni (agentic voice)** | ✅ staged: `en`, `fr`(rolling), `es`, `de`, `hi` | But Omni is a **speech-to-speech conversational agent**, not a transcription API — not suitable for "type what I say" dictation. Unsupported languages fall back to English. |
| **Correction/format LLM** (`gpt-5.6-sol`) | ✅ general LLM | Handles non-English text fine; only the prompts need localizing. Not the bottleneck. |

**So on PyAI, dictation is English-only.** PyAI's multilingual lives only in Omni, which isn't our STT path.

## How the product supports multilingual anyway (adapter layer)
Because STT is behind `STTProvider`, non-English dictation = swap the STT adapter:
- **Deepgram** — many languages, `language` param, code-switching/multi options. Strong fit.
- **OpenAI** — Whisper / `gpt-4o-transcribe`, ~99 languages with auto-detection.
- **PyAI (Hear)** — stays the **English default** (and the stress-test target).

The `STTSessionConfig` already carries `language`; the pipeline and correction/format are language-agnostic (the LLM cleans/format in whatever language the transcript is in, once prompts are localized).

## What this means for the plan
- **Ships in M4 (multi-vendor).** Add `language` to provider selection/settings; PyAI = `en` only (guard with a clear message if a non-English language is chosen on PyAI); Deepgram/OpenAI carry the chosen language or auto-detect.
- **Localize the cleanup + format prompts** per language (or instruct the model to "respond in the transcript's language"). Small change to `prompt.ts`.
- **Capability gap to log for the PyAI team:** Hear being English-only is the single blocker to first-party multilingual dictation. Worth asking their roadmap (Omni already does fr/es/de/hi — bringing those to Hear would unlock it on PyAI directly).

## Bottom line
Multilingual is an **architecture win, not a PyAI feature** right now: English on PyAI by default, other languages by selecting Deepgram/OpenAI as the STT vendor. No blocker to building it — it's scoped into M4.
