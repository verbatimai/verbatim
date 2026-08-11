# PyAI API — Stress-Test Findings Report

**Reporter:** Mayank Banga (Saaslabs)
**Date:** 11 August 2026
**Environment:** Public API `https://api.pyai.com/v1`
**Credential:** sandbox/test key (`pyai_test_…`), org `org_e77cef4c079a4f8db49d`
**How found:** while building a real-time dictation product on PyAI (STT + text-LLM cleanup). Testing was scripted; requests and raw responses below are verbatim from those runs.

> **Two caveats so findings are weighted correctly.** (1) The audio used for STT was **synthetically generated** (espeak-ng TTS), so word-error-rate numbers are *not* representative of real speech — only the *formatting behaviours* noted in F6 are meaningful. (2) All tests used a **sandbox test key**; behaviour on production keys may differ.

---

## Summary

| ID | Finding | Area | Severity |
|----|---------|------|----------|
| F1 | `POST /v1/messages` with tool-use returns `503` (internal `ModuleNotFoundError`) | Text LLM / tool-use | **High** |
| F2 | Error responses leak internal implementation details | Security / error hygiene | **Medium** |
| F3 | Docs advertise OpenAI compatibility, but `/v1/chat/completions` 404s (API is Anthropic-Messages-style) | Docs / DX | **Medium** |
| F4 | Text model `gpt-5.6-sol` is undiscoverable and the `model` param is silently ignored/remapped | API correctness / DX | **Medium** |
| F5 | `/openapi.json` is publicly served and exposes the full internal route map | Security / attack surface | **Medium** |
| F6 | STT output lacks inverse-text-normalization, punctuation, and casing | STT product quality | **Low–Med** |
| F7 | `/v1/audio/transcriptions` silently accepts `whisper-1`; model naming inconsistent | API correctness | **Low** |
| F8 | Streaming STT wire protocol undocumented (now reverse-engineered) | Docs / DX | **Low (info)** |
| F9 | `POST /v1/messages` (`gpt-5.6-sol`) latency is 4.4–13 s per short request | Text LLM performance | **High** |
| F10 | Streaming STT rejects `{"type":"stop"}` (`unknown_message_type`); no documented finalize message | Streaming STT / DX | **Medium** |

*(An SSL `CERTIFICATE_VERIFY_FAILED` we hit on the WebSocket was a client-side Python trust-store issue, not a PyAI defect, and is excluded.)*

---

## F1 — Tool-use on `/v1/messages` returns 503 with an internal error  ·  **High**

**Endpoint:** `POST /v1/messages`

A plain Messages request succeeds, but adding `tools` + `tool_choice` (Anthropic-style structured output) fails **consistently** (5/5 calls) with HTTP 503.

**Works:**
```bash
curl -sS https://api.pyai.com/v1/messages \
  -H "Authorization: Bearer $PYAI_KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","max_tokens":16,
       "messages":[{"role":"user","content":"say hi"}]}'
# 200 -> {"id":"msg_...","role":"assistant","model":"gpt-5.6-sol",
#         "content":[{"type":"text","text":"Hi!"}],"stop_reason":"end_turn", ...}
```

**Fails:**
```bash
curl -sS https://api.pyai.com/v1/messages \
  -H "Authorization: Bearer $PYAI_KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","max_tokens":1024,
       "messages":[{"role":"user","content":"Raw transcript: umm let'\''s meet at 8pm no make it 9pm"}],
       "tools":[{"name":"emit_correction","description":"...","input_schema":{"type":"object","properties":{"clean_text":{"type":"string"}},"required":["clean_text"]}}],
       "tool_choice":{"type":"tool","name":"emit_correction"}}'
```
**Observed:**
```json
HTTP 503
{"type":"error","error":{"type":"api_error",
  "message":"no internal Claude Code model available (ModuleNotFoundError)"}}
```

**Expected:** a `200` with a `tool_use` content block containing the tool input.

**Impact:** structured/JSON output via tools is the clean, reliable way to drive downstream logic (in our case, the correction UI). With it broken we must fall back to JSON-in-text prompting and defensive parsing. The `ModuleNotFoundError` and the phrase *"no internal Claude Code model available"* indicate the tool-use path routes to a **separate internal component that is unconfigured/missing** in this deployment, rather than a bad-request condition — i.e. an infra/deploy defect, not user error.

**Suggested fix:** ensure the tool-use backend module is present in all deployments; if tool-use is genuinely unsupported on a tier, return a `400/422` with a clear "tool_use not supported" message instead of a `503` internal error.

---

## F2 — Error responses leak internal implementation details  ·  **Medium (security)**

The F1 error body returned to an external caller includes an internal exception type (`ModuleNotFoundError`) and an internal component name (*"internal Claude Code model"*). Several other routes similarly echo internal routing details (e.g. `"No such route: /v1/chat/completions"`, `"service":"hear"`, `"service":"voice"`).

**Impact:** leaks stack/implementation details and internal product/vendor names to API consumers; aids fingerprinting and is generally poor error hygiene for a public API.

