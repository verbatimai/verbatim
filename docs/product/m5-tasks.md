# M5 — Quality & Polish (daily-driver): Task Breakdown

**Goal (North-Star slice):** make Verbatim good enough that the team dictates with it **every day** — reliable under real network/vendor flakiness, accurate on your own vocabulary, controllable (formatting modes + undo), and measurably fast. M4 proved the product *works*; M5 makes it *trustworthy*.

**Exit criteria (from the roadmap):** two weeks of internal dogfooding with **no blocking bugs**; latency and accuracy feel "instant" in normal use.

> Tracked here (per-phase checklist) + `STATUS.md` (handoff) + `roadmap.md` (milestone). Prereq: **M4 functionally complete** — packaged app runs live dictation on OpenAI/Anthropic/Deepgram; app-owned sidecar; config store + keychain; settings window.

> **RE-VERIFIED 13 Aug 2026** against the live repo after a parallel "settings-plan" effort (its own phases 1–7, see `docs/product/settings/` + `settings-plan.md`) landed a large slice of M5 ahead of this breakdown. Status below reflects what's **actually in the code**, not the original forecast. Headline: **5.2 vocabulary is done**, **5.6 telemetry scaffolding is done** (perf pass still open), and **5.1 / 5.4 are partially seeded**. See "What the parallel sessions already delivered" before planning.

---

## What already exists (starting point — don't rebuild)

- **Pipeline** (`packages/core`): STT session → segmenter → correction (compact-edits + `reconstruct`) → format; live preview via `TranscriptAccumulator`, authoritative final via **batch transcription on stop** (`transcribeBatch`). Backend bridge in `apps/backend/src/server.ts`.
- **Correction/format prompts** (`correction/prompt.ts`): one `SYSTEM_PROMPT` for cleanup + `FORMAT_PROMPT` for formatting; localized per `language` (4.7); **custom-vocabulary "Known terms" line** appended when a term list is present (byte-identical when empty). Adapters: pyai / openai / anthropic (+ `mock`); **retry-with-backoff on pyai + openai correction** (anthropic not yet).
- **Config store** (`AppConfig`, Rust — now split across `config.rs`/`keys.rs`/`secrets.rs`/`lists.rs`/`hotkey.rs`/`shortcuts.rs`/`window.rs`/`tray.rs`/`fnkey.rs`; `main.rs` slimmed): providers/models, `language`, `hotkey`, `dockIcon`, `muteOthers`, `telemetry`; `get_config`/`set_config` + `config-changed`. Keychain per-vendor (`secrets.rs`).
- **List stores** (`lists.rs`): **vocabulary** (`vocab_list/add/delete`) + **snippets** (`snip_list/add/delete`), each in its own `tauri-plugin-store` file so Reset leaves them intact; sent to the backend on the WS `start` frame.
- **Telemetry primitive** (`packages/core/src/telemetry/telemetry.ts` + test): opt-in, allow-list `sanitize()` (content-free by construction), `NoopSink` default (**transport parked**); wired in `server.ts` (session_start / session_finalize / error) and toggled in Settings.
- **Error surfacing:** the backend logs every provider error in full to `logs/pyai-errors.log`, sends a truncated `error` frame to the overlay banner, and emits a metadata-only telemetry `error` event; an invalid correction vendor falls back instead of killing the session (M4 hardening).
- **Settings window** (redesigned nav shell, `app.html`): providers/models, keys, hotkey capture, language, mute, permissions, vocabulary + snippets editors, telemetry toggle.
- **Bonus already shipped (beyond M5 scope):** snippet/text-expansion (`expandSnippets`), fn-key hold (`fnkey.rs`, the M3-deferred native path), paste-last-result global accelerator.

So M5 is **reliability + accuracy + control + measurement + dogfood** on top of a working pipeline — mostly additive, behind the interfaces that already exist. **A meaningful part is now done — re-scope, don't rebuild.**

---

## What the parallel sessions already delivered (map to M5)

