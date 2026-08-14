# P2 — System Commands via macOS Delegation — Implementation Plan

**Track:** Platform (P-series) · **Phase:** P2 · **Owner:** Mayank Banga · Saaslabs
**Date:** 13 Aug 2026 · **Status:** ✅ **APPROVED** (v2 — reviewer findings 1–7 folded in; see `p2-review.md`)
**Umbrella:** `../platform-evolution.md` (§4b). **Builds on:** P1 (command mode + the `CommandIntent` classifier + `run_command` executor).

> **Design stance (from platform-evolution §4b):** system commands ("open Slack", "volume up", "run my Standup shortcut") are a **commodity** — Siri/Raycast/Shortcuts already do them. So we **do not build an action engine.** We classify the utterance into a small closed set and **delegate execution to macOS** (`open -a`, `osascript`, the `shortcuts` CLI). The escape hatch — `run shortcut "<name>"` — makes it **user-extensible** for free. Positioning: convenience, not a headline.
>
> **Verification reality:** the grammar + classifier extension is TypeScript → **cloud-tested**. The delegation itself is `std::process::Command` in Rust → **authored, Mac-build-pending**.

## 1. Key decisions

1. **One command mode, one classifier — extend, don't fork.** P2 rides P1's command activation (the command hotkey) and the same backend classifier. We **extend the `CommandIntent` grammar** with a small system family rather than adding a second provider/hotkey. The executor dispatches field-edit variants (P1) to keystrokes and system variants (P2) to macOS delegation.
2. **Tiny closed v1 set** (launch / volume / run-shortcut). Media keys, brightness, etc. are deferred — `shortcut` already covers them for any user willing to make a Shortcut.
3. **Delegation targets, no bespoke engine:** `open -a "<App>"` (launch), `osascript -e 'set volume …'` (volume), `shortcuts run "<name>"` (arbitrary user Shortcut, macOS 12+). All via `std::process::Command` — **no new crates**.
4. **System commands are opt-in-safe:** a config flag gates them; the classifier may still emit them, but the executor refuses when disabled. Launch/volume/user-Shortcuts are low-risk (opening an app is benign; Shortcuts are the user's own), so no per-action confirmation in v1 — but the flag + the `noop`-bias remain the safety net.

## 2. Grammar additions (extend the P1 union)

New `CommandIntent` variants (TS `packages/core/src/command/types.ts`; mirrored in Rust `command.rs`):
```ts
| { action: "launch";   app: string }                          // open / activate an app
| { action: "volume";   direction: "up" | "down" | "mute" | "unmute" }
| { action: "shortcut"; name: string }                         // run a named macOS Shortcut
```
`validateIntent` (grammar.ts) extends: `launch`/`shortcut` require a non-empty string; `volume` requires an in-enum `direction`. `localParse` fast-paths the fixed phrases: "volume up/down", "mute", "unmute". `launch`/`shortcut` carry a free name → model-only.

## 3. Deliverables

### D1 — Grammar + classifier extension · *TS (cloud-tested)*
- `command/types.ts`: add the three variants above.
- `command/grammar.ts`: extend `validateIntent` (+ enum consts for `VolumeDir`); extend `localParse` for volume phrases.
- `command/prompt.ts`: extend `SYSTEM_PROMPT` — reframe as "ONE editing action **or** system command", list the new shapes, keep the strong **noop-bias** and "never invent an action/enum" rule. Add examples that separate an *edit* ("make that bold") from a *launch* ("open Slack") so the classifier doesn't confuse dictation-like phrases with launches.
- `command/fixtures.ts`: add one of each new variant (keep the Rust test's JSON list in sync).
- **Tests (cloud):** extend `grammar.test.ts` (validate accepts new shapes, rejects `launch` with empty app, rejects bad volume dir), `prompt.test.ts` (parse a launch/volume/shortcut JSON; out-of-grammar → null), `fixtures.test.ts`, `pipeline.test.ts` (mock rows for "volume up" via fast-path). Adapters need no change (same JSON-in-text / tool-use path).

### D2 — Rust system executor · *Rust (Mac-gated)*
- **(finding 1) `run_command` gains the `AppHandle`:** `pub fn run_command(app: tauri::AppHandle, intent: CommandIntent) -> Result<String,String>` (Tauri v2 auto-injects the handle; the JS `invoke("run_command",{intent})` is unchanged). This is needed to read `read_config(&app).system_commands` for the gate.
- **(finding 2) Dispatch split in `route_and_execute`, BEFORE the `focus_route` guard:** match the system variants (`Launch`/`Volume`/`Shortcut`) FIRST → gate on `read_config(&app).system_commands` (disabled → `"disabled"`) → `syscommand::*`. Only the P1 **field-edit** variants fall through to the `focus_route()` guard + `execute()`. (System actions must not require an editable field — else "open Slack" on the desktop returns `no_field`.)
- New `apps/widget/src-tauri/src/syscommand.rs` (all `std::process::Command` — **no shell, no new crates**):
  - `fn launch_app(app: &str) -> Result<String,String>` → `Command::new("open").args(["-a", app]).status()`.
  - `fn set_volume(dir: &VolumeDir) -> Result<String,String>` → up/down adjust `output volume` by a fixed step (±12 of 0–100) via `osascript` (the `-e` script is a **constant**; `dir` selects a branch, never interpolated). **(finding 6)** `Mute`/`Unmute` **reuse `system::set_output_muted(true/false)`** — the same primitive the dictation auto-mute uses — NOT a parallel `osascript` (avoids colliding with mute-others restore-on-stop).
  - `fn run_shortcut(name: &str) -> Result<String,String>` → `Command::new("shortcuts").args(["run", name]).status()`; missing binary (pre-Monterey) → `"unavailable"`.
  - Each returns `"done"` / error; never panics.
- **(finding 5) `command.rs` enum:** add `Launch { app: String }`, `Volume { direction: VolumeDir }`, `Shortcut { name: String }`, where `VolumeDir { Up, Down, Mute, Unmute }` is a `#[serde(rename_all="kebab-case")]` enum (serde rejects unknown directions, parity with `Style`/`Target`). Keep the fixtures/Rust-test list in sync.
- `main.rs`: `mod syscommand;` (no new tauri command — reuses `run_command`).
- **Tests (Mac):** `cargo build`; "open Slack" launches; "volume up/down/mute/unmute" works (mute via the shared primitive); "run shortcut 'X'" runs; **"open Slack" with focus on the desktop / a non-editable element still launches** (finding 2 regression); P1 edit commands still refuse on secure/no-field after the split; `system_commands=false` → `disabled`; serde round-trip incl. new fixtures.

### D3 — Config + settings · *Rust (Mac) + core TS (cloud)*
- **(finding 3)** `config.rs` `AppConfig`: add `system_commands: bool` **default `false`** (opt-in for v1 — flip to `true` after the edit-vs-launch classification checklist passes) + `Default` entry. (No allow-list in v1 — the no-shell guarantee makes it unnecessary; reconsider if dogfood shows accidental launches.)
- `settings.ts`: no core change needed (backend reads the flag off the config the Rust host owns; the classifier is vendor-config only). *Settings UI toggle "Allow system commands" is a Mac-side HTML/CSS add, listed in the checklist.*
- **Test:** *(cloud)* settings typecheck unaffected. *(Mac)* toggle gates execution; persists.

### D4 — Activation · *none (rides P1)*
No new hotkey/event. System commands are classified inside the same command-mode session as P1; the frontend already calls `invoke("run_command",{intent})`. **(finding 4)** `main.ts runCommandIntent` must add **explicit** `else if (result === "disabled")` and `=== "unavailable"` branches *before* the generic `else` — otherwise both render as a false "done ✓".

### D5 — Safety / permissions
- `open -a` and `shortcuts run` need **no special TCC permission**; `set volume` via `osascript` is a scripting addition (no Automation prompt). A *Shortcut the user runs* may itself trigger Automation prompts — that's the Shortcut's own surface, surfaced by macOS, not us.
- The `system_commands` flag + the classifier's `noop`-bias are the guardrails. Arbitrary shell is **never** run — only `open -a`, `osascript` (constant script) for volume, and `shortcuts run <name>`.
- **(finding 7) Hard invariant:** model-produced strings (`app`, `name`) are passed ONLY as `Command::args([...])` entries (direct `execvp`, no shell) — safe for spaces/quotes/`;`/`$(...)`. **No model string is EVER interpolated into an `osascript -e` string or `sh -c`.** A later contributor must not reintroduce that. This is why no allow-list is needed in v1.

## 4. Testing checklist

**Cloud (green before commit):**
- [ ] extended `grammar`/`prompt`/`fixtures`/`pipeline` tests green; new variants validate + parse; bad inputs → null/noop.
- [ ] `tsc --noEmit` clean on the command dir.

**Mac-gated (in `p2-progress.md`):**
- [ ] `cargo build` clean; serde round-trip (new fixtures) green.
- [ ] "open Slack"/"open Notes" launches/activates the app.
- [ ] "volume up/down/mute/unmute" changes system output volume; restores sanely.
- [ ] "run shortcut '<name>'" runs a user Shortcut; missing binary → `unavailable` banner.
- [ ] **"open Slack" with focus on the desktop / a non-editable element still launches** (focus-route bypass — finding 2).
- [ ] **P1 edit commands still refuse on secure/no-field** after the dispatch split (regression).
- [ ] `system_commands=false` → system intents no-op (`disabled` banner); field-edit commands (P1) still work.
- [ ] field-edit vs system classification is reliable on a small spoken test set (no "open Slack" misfiring as dictation, no "make that bold" launching an app).

## 5. Risks / notes
- **Misclassification between edit and system** is the main quality risk — mitigated by clear prompt examples + noop-bias; measured on-Mac.
- `shortcuts` CLI is macOS 12+; guard for absence.
- No allow-list in v1 — launching apps is benign; revisit if dogfood shows accidental opens.
- `set volume` step size (±12/100) is a tunable; document it.
