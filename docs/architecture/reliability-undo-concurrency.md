# Reliability, Undo, and Concurrency Contracts

**Status / gate:** Phase 5.0 — 13 Aug 2026. This record fixes three contracts that the rest of M5 builds against. Decisions 1 and 2 are decided here and scheduled; Decision 3 is already implemented and its gate is cleared.

## Context

Verbatim runs a "batch-on-stop" product path. While the user speaks, the live STT WebSocket stream is only a rolling *preview* — useful for feedback, never authoritative. On stop, the backend (`apps/backend/src/server.ts`) batch-transcribes the full buffered PCM via `stt.transcribeBatch` to produce the ONE authoritative transcript. That transcript then passes through cleanup (compact-edit correction) and formatting, and the final text is injected into the focused field.

Two backend invariants matter here. The server buffers every audio frame into an `audio: Uint8Array[]` array for the whole session, and a `finalizing` boolean guards `finalize()` so it runs exactly once. The live display transcript is built separately by `TranscriptAccumulator`, which is utterance-scoped: it holds committed finals plus the current utterance's live hypothesis, and each utterance contributes exactly once so overlapping partial windows cannot stack.

On the injection side, a paste-last-result global accelerator already exists in Rust (`shortcuts.rs`), backed by last-result state (`state.rs`). It re-injects the last finalized (clean) transcript with no webview involvement.

## Decision 1 — Undo semantics (drives Phase 5.4)

Ship **"revert to raw" first**: a control on the last-result card plus a hotkey that re-injects the *uncorrected* transcript — the pre-correction `raw` we already hold at finalize time — for the case where the correction/format pass over-edited. This is the safe, data-driven option. We already possess the raw transcript and the whole injection plumbing, so revert-to-raw is a data swap through machinery we ship today.

Contrast this with option (a), "undo the insertion" — removing the just-inserted characters via a synthetic ⌘Z or an AX write. That path is app-specific and unreliable in several target applications, whose undo stacks and accessibility write behavior we do not control. It is therefore **deferred behind an AX-reliability spike** and is not on the M5 critical path.

The guard for revert-to-raw is best-effort only. If the user has edited the target field since injection, we do not attempt to rewrite it — we fall back to placing the raw text on the clipboard rather than corrupting the field. Implementation reuses the existing last-result state and paste-last accelerator: we add a parallel "last RAW" slot alongside the existing clean slot, plus a second accelerator and a second button on the card. No new injection mechanism is introduced.

## Decision 2 — Edit-while-correcting / concurrency contract (drives Phase 5.5)

**Keep batch-on-stop for M5.** We do not introduce segment-level streaming correction now. The concurrency contract is defined precisely as four rules. First, exactly one finalize runs per session, enforced by the existing `finalizing` guard. Second, committed text is never reordered — the accumulator is utterance-scoped and deterministic, so ordering is fixed at commit time. Third, a `start` frame arriving while a prior session is still finalizing must be handled deterministically: it is rejected or queued rather than allowed to interleave two sessions on one connection. Fourth, audio frames arriving after `stop` or during finalize are ignored, not appended to the buffer.

Batch-on-stop is what makes this tractable. Because the authoritative result is a single batch transcription of the whole buffered clip, there is no multi-segment correction ordering problem to solve in M5 — there are no per-segment diffs to reconcile, no risk of a later segment's correction invalidating an earlier committed one. The entire correction pass sees the complete input at once.

True segment-level streaming correction with per-segment diffs remains an **optional future spike**, gated behind a flag, and pursued only if dogfooding demands lower perceived latency. Batch-on-stop stays the default regardless.

## Decision 3 — Telemetry privacy model (LOCKED / implemented)

The telemetry model is opt-in, metadata-only, and local-first. It never records audio or transcript content. The allow-list in `packages/core/src/telemetry/telemetry.ts` is the hard content-free boundary: `sanitize()` emits only explicitly permitted fields, which is content-free by construction. A deny-list would be unsafe — it would leak any field someone forgot to enumerate — so the allow-list is deliberate. Network transport is parked: the default is `NoopSink`, so nothing leaves the machine today. A visible on/off toggle in Settings controls it, and it is off by default. It is already wired into the backend, emitting session_start, session_finalize, and error events. This decision's gate is cleared because the code already enforces it.

## What this unblocks

Decision 1 unblocks Phase 5.4 by fixing undo semantics to revert-to-raw, letting that phase build a UI and hotkey against data and plumbing we already hold, with insertion-undo cleanly deferred behind a spike. Decision 2 unblocks Phase 5.5 by giving the concurrency work a precise, four-rule contract to implement and test against, with batch-on-stop as the stable default. Decision 3 unblocks the error-UX and telemetry work in Phases 5.1 and 5.6, since the privacy boundary is already locked and enforced in code — those phases can emit and surface events without relitigating what is safe to collect.
