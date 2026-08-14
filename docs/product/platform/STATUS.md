# Platform (P-series) — Execution Status

Live tracker for the platform track (voice input beyond dictation). Umbrella vision: `../platform-evolution.md`. Each phase runs the same loop: **plan → independent reviewer agent cross-checks → dev agent implements + tests → progress recorded**.

_Last updated: 13 Aug 2026 (autonomous execution session)._

> **Verification reality (applies to every phase):** this ran in a cloud Linux env. **TypeScript (core/backend) is implemented AND tested green here.** **Rust / native macOS code cannot be compiled here** — it is authored + reviewed and marked **Mac-build-pending**; a per-phase on-Mac checklist captures what to verify when back at the Mac. Nothing Rust is claimed as "tested."

## Phases

| Phase | Scope | Plan | Reviewed | Implemented | Tested |
|---|---|---|---|---|---|
| **P1** | Field-scoped command mode (voice text-editing on the focused field) | `p1-plan.md` v2 | ✅ (`p1-review.md`, REVISE→approved) | ✅ (`p1-progress.md`) | core: ✅ 47 tests · rust: **compiles ✓** · settings UI ✅ · **runtime ✅ (Mac, end-to-end 14 Aug)** |
| **P2** | System commands via macOS Shortcuts / AppleScript delegation | `p2-plan.md` v2 | ✅ (`p2-review.md`, APPROVE-W-CHANGES) | ✅ (`p2-progress.md`) | core: ✅ 47 tests · rust: **compiles ✓** · settings UI ✅ · runtime pending |
| **P3** | Wake-word activation source (openWakeWord, on-device, opt-in) | `p3-plan.md` v2 | ✅ (`p3-review.md`, APPROVE-W-CHANGES) | ✅ scaffold (`p3-progress.md`) | wiring/config: **compiles ✓** · settings UI ✅ · ONNX core: **Mac spike** |

### Build & UI status (14 Aug 2026, on-Mac)
- **`cargo build` PASSES** — all P1/P2/P3 Rust compiles against the real deps + merged M5/meetings code (only 2 pre-existing M5 warnings remain, not P-series). The two P-series warnings were fixed.
- **Settings UI added** — command-mode hotkey capture, "Allow system commands" toggle, and "Wake word (beta)" (enable + handler + threshold) in the Shortcuts pane; plus a command-mode overlay indicator. So P1/P2 are now reachable from the UI (set a command hotkey → dictate a command). P3 needs the ONNX model assets + the Mac spike before its toggle does anything.
- **P1 command mode VERIFIED on Mac (14 Aug)** — hotkey → speak → classify → execute, end-to-end (initial mis-fire was a stale running instance, not a code bug; fixed by a clean relaunch).
- **Remaining to actually run:** **P2** — enable "Allow system commands" and try "open Slack" / "volume up". **P3** — model-license gate + the Mac spike (models + cpal/ort pipeline) before wake word detects anything.

Legend: ✅ done · ⏳ in progress · ❌ blocked (needs Mayank — see phase doc) · n/a-cloud = can only be verified on the Mac.

## Per-phase artifacts
Each phase folder has three docs:
- `pN-plan.md` — the implementation plan + testing checklist.
- `pN-review.md` — the independent reviewer agent's cross-check verdict (before implementation).
- `pN-progress.md` — what was implemented, cloud test results, and the on-Mac checklist status.

## Held items (need Mayank — routed around, not blocking)
- **Repo sync COMPLETE (14 Aug 2026).** All 38 P-series files committed to `~/Claude/shuuuu/verbatim`. The edited files were **3-way merged onto the current Mac versions**, preserving the parallel M5/meetings work (revert-raw hotkey in `shortcuts.rs`/`hotkey.rs`, `revert_raw_hotkey` + other config fields, `LAST_RAW` in `state.rs`). Command suite: 47 tests green. Rust is authored but **not yet compiled** — run `cargo build` / `npm run widget` on the Mac (per each `pN-progress.md` checklist).
- **P3 model-license gate (a real decision, before shipping wake word).** Verify `melspectrogram.onnx` + `embedding_model.onnx` (Google speech-embedding derivatives bundled by openWakeWord) may be redistributed inside an MIT app. If not → download-on-first-enable or a different embedding. Parked in `p3-progress.md`; does not block the Mac spike, but gates release.

## Summary (all three phases planned + reviewed + implemented-as-feasible)
- **P1** command mode: fully implemented; **core cloud-tested (39 tests)**; Rust authored, Mac-pending.
- **P2** system commands: fully implemented; **core cloud-tested (47 tests)**; Rust delegation authored, Mac-pending.
- **P3** wake word: config + activation wiring + `wake.rs` scaffold authored (no regression, 47 tests); **ONNX/audio core is a Mac spike** by nature.
- Every phase went **plan → independent reviewer (found real blockers each time) → revised plan → dev agent implemented → verified**. All Rust is authored-not-compiled (cloud can't build it); all TypeScript is tested green.

## Notes
- P1's classification core (`packages/core/src/command/`) was built + verified in a prior step (24 tests green + strict tsc) and is already committed to the repo.
- Numbering (M / N / P tracks) intentionally not reconciled into `roadmap.md` here — per Mayank, numbering is not a concern; this tracker is the source of truth for the P-series.
