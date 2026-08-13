# M5 — Quality & Polish (daily-driver): Task Breakdown

**Goal (North-Star slice):** make Verbatim good enough that the team dictates with it **every day** — reliable under real network/vendor flakiness, accurate on your own vocabulary, controllable (formatting modes + undo), and measurably fast. M4 proved the product *works*; M5 makes it *trustworthy*.

**Exit criteria (from the roadmap):** two weeks of internal dogfooding with **no blocking bugs**; latency and accuracy feel "instant" in normal use.

> Tracked here (per-phase checklist) + `STATUS.md` (handoff) + `roadmap.md` (milestone). Prereq: **M4 functionally complete** — packaged app runs live dictation on OpenAI/Anthropic/Deepgram; app-owned sidecar; config store + keychain; settings window.

---

## What already exists (starting point — don't rebuild)

- **Pipeline** (`packages/core`): STT session → segmenter → correction (compact-edits + `reconstruct`) → format; live preview via `TranscriptAccumulator`, authoritative final via **batch transcription on stop** (`transcribeBatch`). Backend bridge in `apps/backend/src/server.ts`.
- **Correction/format prompts** (`correction/prompt.ts`): one `SYSTEM_PROMPT` for cleanup + `FORMAT_PROMPT` for formatting; localized per `language` (4.7). Adapters: pyai / openai / anthropic (+ `mock`), some with **retry-with-backoff + refusal guard** already (OpenAI).
- **Config store** (`AppConfig` in Rust `main.rs` + `settings.ts`): `sttProvider`, `correctionProvider`, `sttModel`, `correctionModel`, `language`, `hotkey`, `dockIcon`, `muteOthers`; `get_config`/`set_config` + `config-changed`. Keychain per-vendor.
- **Error surfacing:** the backend logs every provider error in full to `logs/pyai-errors.log` and sends a truncated `error` frame to the overlay banner; an invalid correction vendor now falls back instead of killing the session (M4 hardening).
- **Settings window** (redesigned nav shell, `app.html`): providers/models, keys, hotkey capture, language, mute, permissions.

So M5 is **reliability + accuracy + control + measurement + dogfood** on top of a working pipeline — mostly additive, behind the interfaces that already exist.

---

## Phase 5.0 — Decisions / spike (do FIRST)

Lock the few choices the rest depends on, before building.

- [ ] **Undo semantics.** Decide what "undo" reverts: (a) the *insertion* (remove the text we just injected from the target field), (b) the *correction* (re-inject the raw/uncorrected transcript), or both. Injection is paste-based, so (a) = "select the last N chars we inserted + delete" or a synthetic ⌘Z; (b) is deterministic from data we already have (raw vs clean). Recommendation: ship **(b) re-inject raw** first (safe, data-driven), add (a) if the AX path proves reliable.
- [ ] **Edit-while-correcting model.** Today's product path is **batch-on-stop**, so mid-session barge-in is limited. Decide whether M5 introduces **segment-level streaming correction** (needed for true edit-while-correcting) or keeps batch-on-stop and only hardens concurrency. Recommendation: **keep batch-on-stop for M5**; define the concurrency contract (never reorder committed text; queue per segment) and defer streaming correction to M5.5 spike only if dogfood demands it.
- [ ] **Telemetry privacy model.** Confirm: **opt-in, metadata-only, local-first** — never audio/transcript content; event names + timings + error codes only; a visible on/off in Settings; document exactly what's collected. Gate: written privacy note reviewed before any event fires.
- **Gate:** the three decisions are written down (here + `docs/architecture/`), so 5.1–5.6 build against fixed contracts.

## Phase 5.1 — Reliability: reconnect + graceful errors (the backbone)

The single biggest daily-driver win — a dropped socket or a vendor 429 must never lose a dictation.

- [ ] **Streaming STT auto-reconnect.** On WS drop mid-session (all adapters: PyAI/Deepgram/OpenAI), reconnect with backoff and **resume the session** without losing buffered audio/committed text. Keepalive where required (Deepgram `KeepAlive` during silence; the ~10 s idle-close gotcha noted in `m4.4-deepgram-plan.md`).
- [ ] **Vendor 5xx/429 retry** everywhere (extend the OpenAI retry-with-backoff to PyAI + Anthropic correction/format + batch), with a cap and a clear terminal error.
- [ ] **Never-lose-audio finalize.** If the network dies before stop, the buffered PCM still batch-transcribes on reconnect/stop; if batch fails, fall back to the accumulated live transcript (already partly there) and surface a non-fatal notice.
- [ ] **Error UX pass:** the overlay banner distinguishes *transient* (retrying…) vs *terminal* (action needed: key/permission/vendor down), with the "Copy details" affordance that already exists; the `pyai-errors.log` remains the full record.
- **Acceptance:** kill Wi-Fi mid-dictation → session recovers or degrades cleanly (never a blank hang); a forced 429 retries then succeeds; a full outage shows one clear terminal message and the raw transcript is still injectable.

## Phase 5.2 — Custom vocabulary / dictionary

Make it get *your* names, product terms, and jargon right.

