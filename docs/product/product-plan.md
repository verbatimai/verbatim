# Product Plan: Real-Time Dictation Widget (Wispr Flow Alternative, built on PyAI)

**Owner:** Mayank Banga · Saaslabs
**Date:** 11 Aug 2026
**Version:** v5 — validated draft, now vendor-agnostic and open-source-bound.
**Status:** Planning + de-risking. Correction *quality* validated; correction *latency* being optimized; widget injection unproven (needs local Phase 0).
**Core constraint:** PyAI (`pyai.com`) is the **default** provider, so the build still doubles as a PyAI stress test — but the architecture is **vendor-agnostic** (see §13) so it also runs on Deepgram / OpenAI / Anthropic.
**Distribution:** **Open source, MIT.** Public repo with security + code checks in place before release (see §14).

---

## 1. Problem statement (what we actually agreed on)

We are building a **floating dictation widget** — like Wispr Flow — that lets a user dictate into *any* text field on their machine. When invoked (global hotkey), a small overlay appears, the user speaks, and the transcribed text is inserted into **whatever input box was focused before the widget appeared** (the "correct input box" requirement).

Two things make this different from Wispr Flow:

**(A) Live transcript.** Wispr Flow records the whole utterance, transcribes it, cleans it, then drops the final text in. We want words to appear *as the user speaks* — streaming partial transcripts in real time.

**(B) Visible, explainable corrections.** Wispr silently outputs clean text. We want to *show the correction happening*: render the raw words the user actually said, then visibly remove fillers ("ahh", "umm") and self-corrections, marking exactly what was removed. Example:

> Spoken: *"Let's schedule a meeting at 8 pm no no make it 9 pm"*
> Shown live: `Let's schedule a meeting at 8 pm no no make it 9 pm`
> After correction: `Let's schedule a meeting at ` ~~`8 pm no no make it`~~ ` 9 pm`
> Injected into the field: `Let's schedule a meeting at 9 pm`

The user sees, in real time, both *what they said* and *what we corrected*, with the removed span struck through before it fades out.

**Foundation (PyAI) — verified against the live API on 11 Aug 2026:**
- **Hear (STT)** — batch at `POST /v1/audio/transcriptions` (model `pyai-hear`) ✅ confirmed working; streaming at `GET /v1/audio/transcriptions/stream` (WebSocket). Powers the live transcript.
- **Text LLM** — `POST /v1/messages`, **Anthropic Messages format**, model **`gpt-5.6-sol`** ✅ confirmed working. Powers cleanup (filler removal) and self-correction rewriting. NOTE: there is **no** OpenAI `/v1/chat/completions` route (it 404s) despite the marketing; we use `/v1/messages`.
- Auth: `Authorization: Bearer <key>`.

> **Reality check:** the public docs described an "OpenAI-compatible" surface. The live API is actually Anthropic-Messages-style for text and has its own STT/TTS/realtime routes. Section 7 reflects the verified endpoints, not the marketing.

---

## 2. The core technical model

Everything hinges on separating two layers that update at different speeds.

### Layer 1 — Live raw transcript (fast, from Hear)
As the user speaks, Hear streams **partials** (interim, mutable) and **finals** (locked). We render partials immediately in a "listening" style (e.g. dim/gray). This is the *what you said* layer. It never waits on the LLM, so the experience feels instant.

### Layer 2 — Correction pass (slightly delayed, from the LLM)
We treat the transcript as a sequence of **segments** (utterances separated by pauses). When a segment finalizes, we send it to the PyAI LLM, which returns the cleaned text **plus a structured list of edits**. We animate those edits (strike-through → fade) and then commit the clean text. This is the *what we corrected* layer.

```
mic ──► Hear (WS) ──► partials ──► [Layer 1: live raw text, gray]
                       │
                       └─ final segment ──► PyAI LLM ──► edit ops ──► [Layer 2: animate removals, commit clean text]
                                                                              │
                                                                              └──► inject clean text into focused field
```

### Segment state machine
Each segment moves through: `listening` (mutable gray partials) → `raw_final` (locked "what you said") → `correcting` (LLM in flight) → `corrected` (diff animated, clean text committed). Only `corrected` text is eligible for injection into the target field.

---

## 3. Correction timing — recommendation

**Recommended: segment-level correction (on pause), not continuous word-by-word.**

Reasoning — this is the key insight for the whole product:

