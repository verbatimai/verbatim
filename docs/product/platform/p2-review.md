# P2 — Reviewer Verdict (independent cross-check, pre-implementation)

**Reviewer:** independent agent · **Date:** 13 Aug 2026 · **Input:** `p2-plan.md` vs. live code.
**Verdict:** **APPROVE-WITH-CHANGES** → all findings folded into `p2-plan.md` v2 → **approved for implementation.**

The delegate-don't-build stance and the no-shell safety cornerstone are right; the TS grammar side slots in cleanly. Two structural must-fixes in the Rust executor + five should-fixes were found.

## Must-fix (resolved in v2)
1. **`run_command` has no `AppHandle`, so the `config.system_commands` gate is impossible as written.** `command.rs run_command(intent)` takes only the intent; config needs `read_config(&app)`. **Resolution:** `run_command(app: tauri::AppHandle, intent: CommandIntent)` (Tauri auto-injects the handle; the JS `invoke("run_command",{intent})` is unchanged); thread `app` into the dispatch so it can read the gate.
2. **System variants must branch BEFORE the `focus_route` guard.** `route_and_execute` short-circuits on `no_access|secure|no_field` and only reaches `execute` on `editable`. If the system variants sit inside `execute`, "open Slack" with focus on the desktop returns `no_field` and never launches. **Resolution:** in `route_and_execute`, match `Launch/Volume/Shortcut` FIRST → `syscommand::*` (after the config gate); only fall through to the `focus_route` guard for P1 field-edit variants.

## Should-fix (resolved in v2)
3. **Default `system_commands` should be `false` for v1** (opt-in), flipped after the edit-vs-launch classification checklist passes — the plan called it "opt-in-safe" but set `true` (opt-out).
4. **Explicit `disabled`/`unavailable` banner branches** in `main.ts runCommandIntent` — the generic `else` would render them as a false "done ✓".
5. **Rust `VolumeDir { Up,Down,Mute,Unmute }` enum** (kebab-case) instead of a raw `String`, for serde parity with `Style`/`CaseMode`/`Target` (rejects unknown directions at deserialize).
6. **`mute`/`unmute` must reuse the existing `system::set_output_muted` primitive**, not a parallel `osascript` — otherwise it collides with the dictation auto-mute/restore (`mute_others`). Document the interaction.
7. **Pin the no-interpolation invariant in D5:** `Command::args()` (no shell) is safe for model-produced app/shortcut names; the ONLY way to reintroduce injection is interpolating a model string into `osascript -e` or `sh -c` — explicitly forbid it so a later contributor can't. No allow-list needed given the no-shell guarantee.

## Test-coverage upgrade (folded in)
- Add one JSON string per new variant to the Rust `FIXTURES` list (Mac `cargo test`), synced with `fixtures.ts`.
- Add a checklist item for the **focus-route bypass**: "'open Slack' launches with focus on the desktop / a non-editable element" — the exact case must-fix #2 would silently break.
- Add a regression item: "P1 edit commands still refuse on secure/no-field after the dispatch split."

## What's right worth keeping
Delegate-not-engine + the `run shortcut "<name>"` escape hatch; `std::process::Command::args()` no-shell safety; extend-don't-fork the single classifier riding P1 activation; fixtures.ts↔Rust sync discipline; the `shortcuts`-CLI availability guard.

## Outcome
v1 → **v2** with findings 1–7 + test upgrades applied. Approved for implementation.
