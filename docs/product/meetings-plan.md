# Meetings ("Granola mode") — Goal & Milestone Plan

**Owner:** Mayank Banga · Saaslabs
**Date:** 13 Aug 2026
**Status:** proposal — nothing here is committed until the **N0 spike** clears its gate.
**Scope:** extend Verbatim from a dictation widget into a dictation widget **+ botless meeting notepad**, in one app, on one engine.
**Relationship to the roadmap:** this is a **parallel track (`N0`–`N5`)**, not a renumbering of `M5`/`M6`. See §9 for how the two tracks interleave.

---

## 0. Guardrails (read before touching code)

- **Rust builds only on the Mac.** Everything in this plan is Rust-heavy (audio capture, storage). `cargo build` / `npm run widget` verification happens on the Mac, not in a cloud session.
- **The vendor-agnostic contract does not change.** New capabilities go through `packages/core`'s existing `providers/registry` + `correction/registry` + `settings.ts` capability layer. No meeting feature may hard-code a vendor.
- **Local-first is a product promise, not a default.** Audio, transcripts and notes stay on the user's disk. The only bytes that leave the machine are the audio/text the user's *own* vendor key pays for. No Verbatim server in this track.
- **Recording is a consent surface.** Every design decision below assumes a visible recording indicator and an explicit user action. Legal review (two-party consent states, GDPR) is a gate on N1, not an afterthought.
- **Security gate still applies** to every PR: secret-scan + SAST + dep-audit.
- **Retention is a setting, and the default is aggressive.** Audio is the riskiest artefact we will ever hold. Default: delete raw audio after the transcript is final.

---

## 1. North star

> **Verbatim turns what you say into what you meant — whether you're talking to a text field or to five people on a call.**

Two modes, one engine:

| Mode | Trigger | Input | Output |
|---|---|---|---|
| **Dictate** (today) | ⌥Space | your mic, ~30s bursts | clean text injected into the focused field |
| **Meetings** (this plan) | calendar / manual | your mic **+** system audio, 30–90 min | a structured note built from your shorthand + the transcript |

Both ride the same `packages/core` pipeline: STT adapter → correction/format adapter → output. The meeting mode is not a new product; it is the same pipeline pointed at a longer, two-channel input with a different rendering target.

### Why Verbatim has a right to win this

Granola is very good and well funded. We do not beat it on polish in year one. We beat it on four things it structurally cannot offer:

1. **Local-first.** Their transcripts live on their servers. Ours never leave the laptop. For SaaSLabs' own security-reviewed customers — and for legal, healthcare, finance, and anyone under a DPA — that is not a feature, it is the entire buying decision.
2. **BYOK, no AI markup.** The user pays Deepgram/OpenAI/Anthropic directly (~$0.30–$0.90 per 90-min meeting at list price). No per-seat SaaS tax on top of inference we didn't run.
3. **MIT open source.** Auditable. Self-hostable when we add sync. A security team can read the capture code.
4. **Dictation *inside* the meeting.** This is the one nobody else has. Granola makes you *type* shorthand during a call. We already ship a non-activating overlay that injects clean text without stealing focus — so you can **speak** your side-notes mid-meeting into the notepad. That is a genuinely differentiated interaction and it falls out of work we have already done.

### Non-goals (v1 of this track)

- No meeting **bot** / no joining calls as a participant. Botless is the whole point.
- No video, no screen recording, no "AI copilot overlay that reads your screen." Different product, different trust story.
- No team workspaces, accounts, or server-side sync. (Revisited in N5+.)
- No mobile, no Windows meeting capture (Windows lands with `M6` for dictation first).
- No real-time coaching / live answer suggestions. That market is loud and we don't want the association.

---

## 2. The gating spike — **N0** (must clear before N1 starts)

Same shape as the M3 Phase 3.0 spikes: three narrow probes, each with a binary answer, no product code. **Budget: one focused week on the Mac.**

### N0-A · Dual-stream capture with an *audio-only* permission

**Question:** can a Tauri/Rust app capture system output audio + mic as two separate streams, on a permission prompt that says "audio", not "this app can see your screen"?