| M5 phase | Delivered by settings-plan | State |
|---|---|---|
| 5.2 Vocabulary | store (`lists.rs`), correction-side prompt injection (all 3 adapters via `vocabularyNote`), Deepgram `keywords`/`keyterm` STT boost, tests (`vocabulary.test.ts`) | **DONE** (bar OpenAI-STT prompt hint + on-Mac click test) |
| 5.6 Telemetry | `Telemetry` primitive (opt-in, allow-list, NoopSink), wired into `server.ts` events, Settings toggle | **Scaffolding DONE**; transport parked; **perf pass / F9 / F10 still open** |
| 5.1 Reliability | retry-with-backoff on **pyai + openai** correction adapters | **PARTIAL** — no STT reconnect/keepalive, no anthropic/batch retry |
| 5.4 Undo | paste-last-result accelerator re-injects the **last finalized (clean)** transcript; last-result state kept in `state.rs` | **PARTIAL** — plumbing exists; "revert to **raw**" semantics not built |
| 5.0 Decisions | telemetry privacy model **locked & implemented** (opt-in, metadata-only, transport parked) | telemetry decision **DONE**; undo + concurrency decisions still open |

Not started by the parallel work: **5.3 formatting modes**, **5.5 concurrency contract**, **5.7 dogfood**. (Note `draft-mode.md` is a *separate, larger* generative-compose feature — PARKED, not the same as 5.3 formatting modes.)

---

## Implementation status — 13 Aug 2026 (build session)

A dedicated build session implemented the remaining M5 code on top of the parallel settings-plan work. State now:

- **5.0 ✅ decided/recorded** — `docs/architecture/reliability-undo-concurrency.md` (undo = revert-to-raw first; concurrency = keep batch-on-stop + a 4-rule contract; telemetry model already locked).
- **5.1 ✅ implemented** (Mac verify) — shared `net/retry` helper; retry on Anthropic correction + all `transcribeBatch`; Deepgram `KeepAlive`; `startReconnectingSession()` live-socket wrapper (+ initial-connect retry) wired into the backend for live sessions; transient/terminal error kinds + `status` frames. 5 reconnect unit tests green.
- **5.2 ✅ done** — vocabulary (from the settings-plan) + the residual OpenAI-STT keyword prompt-bias added.
- **5.3 ✅ implemented** — `FormatMode` (prose|message|code|raw) + `FORMAT_PROMPTS` map threaded through all 3 adapters, pipeline, and backend; `raw` skips format; Rust `AppConfig.formatMode` + a Settings "Formatting mode" dropdown; sent on the WS start frame. Per-mode tests green. (Rust needs `cargo build` on the Mac.)
- **5.4 ✅ implemented** — `LAST_RAW` state + `set_last_raw`/`revert_to_raw` commands; the webview records the raw transcript on the correction frame; a configurable revert-to-raw global accelerator (mirrors paste-last) with a Settings capture row. (Rust needs `cargo build` on the Mac.)
- **5.5 ✅ implemented** — concurrency contract (doc) + backend guard: reject a `start` mid-finalize, ignore audio during finalize.
- **5.6 ⏳ telemetry latency capture done** — `sttLatencyMs`/`correctionLatencyMs`/`formatLatencyMs` now populated on the `session_finalize` event; the real **perf pass (F9 memory/latency on the Mac) + F10 under reconnect** remains.
- **5.7 ⏳ plan written** (`m5.7-dogfood-exit.md`); the two-week dogfood + on-Mac sign-off is the remaining human work.

