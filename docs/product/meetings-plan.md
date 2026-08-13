# Meetings ("Granola mode") — Goal & Milestone Plan

**Owner:** Mayank Banga · Saaslabs
**Date:** 13 Aug 2026
**Status:** proposal — nothing here is committed until the **N0 spike** clears its gate.
**Rev 13 Aug 2026 (e):** demo prototype built — see §13 Build log. PyAI probe settled the open capability questions (no streaming diarization, still English-only, but `channel:true` on the jobs API gives *exact* separation); F10 answered.
**Rev 13 Aug 2026 (d):** AssemblyAI dropped from the N0-B matrix in favour of **PyAI** (no fifth adapter; a 90-min session is the strongest PyAI stress test yet). PyAI enters as a *candidate* default with Deepgram retained as the control — see §2 N0-B for the four documented issues that could disqualify it.
**Rev 13 Aug 2026 (c):** four decisions settled (§11) — macOS 14.4+ Core Audio taps, N0-B matrix incl. AssemblyAI + local Whisper, mixed N0-C corpus, N0-A Mac-driven; added §12.1 (what execution needs from Mayank).
**Rev 13 Aug 2026 (b):** added §9.1 (dependency + parallelism analysis); §8 Rust row updated for the `main.rs` module split, which landed the same day and removes the biggest merge-conflict argument against parallel work.
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
| **PyAI Hear** | existing key | none | **candidate default — see below** |
| Deepgram Nova-3 | ~$0.46/hr | ~$0.12/hr | ~$0.87 |
| OpenAI `gpt-4o-transcribe` | $0.36/hr | file-only | $0.54 |
| OpenAI `gpt-4o-mini-transcribe` | $0.18/hr | file-only | $0.27 |
| **Local whisper.cpp** | $0 | none built-in | **$0** — cost moves to CPU/battery |
| ~~AssemblyAI~~ | — | — | **dropped 13 Aug 2026** — no fifth adapter |

**Decided 13 Aug 2026 (rev d): PyAI instead of AssemblyAI.** No fifth adapter to build or maintain, and a 90-minute continuous session is by far the most demanding PyAI stress test this project has run — which is an explicit goal of the build, not a side effect. **N0-B should produce a findings report for the PyAI team** in the same format as `docs/research/pyai-api-findings.md` (F1–F10); expect long-session findings to extend that list.

**But PyAI enters as a *candidate*, not a foregone default — and Deepgram stays in the matrix as the control.** Keeping it costs nothing (the adapter is built and tested), and four things already documented in this repo could each disqualify PyAI for meetings specifically:

| Known issue | Why meetings are harder than dictation |
|---|---|
| **Hear is English-only** (`400 unsupported_language` for any non-`en`) — `multilingual.md` | For dictation the user picks their own language. A *meeting* has other people in it; one non-English speaker is a hard failure, not a setting. |
| **Hear has no diarization** — single model, `language`/`model`/`keywords` params all ignored (`pyai.stt.ts`) | Me/Them still works (that comes from two streams, not the model). Splitting multiple remote speakers does not. |
| **F10 — no finalize/flush control message**; you close the socket to end | Tolerable for a 30-second utterance. At 90 minutes with rolling segment boundaries, "close the socket" is the *only* commit primitive we have. |
| **F9 — `/v1/messages` is 4.4–13 s for *short* requests**; **F1 — tool-use 503s** | This is the correction/enhancement half, not STT. A 90-minute transcript is ~15–20k tokens. If short prompts take 13 s, N0-C's enhancement pass on PyAI needs measuring before it is assumed viable. |

**So N0-B must be able to fail PyAI.** Exit criteria: PyAI becomes the meetings default only if it survives 90 minutes without loss, and the English-only constraint is either lifted or explicitly accepted as a documented limitation of PyAI-mode meetings (with Deepgram/OpenAI as the multilingual route, exactly as dictation already does). Otherwise PyAI stays the *dictation* default and meetings default to Deepgram. The vendor-agnostic contract means this is a config decision, not a rewrite — but only if we actually test the alternative.

**Two further consequences of adding local Whisper:**

