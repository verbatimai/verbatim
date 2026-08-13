# Settings Execution — Master Index

Autonomous multi-agent execution of `docs/product/settings-plan.md`. Each phase = one Wave of the plan. Per-phase flow: **planner** writes the implementation plan → **reviewer** cross-checks it against the live code → **dev** implements + runs the runnable tests → progress recorded here and in the phase progress file.

## Verification model
- **Core TypeScript (`packages/core`)** — test-runnable in the cloud (`npm test`, `npm run typecheck`). These get real, executed test results. ✅ baseline 77/77 green.
- **Rust (`apps/widget/src-tauri`) + Tauri UI runtime** — cannot be compiled or click-tested in the cloud. Code is authored + a precise on-Mac checklist is left **unchecked** for Mayank to run (`cargo build` / `npm run widget`).
- Files are authored in a cloud copy of the repo and written back to the Mac repo via the bridge. **No git is run from the cloud** — commits happen on the Mac.

## Phase map & status
| Phase | Wave | Scope | Plan | Reviewed | Implemented | Tests |
|---|---|---|---|---|---|---|
| 1 | Wave 1 | mute-others fix, launch-at-login, reset, debug, theme, **remove Keychain (§1.6)** | ✅ | ✅ | ✅ | ✅ cloud / ⬜ Mac |
| 2 | Wave 2 | paste-last hotkey, self-correction toggle, formatting toggle | ✅ | ✅ | ✅ | ✅ cloud (83/83) / ⬜ Mac |
| 3 | Wave 3 | mic picker, auto-detect language, telemetry (opt-in), vocabulary, snippets | ✅ | ✅ | ✅ | ✅ cloud (108/108) / ⬜ Mac · **fix: `phase-3-fix-language.md`** |
| 4 | Cleanup | remove "preload model", reconcile "show while inactive", relabels, "Planned" grouping | ✅ | ✅ | ✅ | ✅ cloud / ⬜ Mac |
| 5 | Wave 4 | Fn push-to-talk (native, **authored only** — Mayank tests on Mac) | ✅ | ✅ | ✅ authored | ✅ tsc / ⬜ Mac build |
| 6 | Wave 5 | Draft mode (design note delivered; implementation parked on decisions) | ✅ | ✅ | ✅ design-only | ✅ baseline 106/106 |
| 7 | Audit fixes | wire model overrides (dead), dock-icon toggle (dead), Deepgram vocab on batch | ✅ (direct) | — | ✅ | ✅ cloud (137/137) / ⬜ Mac (dock_icon Rust) |
| 8 | Consolidation | capability-driven pane merged into Preferences (provider→model→language/auto-detect interlock); `capabilities.ts` map; model fields now dropdowns; "Providers & Keys"→"API Keys" | ✅ (direct, no docs) | — | ✅ | ✅ tsc / ⬜ Mac |

**OpenAI STT GA migration (13 Aug, live fix):** OpenAI retired the Realtime **beta** API → adapter migrated to GA `/v1/realtime` (dropped `OpenAI-Beta` header, `session.update` with `audio.input` nesting, model defaults → `gpt-4o-mini-transcribe`). Core tests updated; 137/137. All TS — no Rust. Verify on Mac with a real OpenAI key.

**Verification audit (13 Aug):** `audit/audit-summary.md` — PyAI clean; found 3 wired-but-dead settings (model overrides HIGH, dock icon, Deepgram batch vocab). Phase 7 fixes them. Language/auto-detect fix already landed (`phase-3-fix-language.md`).

Legend: ⬜ not started · ⏳ in progress · ✅ done · ⏸ parked (needs Mayank's input)

## Parked / needs-input log
_(items held per the "if it needs my decision, hold that part and continue" rule)_
- **product-plan.md §14 reconciliation (Phase 1 / 1.6):** the dev prepared the threat-model edit (Keychain → local storage) but it is **held and NOT synced to the Mac**, per Mayank's earlier "we can update the product plan later on." Ready to apply when you say.
- **Rust build (Phase 1):** all Rust authored but not compiled in cloud. Needs `cargo check`/`cargo build` on the Mac — likely first friction is the `tauri-plugin-autostart` v2 API. See `phase-1-progress.md` on-Mac checklist.
- **PyAI test key rotation:** still outstanding before public release (pre-existing).
- **Telemetry network transport (Phase 3 / 3.3):** intentionally PARKED. The toggle + no-op emitter + allow-list sanitizer ship, but there is NO network send (default `NoopSink`, TODO seam). Needs your decision on the sink/endpoint before wiring transport (product-plan §8/§14).
- **"Show widget while inactive" removed (Phase 4):** removed on the reversible assumption the always-visible draggable orb supersedes it. Override if you'd rather repurpose it as "hide orb when idle."

## Per-phase files
- `phase-N-plan.md` — implementation plan + test checklist (planner, reviewed)
- `phase-N-review.md` — reviewer's cross-check verdict
- `phase-N-progress.md` — what was implemented, test results, on-Mac checklist state