**Approach:** **Core Audio process taps** (`CATapDescription` → `AudioHardwareCreateProcessTap` → `AudioHardwareCreateAggregateDevice`) via the [`cidre`](https://crates.io/crates/cidre) crate. Requires `NSAudioCaptureUsageDescription` in Info.plist; grants land in *Privacy & Security → Screen & System Audio Recording* but the prompt is audio-scoped. macOS 14.4+ floor in practice (14.2 is the API floor; early point releases were buggy). Two shipped Tauri apps already do this — [Cap](https://github.com/CapSoftware/Cap) and [Meetily](https://github.com/Zackriya-Solutions/meeting-minutes) — both on cidre.

**Fallback:** ScreenCaptureKit audio-only (`capturesAudio`, plus `captureMicrophone` on macOS 15+) via the [`screencapturekit`](https://crates.io/crates/screencapturekit) crate. Covers macOS 13, but costs the Screen Recording TCC prompt and exposure to macOS 15's picker / re-consent tightening. **Third-tier escape hatch:** a BlackHole-style HAL plugin — rejected for v1 (admin install, user must change their output device).

**Exit criteria**
- A 10-minute Zoom **and** Google Meet call captured as two independent WAVs (mic, system), no dropouts, no feedback loop.
- Only the audio permission is requested. Screen Recording is never prompted.
- CPU overhead measured and under ~5% on the test Mac; memory flat over 10 minutes.
- Behaviour documented for: no permission yet, permission denied, headphones/AirPods switch mid-call, output device change mid-call, display sleep, and `muteBehavior` verified (we tap without silencing the user's speakers).

**Known unknown to resolve in the spike:** there is **no public API to pre-flight or request** the system-audio permission — you discover the state when the aggregate device fails to start. AudioCap uses private TCC SPI; we will not ship private SPI. So N0-A must also produce the **first-run UX design that works without a pre-flight check** (attempt → detect failure → deep-link to System Settings → re-check on focus).

### N0-B · Long-session economics and architecture

**Question:** does the current pipeline survive 90 minutes, and what does it cost?

This is the probe most likely to force a design change, because **the M2 "batch-transcribe the whole file on stop" trick does not scale.** It is the reason our final output is clean today, and it breaks at meeting length: OpenAI's file endpoint caps at 25 MB, latency on a 90-minute file is minutes not seconds, and a crash at minute 88 loses everything.

**Probe:** stream a 90-minute recording through each vendor. Measure cost, wall-clock, memory, reconnect behaviour on a forced network drop, and transcript quality vs. the batch baseline.

**Reference list prices (verify in the spike):**

| Vendor | Streaming | + Diarization | ~90 min |
|---|---|---|---|
| AssemblyAI Universal-Streaming | $0.15/hr | $0.12/hr | **~$0.41** |
| Deepgram Nova-3 | ~$0.46/hr | ~$0.12/hr | ~$0.87 |
| OpenAI `gpt-4o-transcribe` | $0.36/hr | file-only | $0.54 |
| OpenAI `gpt-4o-mini-transcribe` | $0.18/hr | file-only | $0.27 |

**Expected outcome — the "chunked batch" design.** Replace whole-file batch with **segment-level batch**: roll audio into ~5-minute segments, batch-transcribe each on close, append to a durable timestamped transcript. Keeps the accuracy advantage of batch, bounds file size and memory, makes the session crash-recoverable, and gives us mid-meeting enhancement for free. The live stream stays as the on-screen preview, exactly as it does in dictation today.

**Exit criteria**
- A 90-minute session transcribed end to end for **under $1** at list price with **no data loss** across a forced network drop and a laptop sleep.
- A written recommendation for the durable-transcript design and the default meeting vendor.
- The `mergeOverlap` / `stitch` behaviour characterised at segment boundaries (this is already a known weak spot — see STATUS.md's stitch-artifact caveat).

### N0-C · Enhancement quality

**Question:** can sparse human notes + a transcript produce a note the user would actually send — using the correction adapters we already have?

**Probe:** no UI. A CLI that takes `(transcript, sparse notes, template)` and emits a note, run against **3–5 real recorded meetings** of different shapes (1:1, standup, customer call, design review). Blind-compare Anthropic vs OpenAI outputs. Test the failure mode that matters: the model must not **invent** decisions or action items that were never said.

**Exit criteria**
- On 5 real meetings, the enhanced note beats the raw notes on a written rubric (accuracy, completeness, no hallucinated commitments), judged by two people.
- A documented prompt + template format, and a measured hallucination rate on action items — with a hard requirement that every action item is traceable to a transcript span.
- Token cost per meeting measured (a 90-min transcript is roughly 15–20k tokens; enhancement should be single-digit cents).

### The gate

**All three green → commit to N1–N4.** Any red → stop and re-decide in writing. Specifically:
- **A red** → the meeting mode may not be viable as a Tauri app at acceptable UX; consider the SCK fallback and accept the Screen Recording prompt, or defer.
- **B red** → re-scope to shorter sessions or a cheaper vendor floor before building UI.
- **C red** → the product is a *transcript* tool, not a *notes* tool. That is a much weaker product and should change the positioning before we build it.

---

## 3. N1 — Capture & durable transcript *(the recorder)*

**Goal:** reliably record a real meeting and produce a readable, speaker-labelled transcript stored on disk.

**Deliverables**
- Rust capture module (`src-tauri/src/capture.rs`): dual-stream tap + mic, segment writer, device-change and sleep handling.
- **Durable session store** — SQLite (sessions, segments, speakers, notes) + audio segments on disk. Crash-safe: kill the app mid-meeting, reopen, the transcript is intact.
- **Speaker labelling by stream** — "Me" (mic) vs "Them" (system). This is what Granola ships by default and it is free given two streams. *Diarization of multiple remote speakers is deliberately deferred* (see §6).
- **Meetings window** — the main app shell from the recent redesign gets a meetings list: sessions, dates, durations, transcripts, search. Manual start/stop from the tray and the window.
- **Recording indicator** — tray state + an unmissable in-app indicator whenever audio is being captured. Non-negotiable.
- **Retention settings** — audio auto-delete (default: on transcript finalization), transcript retention, one-click "delete this meeting and its audio".
- Permission first-run flow from N0-A, wired for real.

**Exit criteria:** record a real 60-minute meeting end to end; the transcript is readable and correctly attributed Me/Them; the session survives a network blip and a lid-close; deleting a meeting removes the audio from disk; no bytes leave the machine except to the user's own STT vendor.

**Cross-cutting gate:** written legal/consent review signed off before N1 ships — recording-consent copy, jurisdiction guidance in the docs, and the indicator design.

---

## 4. N2 — Notes & enhancement *(the magic)*

**Goal:** the Granola loop — you jot almost nothing, you get a real note.

**Deliverables**
- **The notepad**: a markdown editor alongside the live transcript. Type shorthand during the call.
- **Dictate into the notepad** — the differentiator. ⌥Space mid-meeting speaks a side-note into the note without stealing focus from Zoom. This reuses the existing overlay + injection path almost unchanged, and it is the demo that makes people understand why these two features belong in one app.
- **Enhancement on stop**: `(sparse notes + transcript + template) → structured note`, through the existing correction registry, so any vendor works.
- **Template library**: 1:1, standup, customer discovery, design review, interview, plus user-defined. Templates are files, versioned, shareable.
- **Provenance UI** — reuse the visible-correction idea we already own: show which parts of the note came from *your* notes vs. the *transcript*, and let any action item jump to its transcript timestamp. This is our answer to "did the AI make this up?", and it is a genuinely better trust story than a plain enhanced note.
- **Mid-meeting enhancement** (falls out of the chunked-batch design): a running summary the user can peek at without stopping.
- Export: Markdown and clipboard.

**Exit criteria:** across 5 real meetings, the enhanced note is one the owner would send without rewriting; every action item traces to a transcript span; a side-note dictated mid-meeting lands in the note without focus loss.

---

## 5. N3 — Calendar & auto-pilot

**Goal:** stop making the user remember to press record.

**Deliverables**
- **EventKit** calendar read (local, no OAuth, no server) — today's meetings, titles, attendees.
- Auto-title and auto-attach attendees; auto-prompt (not auto-start — consent) when a calendar meeting begins and a known meeting app has audio.
- **Meeting detection** by tapping a specific PID (Zoom/Meet-in-Chrome/Teams/Slack huddle) rather than system-wide — a direct benefit of the process-tap approach.
- **Pre-meeting brief**: what we discussed last time with these people, open action items.
- Optional: real speaker names via macOS Accessibility reading Zoom's participant list — the same AX machinery we already built for `axinject.rs`. (Granola does exactly this rather than diarization.)

**Exit criteria:** one full week of the owner's meetings captured with zero manual starts and correct titles/attendees.

---

## 6. N4 — Recall *(chat over your meetings)*

**Goal:** "what did we decide about pricing?" answered across every meeting you've ever had, locally.

**Deliverables**
- Local index over notes + transcripts (SQLite FTS first; local embeddings only if FTS proves insufficient — do not reach for a vector DB by reflex).
- Ask-within-a-meeting and ask-across-meetings, through the existing correction/LLM adapters.
- **Citations are mandatory**: every answer links to meeting + timestamp. An uncited answer is a bug.

**Exit criteria:** correctly answers a question about a three-week-old meeting with a working citation, with the index built entirely on-device.

---

## 7. N5+ — Later (explicitly not now)

Sharing (Notion/Slack/Drive export to *user-owned* destinations first), optional end-to-end-encrypted sync, team spaces, Windows meeting capture, mobile capture for in-person meetings, an MCP server exposing your local meetings to Claude/Cursor. **Any of these that introduces a Verbatim server is a separate decision with its own security review — it is the moment we stop being local-only, and it should be made deliberately, not drifted into.**

---

## 8. Architecture implications

| Area | Change |
|---|---|
| `packages/core` | New `meetings/` module: `SessionStore`, `Enhancer`, `TemplateRegistry`, segment stitching. Reuses `providers/registry`, `correction/registry`, `settings.ts` capability layer unchanged. |
| Capability layer | New capabilities: `long_form`, `diarization`, `word_timestamps`. `capabilityErrors()` must refuse invalid meeting combos the way it already refuses invalid dictation ones. PyAI Hear is unproven at meeting length — the meeting default is likely Deepgram or AssemblyAI, decided by N0-B. |
| Transcript model | The `TranscriptAccumulator` is built for a ~30-second utterance and **should not be stretched** to 90 minutes. Meetings get an append-only, timestamped, speaker-tagged segment store. Different problem, different structure. |
| Storage | SQLite (`rusqlite` or `tauri-plugin-sql`) + audio segments as Opus/m4a on disk under the app support dir, `0600`. |
| Rust | New `capture.rs` (cidre). This is the largest single chunk of new Rust in the project's history and it is all Mac-verified work. |
| Windows | Capture is macOS-only for this whole track. Windows meeting capture (WASAPI loopback) is a later, separate spike. |
| Sidecar | The 4.8 sidecar model (app owns the backend, keys injected from storage, never through the renderer) carries over unchanged — meetings must not regress it. |
| Settings | Meeting vendor/model selection, retention policy, auto-start behaviour, per-app tap allowlist. Folds into the existing `settings-plan.md` waves rather than inventing a second settings system. |

---

## 9. Sequencing against the existing roadmap

```
dictation track:  M4 (finishing) ─→ M5 quality/polish ─→ M6 OSS v1.0 ─→ …
meetings track:            N0 spike ─┬─→ N1 capture ─→ N2 notes ─→ N3 calendar ─→ N4 recall
                                     └─ (gate: all three probes green)
```

- **N0 can start now**, in parallel with M4's remaining on-Mac verification — it is a spike, it touches no product code, and its answers change what M5 should even contain.
- **N1 should not start before M4 is signed off.** Two half-finished tracks is the failure mode here.
- **M6 (public v1.0) ships the dictation product.** The meetings track is v2 positioning. Trying to ship both at v1.0 delays the thing that already works.
- **M5 (quality/polish) and N1 compete for the same weeks.** That is the real scheduling decision (see §11).

---

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| System-audio permission UX (no pre-flight API) | **High** | N0-A produces the failure-first UX; deep-link to System Settings; re-check on window focus |
| macOS 14.4+ floor excludes older Macs | Medium | Measure the actual user base; SCK fallback covers macOS 13 at the cost of the Screen Recording prompt |
| Apple tightens capture APIs again (as in macOS 15) | Medium | Prefer Core Audio taps over ScreenCaptureKit precisely because they sit outside the screen-capture consent regime |
| Enhancement hallucinates decisions/action items | **High** | N0-C measures it; provenance UI + mandatory transcript traceability in N2; never claim an action item without a span |
| Long-session cost surprises the user | Medium | Live cost meter in the meetings UI; cheap-vendor default; BYOK means they see their own bill |
| Recording consent / legal exposure | **High** | Legal review gates N1; visible indicator; jurisdiction guidance in docs; audio deleted by default |
| Scope: this track is bigger than M1–M4 combined | **High** | The N0 gate exists for this reason. Do not start N1 without a green gate and a decision on §11 |
| Granola ships the local-first story first | Low–Medium | They're cloud-native with a retention-tier business model; it is not a fast pivot for them |

---

## 11. Decisions needed from you

1. **Track naming** — `N0–N4` as a parallel track (proposed), or renumber into `M7–M11` after the OSS release? Parallel keeps M5/M6 intact and lets N0 start now.
2. **M5 vs N1 priority** — after M4, does the team polish dictation to daily-driver quality (M5), or start the recorder (N1)? My read: **finish M5**. A meeting notepad built on a dictation engine nobody dogfoods daily is building on sand — and M5's dogfooding is what surfaces the bugs N2 would otherwise inherit.
3. **macOS floor** — is 14.4+ acceptable for meeting mode (dictation stays lower)? This decides Core Audio taps vs. ScreenCaptureKit, and it is hard to reverse later.
4. **Meeting STT vendor default** — AssemblyAI is ~half Deepgram's cost with better streaming diarization, but it is a **fifth vendor adapter** to build and maintain. Add it, or default meetings to Deepgram and stay at four?
5. **Is this a Verbatim feature or a second product?** You chose "second mode, same app," which I agree with — but it's worth naming that this changes what Verbatim *is*, and therefore what `README.md`, `product-plan.md` §1 and the public positioning say at v1.0.

---

## 12. Immediate next steps

1. Answer §11.1–11.3 (they change the spike's shape).
2. Schedule **N0** — one week on the Mac. A, B and C are independent and can run in any order; **B is the most likely to force a redesign, so run it first if time is tight.**
3. Add an `n0-spike.md` task doc (same format as `m3-tasks.md` / `m4-tasks.md`) with per-probe checklists once the shape is agreed.
4. Reference this doc from `roadmap.md` and add the N-track to the sequencing diagram — **after** §11.1 is decided, so the numbering doesn't have to change twice.

---

## Appendix — research sources (13 Aug 2026)

- Core Audio taps: [Apple — Capturing system audio with Core Audio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps), [`CATapDescription`](https://developer.apple.com/documentation/coreaudio/catapdescription), [`NSAudioCaptureUsageDescription`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsaudiocaptureusagedescription), [insidegui/AudioCap](https://github.com/insidegui/AudioCap)
- ScreenCaptureKit: [`capturesAudio`](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturesaudio), [`captureMicrophone`](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturemicrophone), [macOS 15 release notes](https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes)
- Rust: [`cidre`](https://crates.io/crates/cidre), [`objc2-core-audio`](https://crates.io/crates/objc2-core-audio), [`screencapturekit`](https://crates.io/crates/screencapturekit)
- Prior art: [Cap](https://github.com/CapSoftware/Cap) (Tauri + cidre), [Meetily](https://github.com/Zackriya-Solutions/meeting-minutes) (Tauri + cidre + cpal), [BlackHole](https://github.com/ExistentialAudio/BlackHole)
- Granola behaviour: [transcription](https://docs.granola.ai/help-center/taking-notes/transcription.md), [Zoom speaker attribution](https://docs.granola.ai/help-center/taking-notes/speaker-attribution-zoom.md)
- Pricing: [Deepgram](https://deepgram.com/pricing), [AssemblyAI](https://www.assemblyai.com/pricing), [OpenAI](https://developers.openai.com/api/docs/pricing) — all list price, **to be re-verified in N0-B**