- **Local Whisper turns N0-B from a pricing probe into a pricing + feasibility probe, and it needs the Mac.** whisper.cpp throughput, thermals and battery drain over a 90-minute session cannot be measured from a cloud container, so N0-B is no longer fully parallel: the cloud-vendor half is, the Whisper half is Mac-bound. Record the exact machine (chip, RAM) with the numbers — they don't transfer between an M1 Air and an M4 Pro.
- **whisper.cpp has no built-in diarization.** Per-stream Me/Them labelling still works (that comes from having two audio streams, not from the model), but splitting multiple remote speakers would need a separate local model — `sherpa-onnx` is what `minute` uses. Treat that as out of scope for the probe; just note whether the transcript is good enough without it.
- **Upside worth measuring properly:** if local Whisper is good enough, meetings can run **fully offline** — no vendor, no key, no per-meeting cost, nothing leaving the machine even to a BYOK endpoint. That is a materially stronger local-first story than "BYOK to someone else's cloud" and would feed back into §11.5 positioning. Judge it on transcript quality against the cloud baseline, not just on "it ran."

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
| Capability layer | New capabilities: `long_form`, `diarization`, `word_timestamps`. `capabilityErrors()` must refuse invalid meeting combos the way it already refuses invalid dictation ones. PyAI Hear is unproven at meeting length and has no diarization — the meeting default is PyAI *if* it clears N0-B, otherwise Deepgram. |
| Transcript model | The `TranscriptAccumulator` is built for a ~30-second utterance and **should not be stretched** to 90 minutes. Meetings get an append-only, timestamped, speaker-tagged segment store. Different problem, different structure. |
| Storage | SQLite (`rusqlite` or `tauri-plugin-sql`) + audio segments as Opus/m4a on disk under the app support dir, `0600`. |
| Rust | New `capture.rs` (cidre) + `session_store.rs`, landing alongside the modules split out of `main.rs` on 13 Aug 2026 (`config` / `hotkey` / `shortcuts` / `window` / `system` / `lists` / `keys` / `backend` / `tray` / `text` / `state`). Capture is a peer module, **not** an addition to `main.rs` — which is now a 136-line orchestrator whose only meetings-related change is a `mod capture;` line and a block of `generate_handler!` entries. This is still the largest single chunk of new Rust in the project's history and it is all Mac-verified work. |
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

### 9.1 Dependencies — what can actually run in parallel

Checked against the code on 13 Aug 2026, not against the milestone names.

**What is left in M4 is verification, not code.** 4.8's release packaging landed in `885b68d`; 4.9's code is done; 4.10 is essentially done. The remaining checkboxes are on-Mac click-throughs and doc updates. So **M4 is not a code dependency for anything in the N-track** — it is a *Mac-time* dependency, which is a scheduling problem, not an architectural one.

**Three real dependencies, none of them the obvious one:**

1. **`AppConfig` is the hot spot.** `settings-plan.md` §1 adds 11 fields; meetings adds ~6 (meeting vendor, retention policy, auto-start, tap allowlist, storage path). Both edit the same struct, the same `Default` impl, and the same mirror in `settings.ts`. Because `set_config` deserializes the *whole* merged object, a field added without `#[serde(default)]` coverage breaks existing stores. → **Land the schema fields for both tracks in one commit up front**, then diverge. This removes the dependency rather than sequencing around it.
2. **Key storage (§1.6) should land before N1, not during.** Meetings pulls vendor keys through the same sidecar path; rewriting the secret backend while capture code is being written against the old model means rework. Not a blocker for N0 — the spike touches no key storage.
3. **The Mac is the bottleneck, not the repo.** M4's exit demo, settings Wave 1 verification and N0-A all need `cargo build` on the Mac. Cloud sessions can author TS and docs in parallel; Rust cannot. "Parallel" here means parallel *authoring*, serialized *verification*.

**A conflict inside the existing plans, unrelated to meetings:** M4's exit criteria require *"restart the app and confirm keys persist in the keychain"* — and `settings-plan.md` §1.6 removes the Keychain. **Run the M4 exit demo and sign it off before Wave 1**, or you are demoing a mechanism you are about to delete.

**What can start immediately:**

| Work | Parallel? | Needs |
|---|---|---|
| **N0-C** enhancement quality | ✅ fully | A CLI over `packages/core` + 3–5 recorded meetings. Zero Rust, zero Mac, zero settings overlap. |
| **N0-B** long-session cost/architecture | ⚠️ split | *Cloud half* (5 vendors, cost/reliability) is fully parallel: keys + spend, TS probe, reads `packages/core` only. *Local-Whisper half* is **Mac-bound** — throughput, thermals and battery can't be measured from a container. |
| **N0-A** system-audio capture | ⚠️ competes | Mac + `cargo build`. Standalone probe crate — no product code, so no merge conflict, but it queues behind the M4 exit demo for Mac time. |
| **N1** recorder | ❌ no | Wants M4 signed off, §1.6 settled, and the `AppConfig` schema landed. |

