# P2 — Progress

**Phase:** P2 — System commands via macOS delegation · **Date:** 14 Aug 2026
**Overall:** Implemented (plan v2, findings 1–7) · TypeScript **cloud-tested green (47)** · Rust **compiles ✓ (`cargo build` clean on Mac, 14 Aug)** · **Settings UI added** ("Allow system commands" toggle) · **synced to repo**. Remaining: `npm run widget` end-to-end run.

## Implemented

**TypeScript (cloud-verified):**
- `command/types.ts` — `VolumeDir` + `launch`/`volume`/`shortcut` variants on the `CommandIntent` union.
- `command/grammar.ts` — `VOLUME_DIRS`; `validateIntent` extended (launch/shortcut need non-empty string; volume needs in-enum dir); `localParse` fast-paths "volume up/down", "mute", "unmute".
- `command/prompt.ts` — `SYSTEM_PROMPT` reframed to "editing action OR system command"; new shapes + edit-vs-launch + dictation→noop examples; noop-bias kept.
- `command/fixtures.ts` — one fixture per new variant.
- `command/{grammar,prompt,fixtures,pipeline}.test.ts` — accept/reject (empty launch app, bad volume dir), launch/volume/shortcut parsing, volume fast-path rows.

**Rust (authored, Mac-build-pending):**
- `command.rs` — `run_command(app: AppHandle, intent)` (finding 1); `VolumeDir{Up,Down,Mute,Unmute}` (kebab serde, finding 5) + `Launch`/`Volume`/`Shortcut` variants; **`route_and_execute` matches system variants FIRST, gates on `read_config(&app).system_commands` → `"disabled"`, before the `focus_route` guard** (finding 2); FIXTURES + serde tests extended.
- `syscommand.rs` — NEW. `launch_app` (`open -a`), `set_volume` (constant `osascript` up/down; **Mute/Unmute reuse `system::set_output_muted`**, finding 6), `run_shortcut` (`shortcuts run`, missing binary → `"unavailable"`). No shell; no model string ever interpolated (finding 7, documented as a hard invariant).
- `config.rs` — `system_commands: bool` **default false** (finding 3).
- `main.rs` — `mod syscommand;` (macOS-gated); `run_command` already registered (AppHandle auto-injected).

**Frontend (TS):**
- `main.ts runCommandIntent` — explicit `disabled` / `unavailable` banner branches before the generic else (finding 4).

## Cloud test results ✅
`npx vitest run`: **47 passed / 47** (6 files). `tsc --noEmit`: exit 0.

## On-Mac checklist (run when back)
- [ ] `cargo build` clean; serde round-trip incl. new fixtures green.
- [ ] "open Slack"/"open Notes" launches/activates.
- [ ] "volume up/down/mute/unmute" changes output volume (mute via the shared primitive; no collision with dictation mute-others restore).
- [ ] "run shortcut '<name>'" runs a user Shortcut; no `shortcuts` binary → `unavailable` banner.
- [ ] **"open Slack" with focus on the desktop / a non-editable element still launches** (focus-route bypass).
- [ ] **P1 edit commands still refuse on secure/no-field** after the dispatch split (regression).
- [ ] `system_commands=false` → system intents `disabled`; field-edit commands still work.
- [ ] add a Settings toggle "Allow system commands" (HTML/CSS, not in the cloud snapshot).

## Verify-on-Mac caveats (from the dev agent)
- **`system::set_output_muted` signature:** implemented assuming `fn set_output_muted(muted: bool) -> Result<_,String>` (bool only, matching the JS `invoke("set_output_muted",{muted})`). `system.rs` wasn't in the cloud snapshot — if the real signature also takes `AppHandle`, thread `app` into `set_volume`. **One-line fix if so.**
- `VOLUME_STEP` const (12) documents the step; the osascript uses the literal `12`/`-12` on purpose (zero interpolation, even of a constant).

## Held items needing Mayank
None. (Bridge disconnect = commit-queue only.)
