# P1 — Progress

**Phase:** P1 — Field-scoped command mode · **Date:** 13 Aug 2026
**Overall:** Implemented (plan v2, all 6 deliverables) · TypeScript **cloud-tested green (47)** · Rust **compiles ✓ (`cargo build` clean on Mac, 14 Aug)** · **Settings UI added** (command hotkey + overlay indicator) · **synced to repo**. Remaining: `npm run widget` end-to-end run.

## What was implemented (dev agent, per approved `p1-plan.md` v2)

**TypeScript (cloud-verified):**
- `packages/core/src/index.ts` — barrel: added `./command/types`, `./command/registry`, `./command/grammar` only (NOT `./command/prompt` — would `TS2308`-collide with `correction/prompt`). Verified.
- `packages/core/src/settings.ts` — optional `commandProvider?` / `commandModel?` on `AppSettings`.
- `packages/core/src/command/fixtures.ts` + `fixtures.test.ts` — one of every `CommandIntent` variant (both inserts); asserts each passes `validateIntent`.
- `packages/core/src/command/pipeline.test.ts` — utterance→`getIntentProvider("mock").interpret` table incl. noop.
- `apps/backend/src/server.ts` — `isCommand`/`cmdId`/`commandModel` closure state; `cmdId = commandProvider?.trim() || correctionProvider || DEFAULT_CORR` (finding 4); command branch in `finalize()` before correction; skips correction construction in command mode; imports `getIntentProvider`.
- `apps/widget/src/main.ts` — `ServerMsg{type:"intent"}`; `connect("demo"|"live"|"command")`; `beginCommand()` reusing the dictation audio path via a `captureMode` flag; `runCommandIntent → invoke("run_command")` with secure/no_field/no_access routing; `listen("command",…)`; `command-mode` class toggle.

**Rust (authored, Mac-build-pending):**
- `apps/widget/src-tauri/src/command.rs` — NEW. serde `CommandIntent` (internally tagged `action`, kebab-case, collapsed `Insert{what,text}`, nested `Style/CaseMode/Target`); `run_command` with `focus_route()` guard → enigo keystrokes; `case` uses an explicit clipboard save→⌘C→transform→⌘V→restore (finding 8); `#[cfg(test)]` serde round-trip of the shared fixtures.
- `axinject.rs` — added `pub fn focus_route() -> &'static str` (`no_access|secure|editable|no_field`).
- `config.rs` — `command_provider`/`command_model`/`command_hotkey` on `AppConfig` + `Default`; `set_config` re-registers on `command_hotkey` change; `clear_config` unregisters.
- `state.rs` — `COMMAND_RECORDING`/`COMMAND_PRESS_AT`/`COMMAND_STARTED`.
- `hotkey.rs` — `CURRENT_COMMAND` + `apply_command_hotkey` + `get/set_command_hotkey`.
- `shortcuts.rs` — cold-start registration from `command_hotkey`; handler branch → `emit("command","start"|"stop")`; dictation path untouched.
- `main.rs` — `mod command;` + `command::run_command` / `get_command_hotkey` / `set_command_hotkey` in `invoke_handler!`.

## Cloud test results ✅
`npx vitest run` on the command module (re-verified by the orchestrator):
```
Test Files  6 passed (6)
     Tests  39 passed (39)   (24 classifier + 13 pipeline + 2 fixtures)
```
`tsc --noEmit` on the command dir: clean (exit 0). Barrel additions are name-safe (types + registry + grammar; prompt excluded).

## On-Mac checklist (run when back — none block further P-series work)
- [ ] `cargo build` / `npm run widget` clean; `cargo test` (command.rs serde round-trip) green.
- [ ] command hotkey emits start/stop, registers on cold start; dictation hotkey unaffected.
- [ ] bold / delete-last-sentence / new line land in Notes & Slack; widget never steals focus.
- [ ] password/secure field → `secure`; low-confidence phrase → `noop`.
- [ ] `command_provider` / `command_hotkey` persist; old `settings.json` still loads.
- [ ] `case` restores the clipboard to its pre-command contents.
- [ ] add a `.command-mode` style rule to the widget's HTML/CSS (not in the working snapshot).

## Commit status — QUEUED (infra, not a decision)
The device bridge disconnected during this session, so the implemented files are in the cloud working tree but **not yet committed to the repo**. Queued for commit on reconnect:
- **New files (safe):** `command.rs`, `command/fixtures.ts`, `command/fixtures.test.ts`, `command/pipeline.test.ts`.
- **Edited files (need a fresh re-pull + re-apply before commit):** `config.rs`, `state.rs`, `hotkey.rs`, `shortcuts.rs`, `axinject.rs`, `main.rs`, `index.ts`, `settings.ts`, `server.ts`, `main.ts`.
- ⚠ **`state.rs` reconciliation:** the working-tree base predates the repo's `LAST_RAW` addition (5.4). Before committing `state.rs`, re-pull the current repo version (which has `LAST_RAW`) and re-apply only the `COMMAND_*` static additions — do NOT overwrite with the stale base. The reviewer flagged this; the orchestrator will reconcile at commit time.

## Held items needing Mayank
None. (The bridge disconnect is an infra hold on committing only; all authoring/testing continued.)