**Verification:** all 184 core unit tests green + typecheck clean across every workspace (run in a Linux harness — the Mac `node_modules` can't run vitest under the cloud VM). Rust `src-tauri` (5.3 config, 5.4 undo) compiles only on the Mac.

**Remaining to close M5:** on-Mac `cargo build`/`npm run widget` verify of the Rust + live reconnect; the 5.6 perf pass; the 5.7 two-week dogfood; then the M6 gate (rotate the leaked PyAI test key).

---

## Phase 5.0 — Decisions / spike ✅ DONE

Lock the few choices the rest depends on, before building.

- [ ] **Undo semantics.** Decide what "undo" reverts: (a) the *insertion* (remove the text we just injected), (b) the *correction* (re-inject the raw/uncorrected transcript), or both. **Note:** a paste-last accelerator already re-injects the last *clean* result, so the injection/last-result plumbing (`state.rs`, `shortcuts.rs`) exists — 5.4 mainly needs the *raw* variant. Recommendation: ship **(b) re-inject raw** first (safe, data-driven), add (a) if the AX path proves reliable.
- [ ] **Edit-while-correcting model.** Today's path is **batch-on-stop**, so mid-session barge-in is limited. Recommendation: **keep batch-on-stop for M5**; define the concurrency contract (never reorder committed text; queue per segment) and defer streaming correction to 5.5 spike only if dogfood demands it.
- [x] **Telemetry privacy model.** ✅ **DONE** — opt-in, metadata-only, local-first is implemented and documented in `telemetry.ts` (allow-list `ALLOWED_FIELDS`, `NoopSink`, no fetch/beacon). Transport endpoint deliberately **parked** (settings-plan §10.1). Settings toggle is off by default.
- **Gate:** the remaining two decisions (undo, concurrency) are written down (here + `docs/architecture/`), so 5.1/5.4/5.5 build against fixed contracts. Telemetry gate already cleared.

## Phase 5.1 — Reliability: reconnect + graceful errors ✅ IMPLEMENTED (Mac verify)

The single biggest daily-driver win — a dropped socket or a vendor 429 must never lose a dictation. **Partially seeded** (correction retry on 2 of 3 vendors); the streaming-reconnect core is the real remaining work.

- [ ] **Streaming STT auto-reconnect.** On WS drop mid-session (all adapters: PyAI/Deepgram/OpenAI) reconnect with backoff and **resume the session** without losing buffered audio/committed text. Keepalive where required (Deepgram `KeepAlive` during silence; the ~10 s idle-close gotcha in `m4.4-deepgram-plan.md`). *Today the adapters only surface `onClose`/`onError` — no reconnect/resume yet.*
- [ ] **Vendor 5xx/429 retry** everywhere. **Done for pyai + openai correction; extend to Anthropic correction/format + the batch-transcription call + STT connect**, with a cap and a clear terminal error.
- [ ] **Never-lose-audio finalize.** If the network dies before stop, the buffered PCM still batch-transcribes on reconnect/stop; if batch fails, fall back to the accumulated live transcript and surface a non-fatal notice.
- [ ] **Error UX pass:** the overlay banner distinguishes *transient* (retrying…) vs *terminal* (action needed: key/permission/vendor down), with a "Copy details" affordance; `pyai-errors.log` + the telemetry `error` event remain the full record.
- **Acceptance:** kill Wi-Fi mid-dictation → session recovers or degrades cleanly (never a blank hang); a forced 429 retries then succeeds; a full outage shows one clear terminal message and the raw transcript is still injectable.

## Phase 5.2 — Custom vocabulary / dictionary ✅ DONE (verify on-Mac)

Make it get *your* names, product terms, and jargon right. **Implemented by the settings-plan.**

- [x] **Vocabulary store** — `AppConfig`-adjacent list store in `lists.rs` (`vocabulary.json`), edited in Settings; survives Reset.
- [x] **Correction-side** — `vocabularyNote()` in `prompt.ts` appends a "Known terms" line, threaded through pyai / openai / anthropic `correct()` + `format()`; byte-identical when the list is empty (test asserts this).
- [x] **STT-side** — Deepgram `keywords` (nova-2) / `keyterm` (nova-3) boost params on connect (`vocabulary.test.ts` asserts they reach the wire).
- [ ] **STT-side (residual):** OpenAI STT `prompt` param hint — not yet wired (no-op for vendors without it). Optional.
- [x] Tests — `vocabulary.test.ts` (prompt injection + Deepgram query params).
- [ ] **On-Mac check:** add 5 terms in Settings; dictate a sentence using them; confirm they appear correctly spelled in the final output where they were garbled before.

## Phase 5.3 — Punctuation / formatting modes ✅ IMPLEMENTED (Rust: Mac compile)

One size doesn't fit chat, prose, and code. **No `formatMode` in the code yet.** (Distinct from the parked, generative `draft-mode.md`.)

- [ ] **Mode setting** (`AppConfig.formatMode: "prose" | "message" | "code" | "raw"`), picked in Settings (or a quick toggle on the card).
  - *prose* — current behaviour (grammar, punctuation, capitalization, lists).
  - *message* — light touch, keep it casual, minimal restructuring.
  - *code* — no auto-capitalization/punctuation, preserve symbols/case.
  - *raw* — skip the format pass entirely (cleanup only).
- [ ] Wire the mode into `FORMAT_PROMPT` selection (a small prompt map in `prompt.ts`) and the `format()` call; `raw` bypasses `format()`.
- [ ] Tests per mode over the same input.
- **Acceptance:** the same spoken sentence yields appropriately different output in each mode; `code` leaves `myVar` and `()` intact.

## Phase 5.4 — Undo / revert-to-raw ✅ IMPLEMENTED (Rust: Mac compile)

- [ ] Implement the 5.0 decision. Baseline: a **"revert to raw"** control on the last-result card + a hotkey — re-injects the *uncorrected* transcript (data we already hold), for when correction over-edited. **Reuse** the existing last-result state (`state.rs`) and paste-last accelerator (`shortcuts.rs`) — today they re-inject the *clean* result; add the *raw* variant.
- [ ] (If AX proves reliable) **undo insertion** — remove the just-inserted text from the target field.
- [ ] Guard: never touch a field the user has since edited (best-effort; fall back to clipboard).
- **Acceptance:** after an over-aggressive correction, one action restores exactly what you said; no corruption of the target field in the common case.

## Phase 5.5 — Edit-while-correcting / barge-in concurrency ✅ IMPLEMENTED (contract + guard)

- [ ] Enforce the 5.0 contract in the pipeline/backend: corrections queue **per segment**, committed text is **never reordered**, and a new utterance started before the prior correction returns is handled deterministically.
- [ ] (Optional spike, only if dogfood needs it) segment-level streaming correction with visible per-segment diffs — behind a flag; keep batch-on-stop as default.
- **Acceptance:** talk continuously through several pauses; output order matches speech order; no dropped or duplicated segments.

## Phase 5.6 — Telemetry (opt-in, metadata-only) + perf pass (telemetry DONE; perf open)

- [x] **Telemetry primitive + wiring** — `Telemetry` (opt-in, allow-list `sanitize`, `NoopSink`), emitting session_start / session_finalize / error from `server.ts`; Settings toggle (off by default); "what we collect" documented in `telemetry.ts`. **Transport parked** (no endpoint chosen — the injectable `sink` is the seam).
- [ ] **Populate the latency fields.** `ALLOWED_FIELDS` already defines `sttLatencyMs`/`correctionLatencyMs`/`formatLatencyMs`, but the finalize event currently emits only provider ids + `rawLen`/`cleanLen`. Time each pass and include the ms — this is what closes **F9** as a measured number rather than a feel.
- [ ] **Perf pass:** measure real correction latency on the Mac (**F9**), profile memory over a long session, trim obvious hotspots (audio buffering, prompt size — cap vocabulary tokens). Target: correction reads as "< ~1 s after you pause"; steady memory over a 30-min session.
- [ ] Confirm streaming **finalize/end-of-utterance** handling (**F10**) is solid across vendors under reconnect.
- [ ] **(Deferred, needs a decision)** pick a telemetry transport/sink if/when opt-in metrics should leave the device; until then NoopSink stays.
- **Acceptance:** a local metrics view shows sane numbers; latency at/near target on a typical sentence; no memory growth over a long dogfood session.

## Phase 5.7 — Dogfood + exit (plan written; dogfood pending)

- [ ] Team uses Verbatim as the daily dictation tool for **two weeks**; triage bugs; fix blockers.
- [ ] Update `README`/docs with the new settings (vocabulary, snippets, telemetry toggle; modes + undo once built).
- [ ] Full test pass green in cloud + `typecheck`; on-Mac sign-off across vendors.
- **Exit criteria (M5):** two weeks of dogfooding with **no blocking bugs**; latency + accuracy feel instant in normal use. → then **M6 (public v1.0)**.

---

## Risks / gotchas

1. **Reconnect + "never reorder committed text"** is the subtle one — resuming a stream must not duplicate or drop already-committed segments. Anchor on `utteranceId` + the accumulator's committed prefix. *(Still the top unbuilt risk — 5.1's core.)*
2. **Vocabulary bloats the prompt** — the store is unbounded today; cap the list sent (and/or only send terms likely present) to keep correction latency down. *(Now live, so this is a real latency lever.)*
3. **Undo via synthetic ⌘Z / AX** is app-specific and unreliable in some targets — that's why "revert to raw" (data-driven) ships first; the paste-last plumbing already proves re-injection works.
4. **PyAI is currently 404-ing** — build/measure against a healthy vendor (OpenAI/Anthropic/Deepgram); revisit PyAI once its API recovers (and **rotate the leaked test key** — M6 gate).
5. **Telemetry scope creep** — hard rule enforced in code: metadata only (allow-list), opt-in, transport parked; a content leak here would violate the product's core privacy promise. Keep `sanitize()` an allow-list.

## Sequencing (revised)

`5.0 (undo + concurrency decisions — telemetry already locked) → 5.1 reliability/reconnect (biggest remaining daily-driver win) → { 5.3 formatting modes · 5.4 revert-to-raw } in parallel → 5.5 concurrency contract → 5.6 perf pass + latency capture (F9/F10) → 5.7 dogfood + exit`

5.2 vocabulary is **done**, so it drops out of the critical path. 5.6's telemetry scaffolding is done; only the perf pass + latency capture remain and they want 5.1/5.3 in place to measure the real thing. 5.1 is now first-among-unbuilt because reliability is what makes daily use possible.
