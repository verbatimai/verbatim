# Vendor API Research (STT + correction)

Implementation reference for the M4 adapter layer. Verified against official docs on 2026-08-11. Items marked **[verify]** could not be re-confirmed from a live doc page and rely on prior knowledge.

## 1. Deepgram — streaming STT ("Listen" WebSocket)
- Endpoint: `wss://api.deepgram.com/v1/listen` · Auth header: `Authorization: Token <KEY>` (browsers can't set WS headers → use subprotocol `["token", KEY]` or a short-lived key).
- Key query params: `model` (e.g. `nova-3`), `language`, `encoding=linear16`, `sample_rate=16000`, `channels=1`, `interim_results=true`, `endpointing` (ms silence → `speech_final`), `vad_events=true` (→ `SpeechStarted`), `utterance_end_ms>=1000` (→ `UtteranceEnd`, requires interim_results), `punctuate`, `smart_format`.
- Default dictation audio: PCM16 16 kHz mono (`encoding=linear16&sample_rate=16000&channels=1`).
- Send raw **binary** PCM frames. Control (text): `{"type":"KeepAlive"}`, `{"type":"CloseStream"}` (flush+final).
- `Results` message: `channel.alternatives[0].transcript`, flags `is_final` (chunk finalized), `speech_final` (endpoint silence crossed). `UtteranceEnd` `{last_word_end}` is the robust "user paused" signal.
- **Adapter mapping:** accumulate `is_final` transcripts → `stableText`; current interim → `activeText`; `UtteranceEnd`/`speech_final` → segment boundary.

## 2. OpenAI — STT  *(confirmed 13 Aug 2026 — see `vendor-transport.md` §2; models renamed since the 11 Aug draft)*
- **Realtime (live mic, WS):** `wss://api.openai.com/v1/realtime?intent=transcription`, headers `Authorization: Bearer` + `OpenAI-Beta: realtime=v1`. A **raw key is allowed only on a "secure backend"** (our app-managed sidecar — see `vendor-transport.md`); browsers/mobile must use **WebRTC + an ephemeral client token**, not the raw key. Audio: pcm16 mono **24 kHz**. Configure a `transcription_session.update` (`input_audio_format:"pcm16"`, `input_audio_transcription.model`, `turn_detection:{type:"server_vad"}`), stream base64 in `input_audio_buffer.append`, flush with `input_audio_buffer.commit`. Events: `conversation.item.input_audio_transcription.delta` (partial) / `.completed` (final).
- **Models (renamed):** **`gpt-live-transcribe`** for streaming, **`gpt-transcribe`** for post-turn (with language detection). The old `gpt-4o-transcribe`/`whisper-1` names are superseded. *(Implemented in `providers/openai.stt.ts`; `OPENAI_STT_MODEL` / `OPENAI_BATCH_MODEL` override.)*
- **Batch:** `POST /v1/audio/transcriptions` multipart (`file`, `model=gpt-transcribe`, `response_format`). Used for the finalize path (`transcribeBatch`).

## 3. OpenAI — chat completions (correction)
- `POST /v1/chat/completions`, `Authorization: Bearer`. Reliable JSON via `response_format: {type:"json_schema", json_schema:{name, strict:true, schema:{... additionalProperties:false, all fields required}}}`. Parse `choices[0].message.content` (JSON string); `message.refusal` if refused.
- Streaming: `stream:true` → SSE `chat.completion.chunk`, concat `choices[0].delta.content`, ends at `data: [DONE]`.

## 4. Anthropic — Messages API (correction)
- `POST /v1/messages`. Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`. Body: `model`, `max_tokens`, top-level `system`, `messages`.
- Structured output = forced tool-use: one tool with `input_schema` = target schema, `tool_choice:{type:"tool", name:"..."}`. Response `content[]` has a `tool_use` block whose `input` is the object; `stop_reason:"tool_use"`.
- Streaming: `stream:true` → SSE `message_start` → `content_block_start`/`content_block_delta` (`text_delta`, or `input_json_delta` for tool input — accumulate, parse after `content_block_stop`) → `message_delta` → `message_stop`; `ping` keep-alives.

## Adapter-layer takeaways
- Two STT wire shapes: Deepgram (binary PCM + JSON keyed on `is_final`/`UtteranceEnd`) vs OpenAI Realtime (JSON-only, base64 audio, `delta`/`completed`). Both map onto our `TranscriptEvent {stableText, activeText, endpoint}`.
- Audio rate differs: Deepgram 16 kHz, OpenAI Realtime 24 kHz — resample per adapter.
- Correction structured output: OpenAI `json_schema` (strict) vs Anthropic forced `tool_use` vs PyAI JSON-in-text (tool-use 503, finding F1). All target the same compact-edits schema so the step is vendor-swappable.

*(Note: WebSearch was blocked by egress policy in the research session; details fetched directly via WebFetch. Deepgram + Anthropic confirmed live; OpenAI Realtime URL/beta header marked [verify].)*