**Enabler — done (13 Aug 2026).** `main.rs` was 1275 lines and owned config, keys, hotkeys, windows, mute, AX and the sidecar. Both tracks would have added commands and `invoke_handler` entries to it indefinitely. It is now split into 11 focused modules with `main.rs` at 136 lines (pure move refactor; all 31 Tauri commands preserved with unchanged JS-facing names). Meetings work now lands in its own files, so the `main.rs` merge-conflict argument against parallel work no longer applies — **`AppConfig` (dependency 1 above) is the only shared-file collision left.**

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
| PyAI can't carry meetings (English-only / no diarization / F9 latency) | Medium | Deepgram stays in the N0-B matrix as the control; the vendor-agnostic contract makes the default a config decision, not a rewrite |
| Two tracks editing `AppConfig` concurrently | Medium | Land both tracks' schema fields in one commit up front (§9.1); `#[serde(default)]` on every new field |
| Granola ships the local-first story first | Low–Medium | They're cloud-native with a retention-tier business model; it is not a fast pivot for them |

---

## 11. Decisions

### Settled (13 Aug 2026)

- ✅ **macOS floor: 14.4+, Core Audio process taps.** Meeting capture requires Sonoma 14.4 or later; dictation's floor is unchanged. Bought deliberately: an audio-only permission prompt instead of "this app can see your screen," near-zero CPU, per-PID tapping, and no exposure to Apple's screen-capture consent tightening. ScreenCaptureKit stays documented as the fallback if the floor proves untenable.
- ✅ **N0-B matrix: the four current vendors + local whisper.cpp. AssemblyAI dropped (rev d)** — PyAI covers that slot, so no fifth adapter. **PyAI enters as a candidate default, not a decided one**; Deepgram stays in the matrix as the control, and N0-B must be able to fail PyAI on the four documented issues in §2 N0-B. Whisper is probe-only.
- ✅ **N0-C corpus: public audio now, real meetings alongside.** The harness is built and calibrated on public recordings so it can start immediately; the **gate decision is made on the real corpus only** — public monologues are a weak proxy for a 1:1 or a standup and must not be allowed to stand in for one.
- ✅ **Rust division of labour: Mayank drives N0-A at the Mac; Claude supports** with cidre/Core Audio API research, diff review, and all non-Rust work. Rationale in §12.1.

### Still open

1. **Track naming** — `N0–N4` as a parallel track (proposed), or renumber into `M7–M11` after the OSS release? Parallel keeps M5/M6 intact. *Blocks: the roadmap.md edit. Does not block N0.*
2. **M5 vs N1 priority** — after M4, does the team polish dictation to daily-driver quality (M5), or start the recorder (N1)? My read: **finish M5**. A meeting notepad built on a dictation engine nobody dogfoods daily is building on sand — and M5's dogfooding surfaces the bugs N2 would otherwise inherit. *Blocks: N1 start. Does not block N0.*
3. **Is this a Verbatim feature or a second product?** "Second mode, same app" is decided, but it still changes what Verbatim *is*, and therefore what `README.md`, `product-plan.md` §1 and the v1.0 public positioning say. **Revisit after N0-B** — a viable fully-offline mode would strengthen the positioning enough to be worth rewriting for.

---

## 12. Immediate next steps

1. ~~Answer the spike-shaping decisions~~ — done, see §11.
2. Schedule **N0** — one week on the Mac. A, B and C are independent and can run in any order; **B is the most likely to force a redesign, so run it first if time is tight.**
3. **Start N0-C and N0-B now** — per §9.1 they need no Mac and no product code, so they cost nothing to run alongside M4's remaining verification. Keep the Mac on the M4 exit demo, then hand it to N0-A.
4. Add an `n0-spike.md` task doc (same format as `m3-tasks.md` / `m4-tasks.md`) with per-probe checklists once the shape is agreed.
5. Reference this doc from `roadmap.md` and add the N-track to the sequencing diagram — **after** §11.1 is decided, so the numbering doesn't have to change twice.

### 12.1 What execution needs from Mayank

Everything below is something no cloud session can supply. Listed so it can be scheduled, not discovered mid-spike.