A self-correction *cannot be detected until it happens*. In *"8 pm no no make it 9 pm"*, the "8 pm" is not wrong when spoken — it only becomes wrong once "no no make it 9 pm" arrives. Corrections are therefore inherently **utterance-level**, not word-level. Trying to correct continuously would mean constantly guessing and un-guessing, producing flicker, and firing many LLM calls (cost + rate-limit pressure on PyAI).

So the model is:
1. **Stream raw words continuously** → the *live* feel comes entirely from Layer 1. This is what makes it feel real-time.
2. **Correct at segment boundaries** → detected by Hear `final` events plus a short silence/VAD timeout (~500–800 ms). The correction lands < 1 s after the user pauses, which reads as instant.
3. **Final polish pass on stop** → when the user ends dictation, one optional whole-text pass fixes cross-segment issues (capitalization, punctuation flow) before injection.

We keep a **rolling committed-context window** (the last N corrected segments) so each correction is coherent with what came before.

*Optional later:* a user-toggleable "continuous preview" mode for people who want maximum liveness and accept flicker. Not in the first build.

---

## 4. The "what was removed" algorithm (the differentiator)

We want the removal display to be **deterministic and categorized**, not a guess. Two mechanisms, primary + fallback:

### Primary: LLM returns structured edit ops — ✅ validated 11 Aug 2026
We use PyAI `/v1/messages` (Anthropic format, `gpt-5.6-sol`) in **JSON-in-text mode**. (Anthropic tool-use would be cleaner but currently 503s on PyAI — finding F1 — so JSON-in-text is the working primary; we validate the JSON and fall back to a local diff if malformed.) Across 5 test transcripts every result had `reconstruct_raw == reconstruct_clean == true` — the ops perfectly align to the raw text and rebuild the clean text — and self-corrections, fillers, repetitions, false starts, and number formatting (`fifty five → 55`) were all handled and correctly categorized. The model returns the clean text **and an ordered list of operations** that map the raw segment onto the clean segment:

```jsonc
{
  "clean_text": "Let's schedule a meeting at 9 pm",
  "ops": [
    { "type": "keep",    "text": "Let's schedule a meeting at " },
    { "type": "remove",  "text": "8 pm no no make it ", "reason": "self_correction" },
    { "type": "keep",    "text": "9 pm" }
  ]
}
```

`reason` lets us color/label removals differently: `filler` ("ahh", "umm"), `false_start`, `self_correction`, `repetition`, `grammar`. The UI renders `keep` normally, `remove` as struck-through-then-fading, and `replace` (old struck + new inserted). Because the ops are ordered and cover the whole raw span, the animation is fully driven by data — no client-side guessing.

**Validation:** reconstructing the `keep` + `replace`(new) spans must equal `clean_text`; if it doesn't, we discard the ops and fall back.

### Fallback: local word-level diff
If structured output is malformed or fails validation, we compute a **word-level LCS diff** between raw and clean text locally (Myers/LCS). This handles the common cases well — fillers and self-corrections that end on the correct value both show up as clean deletions (e.g. raw "8 pm no no make it 9 pm" vs clean "9 pm" → "8 pm no no make it" marked removed, "9 pm" kept). The fallback loses the *reason* labels but keeps the core UX intact.

This primary+fallback design means the feature degrades gracefully and never blocks on a perfect LLM response.

### Latency: the real constraint (measured, not assumed)
Measured correction latency was **4.4–13 s per segment** — far above the "<1 s after pause" target. Two causes, both addressable:
1. **Verbose output.** The current ops echo every kept word back, so a short sentence generated up to 620 output tokens (generation time dominates). **Fix (chosen): compact edits-only ops** — the model returns `clean_text` plus only the *edits* it made, each as the literal raw substring + replacement + reason (no echoing of kept text). The client re-locates each substring left-to-right to rebuild the full keep/remove/replace timeline for the UI. This is implemented and unit-tested in `test_correction_compact.py`, which runs both formats side-by-side and prints the token/latency delta. (Character-offset ops were considered but rejected — LLMs miscount character positions; literal substrings are far more reliable.)
2. **Model speed / load.** `gpt-5.6-sol` is the only text model exposed and is currently under our own stress-test load. **Fixes:** stream the response via Anthropic SSE so the animation starts as ops arrive (improves *perceived* latency); ask the PyAI team whether a smaller/faster text model exists; keep segments short.

