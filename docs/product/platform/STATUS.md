# Platform (P-series) — Execution Status

Live tracker for the platform track (voice input beyond dictation). Umbrella vision: `../platform-evolution.md`. Each phase runs the same loop: **plan → independent reviewer agent cross-checks → dev agent implements + tests → progress recorded**.

_Last updated: 14 Aug 2026 (P3 detection pipeline authored)._

> **Verification reality (applies to every phase):** this ran in a cloud Linux env. **TypeScript (core/backend) is implemented AND tested green here.** **Rust / native macOS code cannot be compiled here** — it is authored + reviewed and marked **Mac-build-pending**; a per-phase on-Mac checklist captures what to verify when back at the Mac. Nothing Rust is claimed as "tested."

## Phases

| Phase | Scope | Plan | Reviewed | Implemented | Tested |
|---|---|---|---|---|---|
| **P1** | Field-scoped command mode (voice text-editing on the focused field) | `p1-plan.md` v2 | ✅ (`p1-review.md`, REVISE→approved) | ✅ (`p1-progress.md`) | core: ✅ 47 tests · rust: **compiles ✓** · settings UI ✅ · **runtime ✅ (Mac, end-to-end 14 Aug)** |
| **P2** | System commands via macOS Shortcuts / AppleScript delegation | `p2-plan.md` v2 | ✅ (`p2-review.md`, APPROVE-W-CHANGES) | ✅ (`p2-progress.md`) | core: ✅ 47 tests · rust: **compiles ✓** · settings UI ✅ · runtime pending |
| **P3** | Wake-word activation source (openWakeWord, on-device, opt-in) | `p3-plan.md` v2 | ✅ (`p3-review.md`, APPROVE-W-CHANGES) | ✅ full pipeline (`p3-progress.md`) | core: ✅ · settings UI ✅ ("Hey Jarvis") · **runtime ✅ (Mac, 14 Aug — "Hey Jarvis" scores ~0.99 and fires end-to-end)** · whisper AGC tuning in progress |

### Build & UI status (14 Aug 2026, on-Mac)
- **P3 wake word VERIFIED on Mac (14 Aug 2026)** — after pinning `ort = 2.0.0-rc.13` and rewriting the melspec streaming to match openWakeWord exactly (rolling raw buffer + CHUNK+480 context per melspec, one embedding per 80 ms chunk over the last 76 mel frames), a spoken **"Hey Jarvis"** scores ~0.99 and fires the activation seam end-to-end. Added AGC (boosts quiet/whispered speech toward training magnitude without touching normal speech or amplifying silence) so the wake word can trigger on **whispers**; threshold stays live-tunable in Settings. **Whisper CONFIRMED (14 Aug):** an AGC-boosted whispered "Hey Jarvis" scores ~0.87 and fires at threshold 0.6. **Wake stop fix:** the UI Stop button now invokes `clear_recording_state`, clearing the Rust RECORDING/COMMAND_RECORDING latches so a wake-started session ends cleanly and the wake word re-arms (previously the self-trigger gate stayed engaged after a UI stop). Detection-tuning (whisper false-accept/reject) is the remaining polish.
- **P3 detection pipeline authored (14 Aug 2026)** — `wake.rs` now carries the full cpal capture + 3-model ONNX inference loop (melspectrogram → embedding → wake classifier, streaming with patience + debounce + the self-trigger gate); `ort` (download-binaries) and `cpal` added to `Cargo.toml`; Settings names **"Hey Jarvis"** as the trigger phrase. Awaiting `cargo build` on the Mac (ort-2.x API tweaks expected — flagged in-file).
- **`cargo build` PASSES** — all P1/P2/P3 Rust compiles against the real deps + merged M5/meetings code (only 2 pre-existing M5 warnings remain, not P-series). The two P-series warnings were fixed.
- **Settings UI added** — command-mode hotkey capture, "Allow system commands" toggle, and "Wake word (beta)" (enable + handler + threshold) in the Shortcuts pane; plus a command-mode overlay indicator. So P1/P2 are now reachable from the UI (set a command hotkey → dictate a command). P3 needs the ONNX model assets + the Mac spike before its toggle does anything.
- **P1 command mode VERIFIED on Mac (14 Aug)** — hotkey → speak → classify → execute, end-to-end (initial mis-fire was a stale running instance, not a code bug; fixed by a clean relaunch).
- **Remaining to actually run:** **P2** — enable "Allow system commands" and try "open Slack" / "volume up". **P3** — `cargo build` (deps `ort`/`cpal`/`ureq` now in `Cargo.toml`; the full audio→ONNX detection pipeline is authored in `wake.rs`), then enable "Wake word" and say **"Hey Jarvis"**; expect ort-2.x API / detection-tuning iteration. **Model-license gate RESOLVED** → models download on first enable (no bundling).

Legend: ✅ done · ⏳ in progress · ❌ blocked (needs Mayank — see phase doc) · n/a-cloud = can only be verified on the Mac.

## Per-phase artifacts
Each phase folder has three docs:
- `pN-plan.md` — the implementation plan + testing checklist.
- `pN-review.md` — the independent reviewer agent's cross-check verdict (before implementation).
- `pN-progress.md` — what was implemented, cloud test results, and the on-Mac checklist status.

## Held items (need Mayank — routed around, not blocking)
- **Repo sync COMPLETE (14 Aug 2026).** All 38 P-series files committed to `~/Claude/shuuuu/verbatim`. The edited files were **3-way merged onto the current Mac versions**, preserving the parallel M5/meetings work (revert-raw hotkey in `shortcuts.rs`/`hotkey.rs`, `revert_raw_hotkey` + other config fields, `LAST_RAW` in `state.rs`). Command suite: 47 tests green. Rust is authored but **not yet compiled** — run `cargo build` / `npm run widget` on the Mac (per each `pN-progress.md` checklist).
- ~~P3 model-license gate~~ **RESOLVED (14 Aug 2026) → download-on-first-use.** The app now downloads the three openWakeWord `.onnx` models from the v0.5.1 release into the app-data dir on first enable (`wake.rs ensure_models`, via `ureq`) instead of bundling them, so Verbatim never redistributes the Google-derived models. No decision needed; the only P3 work left is the on-Mac ONNX/audio spike + adding `ureq` to Cargo.toml.

## Summary (all three phases planned + reviewed + implemented-as-feasible)
- **P1** command mode: fully implemented; **core cloud-tested (39 tests)**; Rust authored, Mac-pending.
- **P2** system commands: fully implemented; **core cloud-tested (47 tests)**; Rust delegation authored, Mac-pending.
- **P3** wake word: config + activation wiring + `wake.rs` scaffold authored (no regression, 47 tests); **ONNX/audio core is a Mac spike** by nature.
- Every phase went **plan → independent reviewer (found real blockers each time) → revised plan → dev agent implemented → verified**. All Rust is authored-not-compiled (cloud can't build it); all TypeScript is tested green.

## Notes
- P1's classification core (`packages/core/src/command/`) was built + verified in a prior step (24 tests green + strict tsc) and is already committed to the repo.
- Numbering (M / N / P tracks) intentionally not reconciled into `roadmap.md` here — per Mayank, numbering is not a concern; this tracker is the source of truth for the P-series.