- [ ] **Vocabulary store:** a user-managed term list in the config store (`AppConfig.vocabulary: string[]`, or `{term, soundsLike?}`), edited in Settings.
- [ ] **Correction-side:** inject the list into `SYSTEM_PROMPT` ("preserve/spell these exactly: …") so cleanup never "corrects" a real name into a common word. Keep it token-bounded (cap the list length sent).
- [ ] **STT-side (where supported):** pass keyword/boost hints — Deepgram `keywords`/`keyterm`, OpenAI prompt param — so the raw transcript is better before correction. No-op for vendors without it.
- [ ] Tests: a fixture where "Saaslabs", "PyAI", a teammate's name survive cleanup with vs without the vocabulary.
- **Acceptance:** add 5 terms in Settings; dictate a sentence using them; they appear correctly spelled in the final output where they were garbled before.

## Phase 5.3 — Punctuation / formatting modes

One size doesn't fit chat, prose, and code.

- [ ] **Mode setting** (`AppConfig.formatMode: "prose" | "message" | "code" | "raw"`), picked in Settings (or a quick toggle on the card).
  - *prose* — current behaviour (grammar, punctuation, capitalization, lists).
  - *message* — light touch, keep it casual, minimal restructuring.
  - *code* — no auto-capitalization/punctuation, preserve symbols/case.
  - *raw* — skip the format pass entirely (cleanup only).
- [ ] Wire the mode into `FORMAT_PROMPT` selection (a small prompt map in `prompt.ts`) and the `format()` call; `raw` bypasses `format()`.
- [ ] Tests per mode over the same input.
- **Acceptance:** the same spoken sentence yields appropriately different output in each mode; `code` leaves `myVar` and `()` intact.

## Phase 5.4 — Undo / revert last result

- [ ] Implement the 5.0 decision. Baseline: a **"revert to raw"** control on the last-result card + a hotkey — re-injects the uncorrected transcript (data we already hold), for when correction over-edited.
- [ ] (If AX proves reliable) **undo insertion** — remove the just-inserted text from the target field.
- [ ] Guard: never touch a field the user has since edited (best-effort; fall back to clipboard).
- **Acceptance:** after an over-aggressive correction, one action restores exactly what you said; no corruption of the target field in the common case.

## Phase 5.5 — Edit-while-correcting / barge-in concurrency

- [ ] Enforce the 5.0 contract in the pipeline/backend: corrections queue **per segment**, committed text is **never reordered**, and a new utterance started before the prior correction returns is handled deterministically.
- [ ] (Optional spike, only if dogfood needs it) segment-level streaming correction with visible per-segment diffs — behind a flag; keep batch-on-stop as default.
- **Acceptance:** talk continuously through several pauses; output order matches speech order; no dropped or duplicated segments.

## Phase 5.6 — Telemetry (opt-in, metadata-only) + perf pass

- [ ] **Local metrics** (per the 5.0 privacy model): time-to-first-partial, correction latency p50/p95, reconnect count, error codes, vendor — **no content**. Off by default; a Settings toggle; a "what we collect" note.
- [ ] **Perf pass:** measure real correction latency on the Mac (closes the long-standing **F9**), profile memory over a long session, trim obvious hotspots (audio buffering, prompt size). Target: correction reads as "< ~1 s after you pause"; steady memory over a 30-min session.
- [ ] Confirm the streaming **finalize/end-of-utterance** handling (**F10**) is solid across vendors under reconnect.
- **Acceptance:** a local metrics view shows sane numbers; latency at/near target on a typical sentence; no memory growth over a long dogfood session.

## Phase 5.7 — Dogfood + exit

- [ ] Team uses Verbatim as the daily dictation tool for **two weeks**; triage bugs; fix blockers.
- [ ] Update `README`/docs with the new settings (vocabulary, modes, undo, telemetry).
- [ ] Full test pass green in cloud + `typecheck`; on-Mac sign-off across vendors.
- **Exit criteria (M5):** two weeks of dogfooding with **no blocking bugs**; latency + accuracy feel instant in normal use. → then **M6 (public v1.0)**.

---

## Risks / gotchas

1. **Reconnect + "never reorder committed text"** is the subtle one — resuming a stream must not duplicate or drop already-committed segments. Anchor on `utteranceId` + the accumulator's committed prefix.
2. **Vocabulary bloats the prompt** — cap the list; consider only sending terms likely present (cheap heuristic) to keep correction latency down.
3. **Undo via synthetic ⌘Z / AX** is app-specific and unreliable in some targets — that's why "revert to raw" (data-driven) ships first.
4. **PyAI is currently 404-ing** — build/measure against a healthy vendor (OpenAI/Anthropic/Deepgram); revisit PyAI once its API recovers (and **rotate the leaked test key** — M6 gate).
5. **Telemetry scope creep** — hard rule: metadata only, opt-in, documented; a content leak here would violate the product's core privacy promise.

## Sequencing

`5.0 decisions (gate) → 5.1 reliability/reconnect (biggest daily-driver win) → { 5.2 vocabulary · 5.3 formatting modes · 5.4 undo } in parallel → 5.5 concurrency contract → 5.6 telemetry + perf/F9/F10 → 5.7 dogfood + exit`

5.1 first because reliability is what makes daily use possible; 5.2/5.3/5.4 are independent quality wins; 5.6's perf pass wants the others in place to measure the real thing.
