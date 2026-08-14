# P1 — Reviewer Verdict (independent cross-check, pre-implementation)

**Reviewer:** independent agent · **Date:** 13 Aug 2026 · **Input:** `p1-plan.md` v1 vs. the live code.
**Verdict:** **REVISE** → all findings resolved in `p1-plan.md` v2 → **APPROVED for implementation.**

The architecture and most groundings checked out (enigo is a real dep; the `CURRENT_PASTE_LAST`/`apply_paste_last_hotkey` second-hotkey pattern exists; `axinject::inject`'s routing contract; struct-level serde `default`; the `server.ts` start-frame + `finalize()` shape; the `main.ts` dictation listener). Four concrete blockers and five should-fixes were found and folded in.

## Must-fix (resolved in v2)

1. **Barrel export collision (would fail the plan's own `tsc` gate).** `command/prompt.ts` and `correction/prompt.ts` both export `SYSTEM_PROMPT` + `userMessage`; `export * from "./command/prompt"` in the barrel is a hard `TS2308`. **Resolution:** barrel exports only `./command/types` and `./command/registry` (+ `./command/grammar`, which is collision-free); never `./command/prompt`. The backend only needs `getIntentProvider` + the `CommandIntent` type.

2. **Rust `CommandIntent` can't mirror the TS union under `#[serde(tag="action")]`** — two variants share `action:"insert"`. **Resolution:** collapse to one `Insert { what: String, text: Option<String> }` variant, branch on `what` at runtime; add `#[serde(rename_all="kebab-case")]` on the enum + nested enums so wire values (`last-word`, `bold`, `upper`, …) deserialize.

3. **Secure-field refusal has no public API to call** — `run_command`'s keystrokes bypass `axinject::inject`, and `read_focus`/`is_secure` are private. **Resolution:** new deliverable — add `pub fn focus_route() -> &'static str` (`"no_access"|"secure"|"editable"|"no_field"`) to `axinject.rs`; `run_command` calls it before emitting keystrokes.

4. **`command_provider:""` ("follow correction") throws** — `getIntentProvider("")` isn't the `undefined` default, so `PROVIDERS[""]` throws. **Resolution:** resolve in `server.ts`: `cmdId = msg.commandProvider?.trim() || msg.correctionProvider || DEFAULT_CORR` before constructing.

## Should-fix (resolved in v2)

5. **Command mode is a full audio-capture session**, not a lightweight call — the backend only gets the transcript via batch-STT on stop. D4 now states command mode reuses the entire `beginDictation` audio path (getUserMedia → PCM stream → stop/finalize) with a different mode + terminal handler.
6. **`finalize()` needs an `isCommand` branch** set on `start` and read in the connection closure, *before* the `if (raw && correction)` block; skip constructing `getCorrectionProvider` in command mode.
7. **Frontend `ServerMsg` union + `connect()` signature + start frame** must be widened for `{type:"intent"}` and `mode:"command"` + `commandProvider`/`commandModel`.
8. **`case` copy→transform→paste clipboard restore is fragile** (`paste_text` snapshots the *transformed* text). v2 notes it needs an explicit save/restore around the whole sequence, not `paste_text`'s built-in restore.
9. **`apply_command_hotkey` must be registered at startup** in `shortcuts.rs setup()` (mirroring the paste-last registration), else it only binds after the first `set_config`.

## Test-coverage upgrade (folded into v2)
Add a **shared JSON fixture** of the exact `{action:…}` objects the frontend will `invoke("run_command",{intent})`, asserted by **both** a TS test (`validateIntent`) and a Rust `#[test]` (serde round-trip), so the two enum definitions can't silently diverge. Note explicitly that the `server.ts` command branch is unverified until the Mac run.

## Snapshot caveats (not plan defects)
- The working-tree `state.rs` snapshot lacked `LAST_RAW` though `text.rs` uses it — the live repo has it (stale stage). Confirm on Mac.
- `src-tauri/` snapshot had no `tauri.conf.json`/`capabilities/`. In Tauri v2, `generate_handler!` commands are not ACL-gated (existing `inject_text` has no per-command capability), so `run_command` almost certainly needs none — to confirm on Mac.

## Outcome
v1 → **v2** with findings 1–9 applied and the fixture test added. Plan is **approved for implementation**.