Until latency is down, the UX still holds because Layer 1 (raw live text) is instant and injection can proceed on the raw+local-diff result, with the LLM correction applied a beat later. But getting the correction pass under ~1 s is a Phase-0/Phase-1 goal, tracked against the compact-ops change above.

---

## 5. The widget + focused-input injection (the hard OS part)

This is the riskiest engineering area, so we de-risk it first (see roadmap Phase 0).

**Golden rule: the widget must never steal focus.** We capture the target field *before* showing the widget, and the overlay window is non-activating, so the OS still regards the target app's field as focused — which is what lets injected text land in the right place.

**Flow:**
1. **Global hotkey** summons the widget (Wispr uses a held key like `fn`; we make it configurable).
2. **Before showing the overlay**, capture the system-wide focused UI element and its state (app, field reference, caret/insertion point).
3. Show a **borderless, always-on-top, non-focusable** overlay near the caret or in a fixed corner.
4. User dictates; corrected text is produced.
5. **Inject** the final text into the captured target field.

**Focus tracking + injection, per OS:**

- **macOS (first target — you're on a Mac):** use the Accessibility API (`AXUIElement`) to read the system-wide focused element and its `AXValue`/insertion point. Requires the app to be granted **Accessibility permission** (System Settings → Privacy). Injection has two strategies:
  - *AX write:* set/insert via `AXValue` at the caret — cleanest, preserves the field.
  - *Synthetic paste:* place text on clipboard, send ⌘V to the target app, then restore the clipboard — most universal, works where AX write is blocked, but momentarily touches the clipboard and is blocked in secure fields (passwords).
  We implement AX-write first with clipboard-paste as the universal fallback.
- **Windows (later):** UI Automation (UIA) for the focused element + `SendInput`/paste for injection.

**Secure fields** (password boxes, some Electron/Java apps that don't expose AX) can't be written to — we detect and show a "can't insert here, copy instead" affordance.

---

## 6. Recommended tech stack (you had no preference)

For a small, latency-sensitive, deeply OS-integrated widget that is also an *eventual external product*, I recommend:

**Desktop client: Tauri (Rust core + React/TypeScript UI).**
- Rust core handles the native-heavy work: global hotkey, non-focusable always-on-top overlay, Accessibility focus tracking/injection, mic capture (`cpal`), audio resampling, and the WebSocket connection to Hear. Rust is a better fit than Node here for reliable, low-latency native OS calls, and Tauri ships a much smaller/faster binary than Electron.
- React + TypeScript renders the transcript and the correction/diff animations (Framer Motion for the strike-through → fade).
- *Alternative:* **Electron + React + native Node addons** if the team is strongly all-JS. It's a faster start but heavier, and you'll still write native code for AX injection. I'd only pick it if Rust is a non-starter for the team.

**Backend service (needed because this is a product, not a demo): Node/TS (Fastify) or Python (FastAPI).**
Purpose:
- **Keep the PyAI API key off the client.** Never ship the key in a desktop binary. Either (a) issue short-lived scoped tokens the client uses to connect *directly* to PyAI (best latency — confirm PyAI supports ephemeral/session tokens), or (b) proxy audio through the backend (simpler, adds latency). Start with whichever PyAI supports; prefer (a).
- User accounts, settings, custom vocabulary/dictionary, correction preferences.
- **Usage metering + billing** and per-user rate limiting.
- **Telemetry** for the PyAI stress test (see §8).

I'd use **Node/TS** for the backend so client and server share TypeScript types for the transcript/edit-op protocol — unless the team wants to keep AI-adjacent logic in Python, in which case FastAPI is fine.

---

## 7. PyAI integration specifics (verified endpoints)

Available models (`GET /v1/models`): `pyai-hear` (STT), `pyai-voice` (TTS), `pyai-omni-realtime` (fused voice+LLM brain), `pyai-amd`. The text model `gpt-5.6-sol` is reachable via `/v1/messages` but is not listed in `/v1/models`.

**Hear (STT):**
- Batch: `POST /v1/audio/transcriptions`, model `pyai-hear` — ✅ confirmed, returns `{"text": "..."}`. Fillers and self-corrections are preserved in the raw transcript (exactly what Layer 1 needs).
- Streaming: `GET /v1/audio/transcriptions/stream` → `wss://api.pyai.com/v1/audio/transcriptions/stream` — ✅ **protocol decoded 11 Aug 2026.** Connect with config as **query params** (`?model=pyai-hear&sample_rate=16000&encoding=pcm_s16le&channels=1`), auth via `Authorization: Bearer` header, then stream raw PCM frames (~20 ms each). No start frame needed. Server emits:
  - `session.created` `{model: "hear-realtime-1", session_id}` immediately;
  - `transcript.partial` `{text, stable_text, active_text, utterance_id, revision_id, t_ms, session_id}` — **`stable_text` is the locked prefix (render solid), `active_text` is the volatile tail (render gray).** This *is* our Layer-1 model, provided natively. First partial ~590 ms.
  - **Still open:** the correct "end-of-audio / finalize" control message — `{"type":"stop"}` returns `unknown_message_type` (finding F10), so we haven't yet observed the `transcript.final` event or confirmed VAD/end-of-utterance signaling. A probe for the right message type is in `test_hear_stt.py`.
- Also present: async `POST /v1/transcription/jobs` for offline batch.

**Text LLM (cleanup + correction):**
- `POST /v1/messages` (Anthropic Messages format), model `gpt-5.6-sol` — ✅ confirmed (`{"content":[{"type":"text",...}],"stop_reason":...,"usage":{...}}`).
- Structured output via Anthropic tool-use (`emit_correction` tool, §4). **To confirm:** tool-use support, streaming (Anthropic SSE) support, and the full set of valid text-model ids.

**TTS (for test-clip generation / future read-back):** `POST /v1/audio/speech` (model `pyai-voice`) — requires an enrolled/known voice (`GET /v1/voices`, `POST /v1/voice/clones`).

**Realtime (alternative path):** `GET /v1/realtime` (omni voice socket, 426=upgrade-required confirmed) and `POST /v1/omni/sessions`. Not needed for the dictation pipeline, but relevant if we ever want speech-to-speech.

**Key handling / ephemeral tokens:** there is **no** OpenAI-style `/v1/realtime/sessions` mint (404). Candidate routes for keeping the API key off the desktop client are `POST /public/widgets/{publicId}/session`, `POST /v1/omni/sessions`, and `POST /v1/sandbox/keys` — to be evaluated. Until confirmed, default to **proxying through our backend** (§6).

**Auth:** `Authorization: Bearer <key>`. Server-side only (§6).

**Cost (rough):** Hear from ~$0.001/min is negligible; text-LLM cost is per-token per segment and is the main variable. On-pause (not continuous) correction keeps call volume low.

---

## 8. Stress-testing PyAI (baked in, per company mandate)

Since rule #1 is stress-testing PyAI, we make measurement first-class from day one:
- **Per-event telemetry:** time-to-first-partial, partial cadence, Hear final latency, LLM correction latency (p50/p95/p99), WS reconnect count, error/timeout rates, transcript word error rate on a fixed audio set.
- **Load harness:** a script that replays recorded audio files through the same Hear pipeline at N concurrent streams to push PyAI and capture the metrics above.
- **A small metrics dashboard** so the team can watch PyAI behavior under load over time.

This means the MVP (Phase 1) starts generating PyAI stress-test data immediately, before the desktop widget even exists.

---

## 9. Latency budget (target: feels instant)

| Stage | Target | Measured (11 Aug 2026) |
|---|---|---|
| Mic → Hear first partial | ~300 ms | **~590 ms** (test clip) |
| Partial → on screen | < 16 ms | (local render) |
| Pause → segment finalized | 500–800 ms silence timeout | pending finalize-message (F10) |
| Segment → LLM correction returned | ~300–800 ms | **4.4–13 s** ⚠️ (see §4 fixes) |
| Correction animation | 200–400 ms | — |
| **Perceived:** raw text | **live as spoken** | ✅ holds (Layer 1 independent) |
| **Perceived:** correction | **< 1 s after you pause** | ❌ not yet — gated on compact-ops + faster model (§4) |

The live feel is guaranteed because Layer 1 never waits on the LLM. The correction latency is the one measured result that misses target; §4 "Latency" lays out the fix path.

---

## 10. Phased roadmap

**Phase 0 — De-risk spikes (before committing to the build).**
Prove the scariest unknowns in isolation. Status:
- ✅ Hear streaming schema + latency — **done** (protocol decoded; `stable_text`/`active_text`; ~590 ms first partial).
- ✅ Correction quality + edit-ops — **done** (5/5 perfect reconstruction; compact-ops format chosen).
- 🔬 Correction latency under ~1 s — **in progress** (compact-ops + confirm SSE streaming + ask PyAI for a faster tier).
- ⬜ Streaming finalize/end-of-utterance message (F10) — **pending** (probe added to `test_hear_stt.py`).
- ⬜ **macOS focus-capture + text-injection** into a real third-party app without stealing focus — **not started; the biggest remaining risk.** Can only be proven on your Mac (native AX + a non-activating window); this cloud sandbox can't test it.
- ✅ Correction UX (the differentiator) — a working visual prototype exists: `correction_ux_demo.html` (live stable/active transcript + animated strike-through/fade correction with reason colors, driven by the real ops).

**Phase 1 — Web-app pipeline MVP (fastest path to exercising PyAI).**
A browser app with its own text box that does the full Layer 1 + Layer 2 experience: live partials, segment detection, LLM edit-ops, and the strike-through→fade correction animation. No OS injection yet. This nails the pipeline and the diff UX, and **starts the PyAI stress test immediately** (§8).

**Phase 2 — Desktop widget shell (macOS).**
Global hotkey, non-focusable always-on-top overlay, focus capture, and injection into the previously-focused field. Reuse the Phase 1 React UI inside Tauri.

**Phase 3 — Correction quality + UX polish.**
Custom vocabulary/dictionary, per-user correction aggressiveness, punctuation/formatting modes, undo, editing while correcting, secure-field handling.

**Phase 4 — Productization + scale.**
Accounts, backend token service, usage metering + billing, Windows support (UIA + SendInput), auto-update, privacy/consent flows, and the telemetry dashboard hardened for production.

---

## 11. Risks & open questions

**Resolved by live testing (11 Aug 2026):** text LLM is `/v1/messages` + `gpt-5.6-sol` (not OpenAI chat); batch STT works with `pyai-hear`; streaming STT endpoint is `GET /v1/audio/transcriptions/stream`; full route map obtained from `/openapi.json`.

**Still to confirm (next test round):**
1. Streaming STT wire protocol + partial/final schema + first-partial latency + VAD/end-of-utterance signals (run the `test_hear_stt.py` WS probe).
2. `/v1/messages` tool-use reliability, streaming (SSE) support, correction quality on real Hear output, and valid text-model ids + rate limits.
3. Ephemeral/scoped token path (`/public/widgets/{publicId}/session`, `/v1/omni/sessions`, or `/v1/sandbox/keys`) vs. defaulting to a backend proxy.

**Engineering risks:**
4. macOS Accessibility permission friction and secure-input fields that block injection — mitigated by the clipboard-paste fallback and a graceful "copy instead" path.
5. Correction latency creeping above the "feels instant" threshold on long segments — mitigated by streaming LLM responses and keeping segments short.
6. Editing/barge-in: what happens if the user keeps talking while a prior segment is still correcting — needs a clear concurrency model (queue corrections per segment; never reorder committed text).

**Product/legal (for an external product):**
7. Audio leaves the device to PyAI — needs explicit user consent, a privacy policy, and possibly a "don't store audio" mode.

---

## 12. Immediate next step

If this direction looks right, the first concrete move is **Phase 0**: a ~1–2 day spike to (a) hit Hear over WebSocket and log real latencies, and (b) prove macOS focus-capture + injection into a third-party app. Those two results determine everything downstream. Say the word and I'll turn Phase 0 into a concrete task breakdown (and we can start implementing).

---

## 13. Vendor-agnostic architecture

PyAI is the **default** provider, but no PyAI-specific detail leaks above the adapter boundary. The app depends only on two narrow interfaces; each vendor is an adapter behind them.

### Two provider roles (a vendor may implement either or both)

**`STTProvider`** — streaming speech-to-text. Adapters normalize every vendor's wire format into one `TranscriptEvent`:
```ts
interface TranscriptEvent {
  type: 'partial' | 'final';
  utteranceId: string;
  text: string;        // full hypothesis for the current utterance
  stableText: string;  // locked prefix — render solid
  activeText: string;  // volatile tail — render dim
  endpoint?: boolean;  // provider VAD end-of-utterance
  tMs?: number;
}
```
The `stableText`/`activeText` split (which PyAI gives natively) becomes the *contract*; adapters that only expose interim/final flags (Deepgram, OpenAI) compute it by accumulating finalized words.

**`CorrectionProvider`** — the cleanup + self-correction pass. One shared prompt + one shared reconstructor (`reconstruct(raw, edits) → {cleanText, ops}`) live in core; each adapter only maps to its vendor's chat wire format and returns the compact edits from §4.

### First-release adapters
| Vendor | STT | Correction LLM | Wire format | Notes |
|---|---|---|---|---|
| **PyAI** (default) | `pyai-hear` (WS stream) | `gpt-5.6-sol` via `/v1/messages` | Anthropic-style | native stable/active; the stress-test target |
| **Deepgram** | streaming WS (interim/final) | — | Deepgram | STT-only; compute stable/active from finals |
| **OpenAI** | Whisper / Realtime | GPT via `/v1/chat/completions` | OpenAI | STT **and** correction |
| **Anthropic** | — | Claude via `/v1/messages` | Anthropic | correction-only; native tool-use for structured ops |

### Selection & config
Providers are chosen by config (`STT_PROVIDER`, `CORRECTION_PROVIDER`) resolved through a small registry/factory. A capability check at startup verifies the required keys for the selected providers are present and fails fast with a clear message. Mixing is allowed (e.g. Deepgram STT + Anthropic correction). Because the two roles are separate interfaces, adding a vendor is one file, no core changes.

### Key model (open-core)
- **OSS core = BYOK, local-only.** Each user supplies their own vendor keys; keys live in the OS keychain (macOS Keychain / Tauri secure store), never written to disk in plaintext, and are sent only to that vendor's own API over TLS. No backend required to run.
- **Optional hosted proxy (commercial layer).** A separate deployable backend holds keys server-side and issues short-lived session tokens, for teams that don't want keys on every device. This is the open-core boundary — the client works fully without it.

---

## 14. Open source & security (public-repo readiness)

**License:** MIT (`LICENSE` at repo root, copyright Saaslabs Technology).

**Repo shape:** monorepo — `packages/core` (provider interfaces, registry, correction prompt/reconstructor, diff logic — the reusable, vendor-neutral brain), `apps/widget` (the Tauri desktop client), `apps/backend` (optional hosted proxy), `docs/`.

### Threat model (what a public dictation client must protect)
- **Assets:** the user's live audio, their transcripts, and their vendor API keys.
- **Top risks & controls:**
  - *Key leakage* (committed secret, log line, crash report) → OS-keychain storage, `.env` git-ignored + `.env.example` only, secret scanning in CI **and** pre-commit, logs redact keys, **no key ever reaches the renderer/client bundle**.
  - *Audio/transcript exfiltration* → **no telemetry of content by default**; any analytics are opt-in and metadata-only; audio streams only to the user-chosen vendor.
  - *Injection into the wrong field* → capture the target element before showing the widget; never inject into secure/password fields; require explicit user action.
  - *Supply-chain* → pinned lockfiles, Dependabot, `npm audit`/`pip audit` gate, CodeQL SAST, and signed release binaries.
  - *MITM* → TLS enforced; certificate handling documented.

### Code + security checks wired into CI (block merge on failure)
1. **Secret scanning** — `gitleaks` on every push/PR + full-history scan (catches a committed key like the test key that leaked into planning chat — which must be **rotated now**).
2. **SAST** — GitHub CodeQL (JS/TS; Python for the backend).
3. **Dependency audit** — `npm audit --audit-level=high` / `pip-audit`, plus Dependabot PRs.
4. **Lint + typecheck + unit tests** — ESLint/Prettier, `tsc --noEmit`, Vitest; Ruff for Python.
5. **Pre-commit hooks** — `gitleaks` + `detect-secrets` + formatters, so leaks are stopped *before* they're committed.
6. **License/allowed-deps check** (optional) and **Trivy** if the backend ships a container.

### Repo hygiene files (scaffolded, delivered alongside this plan)
`LICENSE`, `README.md`, `SECURITY.md` (private vuln reporting + the rotate-leaked-keys policy), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.gitignore`, `.env.example`, `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.pre-commit-config.yaml`, and the provider-interface source stubs (`packages/core/...`).

> **Reconciling with rule #1 ("build over PyAI").** PyAI remains the shipped default and the stress-test target; the adapter layer is additive. If the company needs the public repo to *only* demonstrate PyAI at first, we ship PyAI adapters enabled and others behind a clearly-marked "community adapters" flag — same architecture, controlled surface.