| Need | For | Notes |
|---|---|---|
| **A week at the Mac** | N0-A, half of N0-B | The binding constraint on the whole track. N0-A is Mayank-driven by decision. |
| **Spend authorisation (~$20–40)** | N0-B | Five configurations × repeated 90-minute runs, plus re-runs after failures. Lower now that AssemblyAI is out and PyAI/Whisper add no marginal cost. |
| **3–5 real meeting recordings + your shorthand notes** | N0-C gate | The notes matter as much as the audio — the probe tests *notes + transcript*, so recordings without the shorthand can't exercise it. |
| **Participant consent for those recordings** | N0-C | Needed before recording, not after. |
| **A second human judge** | N0-C | The rubric is "would you send this?" — one person's opinion isn't a gate. |
| **Machine spec (chip + RAM)** | N0-B Whisper half | Local-transcription numbers don't transfer between an M1 Air and an M4 Pro; record it with the results. |
| **macOS version spread across the team / target users** | Validates the 14.4 floor | The floor is decided, but if a meaningful share sits on 13.x that is worth knowing before N1, not after. |
| **Legal / consent review sign-off** | Gates N1 shipping | Recording-consent copy, jurisdiction guidance, indicator design. Not something a session can sign off. |
| **§11 open decisions 1–3** | Roadmap edit, N1 start | None block N0. |

**What Claude can carry without any of the above:** the N0-C harness (CLI, prompts, template format, scoring rubric) built and calibrated on public audio; the N0-B cloud-vendor probe script; the `n0-spike.md` task doc; cidre/Core Audio research briefs to support N0-A; and later, session storage, meetings UI, `packages/core` work, prompts and templates.

**The standing constraint:** no Rust written in a cloud session is verified until it is built on the Mac. That was acceptable for the `main.rs` split (a mechanical move, syntax-checkable with rustfmt). It is *not* a good fit for new objc/FFI capture code against an unfamiliar crate — hence the §11 decision that N0-A is Mac-driven with Claude supporting.

---

## 13. Build log — demo prototype (13 Aug 2026)

A hackathon demo was scheduled for 14 Aug, so a working end-to-end path was built ahead of the N0 gate. **This is prototype scaffolding, not N1** — N0's questions remain open and the plan above stands. What follows is what exists, what is verified, and what is not.

### 13.1 The PyAI probe changed the design (`experiments/scripts/probe_hear_caps.py`)

Three findings, all against the live API:

| Question | Answer |
|---|---|
| Does Hear support more languages now? | **No.** `hi/es/fr/de/ja/auto` → `400 unsupported_language`. The spec states English-only. (Omni carries more languages, but Omni is speech-to-speech, not transcription — this is the likely source of the confusion. `multilingual.md` was already correct.) |
| Does Hear streaming diarize? | **No.** `diarize` / `diarization` / `speaker_labels` on the WS are all silently ignored; no event carries a speaker field. |
| Is diarization available at all? | **Yes — on a different surface.** `POST /v1/transcription/jobs` offers `diarize:true` (mono, Sortformer) and **`channel:true` — "exact, model-free speaker separation per channel."** |

**This is better than what was planned.** A meeting is already two physically separate captures, so muxing mic→L and system→R makes Me/Them attribution *exact* rather than a model's guess — and async Transcribe is $0.0005/min vs $0.001/min streaming.

**Finding F10 is answered** and should be closed in `docs/research/pyai-api-findings.md`: the finalize control message is `{"type":"commit"}` (or the literal text frame `EOF`), with configurable `endpointing_ms`. Also `protocol=pyai-hear-v1` selects the published frame names; omitting it keeps the legacy `fusion-v0` names, which is what the current adapter reads.

### 13.2 What was built

| Area | Files | State |
|---|---|---|
| Enabler refactor | `src-tauri/src/` → 12 modules, `main.rs` 1275→136 lines | ✅ `cargo build` passes |
| Transcript model | `packages/core/src/meetings/{types,transcript}.ts` | ✅ tested |
| Templates + prompt | `meetings/prompt.ts` — 6 templates | ✅ tested |
| Note generation | `meetings/openai.summarize.ts`, `registry.ts` | ✅ tested vs mocks |
| Stereo mux | `meetings/stereo.ts` | ✅ tested |
| PyAI jobs adapter | `meetings/pyai.jobs.ts` | ✅ tested vs mocks |
| Meetings backend | `apps/backend/src/meeting.ts` — separate WS on **:8788** | ⚠️ never run |
| Capture + UI | `apps/widget/{meetings.html,src/meetings.ts,src/meetings.css}` | ⚠️ never run |

**37 tests pass** (`packages/core/src/meetings/*.test.ts`), typecheck clean.

Two deliberate choices worth recording:

- **The meetings backend is a separate server on :8788**, sharing nothing with `server.ts` but `@verbatim/core`. If meetings break, dictation still works. That isolation is worth keeping past the demo.
- **Capture is webview-only — zero new Rust.** BlackHole makes system audio an ordinary *input* device, so both streams are `getUserMedia`. Core Audio taps (N0-A) remain the shipping answer; this is a demo shortcut, deliberately taken, and the loopback-device dependency is exactly the UX cost §2 N0-A rejects for the product.

### 13.3 Hallucination guard — implemented, not just prompted

Every action item must carry a verbatim transcript quote, and that is enforced **in code**: `locateQuote()` searches the actual transcript and any item that cannot be anchored is dropped with a warning. A test feeds a fabricated "we agreed to fifty percent off" and asserts it never reaches the note. This is the §4 provenance requirement, landing early.

### 13.4 Not verified — the honest list

Nothing below the core package has ever run:

- No end-to-end run. Not once. The pieces are individually tested against mocks; the integration is not.
- PyAI jobs `channel:true` has **not** been exercised on real wideband stereo audio. The jobs API defaults to `pyai-hear-telephony` (tuned for 8 kHz); `PYAI_JOBS_MODEL` overrides it. **A/B this against `pyai-hear` before relying on it.**
- Live-transcript fallback (agreed acceptable) triggers on any jobs failure: stream-level Me/Them instead of exact.
- `ScriptProcessorNode` is deprecated; fine in Chromium/WKWebView today, should become an AudioWorklet.
- Clock drift between two independent `AudioContext`s over a long session is unmeasured — set BlackHole and the mic to the same sample rate.
- **Mic bleed is the demo's real failure mode:** without headphones the mic re-records the far end and the channel separation visibly breaks.

### 13.5 How to run it

```bash
npm run meetings        # backend on :8788 (dictation backend is separate, :8787)
npm run widget          # then: sidebar → Meetings
# or open http://localhost:5175/meetings.html in Chrome
```

Needs `PYAI_API_KEY` + `OPENAI_API_KEY`, and a Multi-Output Device (speakers/headphones + BlackHole) as system output. **Press "Test levels" first** — if both meters do not move, nothing else will work. Output lands in `~/Documents/Verbatim/Meetings/<timestamp>-<slug>/` as `note.md` + `session.json`, written even when the note pass fails.

### 13.6 What this does NOT change

The N0 gate stands. Capture still needs Core Audio taps (N0-A) to ship without a driver install; long-session economics (N0-B) are untouched — the demo targets ~10-minute sessions, where whole-session batch is fine and the chunked-batch redesign is not yet forced; and enhancement quality (N0-C) still needs real meetings and a second judge. **A working demo is not a cleared gate.**

---

## Appendix — research sources (13 Aug 2026)

- Core Audio taps: [Apple — Capturing system audio with Core Audio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps), [`CATapDescription`](https://developer.apple.com/documentation/coreaudio/catapdescription), [`NSAudioCaptureUsageDescription`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsaudiocaptureusagedescription), [insidegui/AudioCap](https://github.com/insidegui/AudioCap)
- ScreenCaptureKit: [`capturesAudio`](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturesaudio), [`captureMicrophone`](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturemicrophone), [macOS 15 release notes](https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes)
- Rust: [`cidre`](https://crates.io/crates/cidre), [`objc2-core-audio`](https://crates.io/crates/objc2-core-audio), [`screencapturekit`](https://crates.io/crates/screencapturekit)
- Prior art: [Cap](https://github.com/CapSoftware/Cap) (Tauri + cidre), [Meetily](https://github.com/Zackriya-Solutions/meeting-minutes) (Tauri + cidre + cpal), [BlackHole](https://github.com/ExistentialAudio/BlackHole)
- Granola behaviour: [transcription](https://docs.granola.ai/help-center/taking-notes/transcription.md), [Zoom speaker attribution](https://docs.granola.ai/help-center/taking-notes/speaker-attribution-zoom.md)
- Pricing: [Deepgram](https://deepgram.com/pricing), [OpenAI](https://developers.openai.com/api/docs/pricing) — list price, **to be re-verified in N0-B**. ([AssemblyAI](https://www.assemblyai.com/pricing) kept for reference only; dropped from the matrix in rev d.)
- PyAI constraints cited above are from this repo, not the web: `docs/research/pyai-api-findings.md` (F1, F6, F9, F10), `docs/architecture/multilingual.md` (Hear English-only), `packages/core/src/providers/pyai.stt.ts` (single-model; language/model/keywords ignored).