**Suggested fix:** map internal exceptions to sanitized, stable public error codes/messages; log the internal detail server-side with a correlation id, and return only that id to the client.

---

## F3 — "OpenAI-compatible" is misleading; the text API is Anthropic-Messages-style  ·  **Medium (DX)**

Marketing/quickstart states the API "accepts the OpenAI SDK pointed at `https://api.pyai.com/v1`". In practice:

```bash
curl -sS https://api.pyai.com/v1/chat/completions \
  -H "Authorization: Bearer $PYAI_KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"hi"}]}'
# 404 -> {"error":{"code":"unknown_route",
#   "message":"No such route: /v1/chat/completions","type":"invalid_request_error"}}
```
The working text endpoint is `POST /v1/messages` in **Anthropic Messages format** (`system` top-level, `max_tokens` required, `content` blocks, `stop_reason`, `input_tokens`/`output_tokens`).

**Impact:** developers following the docs with the OpenAI SDK will get immediate 404s. Wasted onboarding time and eroded trust in the docs.

**Suggested fix:** correct the docs to state the text API is Anthropic-Messages-compatible and document `/v1/messages`; either add a real OpenAI-compatible `/v1/chat/completions` shim or remove the OpenAI-SDK claim.

---

## F4 — Text model is undiscoverable and the `model` parameter is ignored/remapped  ·  **Medium**

`GET /v1/models` returns only `pyai-hear`, `pyai-voice`, `pyai-omni-realtime`, `pyai-amd` — **not** `gpt-5.6-sol`, the model that actually answers `/v1/messages`.

Separately, sending a *different* model to `/v1/messages` is silently accepted and answered by `gpt-5.6-sol`:
```bash
# requested model = pyai-omni-realtime
curl ... -d '{"model":"pyai-omni-realtime","max_tokens":16,"messages":[{"role":"user","content":"say hi"}]}'
# 200 -> "model":"gpt-5.6-sol"   (requested model neither honoured nor rejected)
```

**Impact:** callers can't discover valid text models, and can't trust that the model they request is the one used (a correctness/billing/repeatability concern).

**Suggested fix:** list text models in `/v1/models`; validate the `model` param and either honour it or return a `400 unknown_model` (as `/v1/audio/transcriptions` correctly does — see F7).

---

## F5 — `/openapi.json` publicly exposes the full route map  ·  **Medium (attack surface)**

`GET https://api.pyai.com/openapi.json` returns `200` with the complete spec — ~90 paths including internal-looking surfaces: `/auth/signup`, `/v1/sandbox/keys`, `/v1/telephony/compliance-cases/*`, `/v1/knowledgebases/*`, `/v1/trace/*`, `/v1/webhooks/signing-secret`, `/public/widgets/{publicId}/session`, etc.

**Impact:** if unintended, this hands attackers a full enumeration of the API surface (including admin/compliance/telephony routes) and reduces the cost of probing. May be intentional for a developer platform — flagging for a conscious decision.

**Suggested fix:** confirm whether the spec should be public; if not, gate it (auth/allowlist) or serve only the public subset. Review the exposed routes for ones that shouldn't be internet-facing.

---

## F6 — STT output lacks number formatting, punctuation, and casing  ·  **Low–Medium (product)**

`POST /v1/audio/transcriptions` (model `pyai-hear`) on our test clip returned:
```
"let's schedule a meeting at eightpm no no make it ninepm r i think that that works for me"
```
Observations (formatting only — WER is not assessed due to synthetic audio):
- No **inverse text normalization**: "8 pm" → `eightpm`, "9 pm" → `ninepm` (spelled out **and** mushed together).
- No **punctuation** or sentence **casing**.
- Disfluencies/repetitions passed through verbatim (`that that`) — expected for raw STT, and actually desirable for our use case, noted only for completeness.

**Impact:** downstream consumers must do their own ITN/punctuation/casing. For general dictation this is a noticeable quality gap vs. competitors that return formatted text. (In our pipeline the `/v1/messages` cleanup step *does* fix this — e.g. `ninepm → 9 pm` — but that shouldn't be required for basic formatted transcripts.)

**Suggested fix:** offer optional ITN + punctuation/casing (e.g. a `format`/`normalize` flag on the transcription request), or document that raw output is unformatted by design.

---

## F7 — `/v1/audio/transcriptions` silently accepts `whisper-1`; naming inconsistent  ·  **Low**

The endpoint returned `200` for both `model=pyai-hear` and `model=whisper-1`, but rejected `model=hear` with a helpful `400`:
```json
{"error":{"type":"invalid_request_error","code":"unknown_model",
  "message":"Unknown model 'hear'. Use 'pyai-hear'.","service":"hear"}}
```

**Impact:** ambiguous whether `whisper-1` is an intended alias or an accidental passthrough; inconsistent with the strict validation applied to `hear`. (The `unknown_model` behaviour here is the *correct* pattern — see F4.)

**Suggested fix:** decide on aliases explicitly, document them, and validate consistently across models.

---

## F8 — Streaming STT wire protocol undocumented (now reverse-engineered)  ·  **Low (info)**

`GET /v1/audio/transcriptions/stream` works but is undocumented. For reference, the protocol we reverse-engineered: connect with config as **query params** (`?model=pyai-hear&sample_rate=16000&encoding=pcm_s16le&channels=1`), auth via `Authorization: Bearer` header, no start frame, then stream raw PCM (~20 ms frames). Server emits `session.created` `{model:"hear-realtime-1", session_id}` then `transcript.partial` `{text, stable_text, active_text, utterance_id, revision_id, t_ms, session_id}`. First partial ~590 ms. (The `stable_text`/`active_text` split is excellent — please keep it.)

**Impact:** integration friction for the core live-transcript feature; every consumer must reverse-engineer this.

**Suggested fix:** publish the streaming protocol (connection, framing, event schemas, finalize/close semantics — see F10) with a minimal client example.

---

## F9 — `/v1/messages` latency is 4.4–13 s for short requests  ·  **High (performance)**

`POST /v1/messages` (`gpt-5.6-sol`, non-streaming) on ~40-token prompts returned correct results but slowly:

| prompt | input/output tokens | latency |
|---|---|---|
| "Umm let's schedule a meeting at 8 pm no no make it 9 pm" | 238 / 208 | 4.88 s |
| "So I I think we should uh ship…Thursday" | 237 / 267 | 6.69 s |
| "Can you send the report to John, wait, to Sarah…" | 238 / 191 | 4.40 s |
| "The the total is like fifty, umm, fifty five dollars…" | 239 / 620 | **12.99 s** |
| (raw Hear output, number normalization) | 242 / 434 | 7.45 s |

Latency scales with output tokens (~50–65 tok/s effective), suggesting generation-bound throughput.

**Impact:** unusable for real-time/interactive UX (our target is sub-second). Note this was measured **while our own stress-test load was on the org**, which may inflate it — but even a single request at 4–13 s is far above interactive thresholds.

**Suggested questions/fixes for the team:** (a) is there a smaller/faster text model, or a low-latency tier? (b) is **streaming (Anthropic SSE)** supported on `/v1/messages` (we haven't confirmed a `stream:true` path)? (c) are these numbers representative off-load, or is the deployment throughput-capped? Streaming + a faster model would make this viable.

---

## F10 — Streaming STT has no documented finalize/flush control message  ·  **Medium**

The client control messages we tried are all rejected:
```json
{"type":"error","error":{"code":"unknown_message_type","message":"unknown type 'stop'"}}
{"type":"error","error":{"code":"unknown_message_type","message":"unknown type 'finalize'"}}
```
Both `{"type":"stop"}` and `{"type":"finalize"}` return `unknown_message_type` (the latter confirmed against a live mic session, not just the test clip). This strongly implies Hear has **no client-side control protocol** — you stream audio and close the socket to end — but that is undocumented, as is whether/when the server emits a `transcript.final` or a VAD end-of-utterance event.

**Impact:** integrators can't reliably (a) flush the final words of the last utterance on stop, or (b) know the end-of-utterance signal to trigger downstream work (in our case, the correction pass). We currently end by closing the socket, which risks dropping a trailing partial.

**Suggested fix:** document the intended end-of-stream behavior — either the correct flush/commit control message, or explicitly state "close the socket to finalize" — plus the `transcript.final` event schema and any server-side VAD/endpoint events. If there is genuinely no control message, rejecting unknown types with a hint (e.g. "no control messages; close to finalize") would help.

---

## Appendix — confirmed working

- `GET /v1/models` → `200`, ~0.35 s.
- `POST /v1/audio/transcriptions` (`pyai-hear`) → `200`, ~1.6 s for ~8 s audio.
- `POST /v1/messages` (`gpt-5.6-sol`, plain/JSON) → `200`, valid Anthropic-format output; **correction quality was excellent** (self-corrections, fillers, repetitions, and number normalization all handled correctly) — the concern is latency (F9), not accuracy.
- Streaming STT `wss …/v1/audio/transcriptions/stream` → works; `session.created` + `transcript.partial` with `stable_text`/`active_text`; first partial ~590 ms.
- `GET /openapi.json` → `200` (full spec).
- `GET /v1/realtime` → `426 Upgrade Required` (WebSocket endpoint present).

## Appendix — top asks for the PyAI team

1. **Fix the tool-use `503` (F1)** — highest-impact blocker for structured output.
2. **Address `/v1/messages` latency (F9)** — 4–13 s is unusable for interactive UX; confirm SSE streaming support and whether a faster text tier exists.
3. **Document the streaming-STT finalize message + `transcript.final` (F10)** — currently no working way to end an utterance.
4. Sanitize public error messages (F2).
5. Correct the OpenAI-compatibility docs and document `/v1/messages` (F3).
6. List text models and validate the `model` param on `/v1/messages` (F4).
