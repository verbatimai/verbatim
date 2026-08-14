# P1 — Field-Scoped Command Mode — Implementation Plan (execution) · v2

**Track:** Platform (P-series) · **Phase:** P1 · **Owner:** Mayank Banga · Saaslabs
**Date:** 13 Aug 2026 · **Status:** ✅ **APPROVED for implementation** (reviewer verdict + resolutions in `p1-review.md`)
**Supersedes:** `../p1-command-mode-plan.md`. Umbrella: `../platform-evolution.md`.
**v2 changes:** folded in reviewer findings 1–9 (barrel collision, serde union, secure-field API, `""` resolution, full-audio-session, finalize branch, frontend types, clipboard restore, startup hotkey registration) + a shared TS↔Rust serde fixture test.

> **Verification reality:** TypeScript (core + backend) is cloud-tested green here. Rust/native is authored + reviewed, **Mac-build-pending** (marked per deliverable).

---

## 1. Scope
Spoken command → **one editing action on the focused field**. Classifier already built + cloud-verified: `packages/core/src/command/` (24 tests). This plan is the integration: config, backend intent branch, Rust executor, command activation, frontend routing, barrel export.

## 2. Deliverables

### D1 — Config: command settings · *Rust (Mac) + core TS (cloud)*
- `config.rs` `AppConfig`: add `command_provider: String` (`""` = follow the correction vendor — **resolved in the backend, see D3**), `command_model: String`, `command_hotkey: String` (`""` = unset). Add each to the struct **and** the `Default` impl.
- `set_config` side-effect: on `command_hotkey` change → `hotkey::apply_command_hotkey`. `clear_config`: reset + unregister.
- `packages/core/src/settings.ts`: add optional `commandProvider?: CorrectionVendor` + `commandModel?: string` to `AppSettings` (no `resolveProviders` change; command is resolved lazily by the backend).
- **Test:** *(cloud)* `settings.ts` typecheck. *(Mac)* round-trip + persist; old `settings.json` still loads.

### D2 — Command activation hotkey · *Rust (Mac)*
- `state.rs`: add `COMMAND_RECORDING`, `COMMAND_PRESS_AT`, `COMMAND_STARTED` (separate from dictation statics).
- `hotkey.rs`: add `CURRENT_COMMAND` static + `apply_command_hotkey(app,id)` (mirror `apply_paste_last_hotkey`; `""`=unregister) + `get/set_command_hotkey` commands (set routes via `set_config`).
- `shortcuts.rs`: **(finding 9)** register the command accelerator at startup in `setup()` from `read_config().command_hotkey` (mirror `apply_paste_last_hotkey` call at the paste-last registration site). In the handler add a branch: `is_command` → on Pressed `probe()` + tap/hold via `COMMAND_*` statics → `app.emit("command","start"|"stop")`. Dictation branch untouched.
- **Test:** *(Mac)* command hotkey emits `command` start/stop; dictation hotkey still works; no cross-talk; registers on cold start (not only after first `set_config`).

### D3 — Backend intent branch + barrel · *TS (cloud-testable)*
- **(finding 1)** `packages/core/src/index.ts`: add **only** `export * from "./command/types"` and `export * from "./command/registry"` (and `"./command/grammar"` — collision-free). **Do NOT export `./command/prompt`** — it collides with `correction/prompt` on `SYSTEM_PROMPT`/`userMessage` (`TS2308`).
- `apps/backend/src/server.ts`:
  - **(finding 6)** add `let isCommand = false` + `let commandModel/commandProvider` to the connection closure; set on `start` (`isCommand = msg.mode === "command"`).
  - **(finding 4)** resolve the provider: `const cmdId = (msg.commandProvider?.trim() || msg.correctionProvider || DEFAULT_CORR)`.
  - In command mode: **skip** constructing `getCorrectionProvider`; still open the STT session (live capture, batch-on-stop) exactly as dictation.
  - **(finding 6)** in `finalize()`, **before** the `if (raw && correction)` block: `if (isCommand) { const {intent} = await getIntentProvider(cmdId).interpret(raw,{model:commandModel}); send(ws,{type:"intent", intent, transcript: raw}); send(ws,{type:"done"}); return; }`. Keys from `process.env` (same as STT/correction); missing key → `{type:"error"}`, no crash.
- **New core test** `packages/core/src/command/pipeline.test.ts`: table of utterances → `getIntentProvider("mock").interpret` → asserts intents incl. noop. *(cloud-green)*
- **Test:** *(cloud)* full command suite + pipeline test green; `tsc --noEmit` clean with the barrel additions. *(Mac)* live command session returns an `intent` frame.

### D4 — Frontend routing · *TS (typecheck cloud; runtime Mac)*
- **(finding 7)** `main.ts`: widen `ServerMsg` with `{ type:"intent"; intent: CommandIntent; transcript: string }`; widen `connect(mode: "demo"|"live"|"command")`; add `commandProvider`/`commandModel`/`mode:"command"` to the start frame.
- **(finding 5)** `listen("command", …)`: command mode is a **full audio session** — reuse the `beginDictation` path (getUserMedia → AudioContext/ScriptProcessor → stream PCM → `stop`/finalize), differing only in `mode:"command"` and the terminal handler. Factor the shared audio setup so it can't drift from dictation.
- On `{type:"intent"}` → `invoke("run_command",{intent})`; route the returned string like `injectFinal` (secure/no_field/no_access banners). Render a distinct **command-mode indicator** (orb/card class).
- **Test:** *(cloud)* `tsc` if the widget TS typechecks standalone. *(Mac)* end-to-end.

### D5 — Rust executor `run_command` + axinject probe · *Rust (Mac)*
- **(finding 3)** `axinject.rs`: add `pub fn focus_route() -> &'static str` returning `"no_access"|"secure"|"editable"|"no_field"` (wraps the existing private `read_focus`/`is_secure`).
- New `src-tauri/src/command.rs`:
  - **(finding 2)** serde enum, internally tagged, kebab-case, inserts collapsed:
    ```rust
    #[derive(serde::Deserialize)]
    #[serde(tag = "action", rename_all = "kebab-case")]
    enum CommandIntent {
      Format { style: Style, target: Target },
      Delete { target: Target },
      Case   { mode: CaseMode, target: Target },
      Select { target: Target },
      Insert { what: String, #[serde(default)] text: Option<String> },
      Noop   { reason: String },
    }
    // Style/CaseMode/Target: #[serde(rename_all="kebab-case")] enums.
    ```
  - `#[tauri::command] fn run_command(intent: CommandIntent) -> Result<String,String>`: first `match axinject::focus_route()` — `"no_access"→return Ok("no_access")`, `"secure"→Ok("secure")`, `"no_field"→Ok("no_field")`; else emit **synthetic keystrokes via `enigo`**:
    - format → ⌘B/⌘I/⌘U · select all → ⌘A · delete all → ⌘A,⌫ · newline → Return · literal → `inject::paste_text` · delete selection → ⌫ · delete/select last-word → ⌥⇧←(+⌫) · last-sentence → best-effort ⌥⇧←, else `Ok("noop")` · noop → `Ok("noop")`.
    - **(finding 8)** `case`: explicit clipboard **save → ⌘C → read → transform → set → ⌘V → restore** in `run_command` (do NOT rely on `paste_text`'s built-in restore, which would snapshot the transformed text). Add a small settle delay after ⌘C.
  - Return `"done"` on success.
- `main.rs`: `mod command;` + `command::run_command` in `invoke_handler!`. *(Tauri v2 `generate_handler!` commands aren't ACL-gated — no capability entry expected; confirm on Mac.)*
- **Test:** *(Mac)* bold/delete-sentence/newline land in Notes & Slack; focus never stolen; password field → `secure`; noop does nothing; native ⌘Z undoes.

### D6 — Shared serde contract fixture · *TS (cloud) + Rust (Mac)*
- **(test upgrade)** `packages/core/src/command/fixtures.ts`: export `INTENT_FIXTURES: CommandIntent[]` (one of every variant incl. both inserts). `command/fixtures.test.ts` asserts each passes `validateIntent`. A Rust `#[cfg(test)]` in `command.rs` deserializes the same JSON strings (kept in sync) so the two enum definitions can't diverge.
- **Test:** *(cloud)* TS fixture test green. *(Mac)* Rust `cargo test` round-trip green.

## 3. Testing checklist

**Cloud (green before commit):**
- [ ] command suite (24) + `pipeline.test.ts` + `fixtures.test.ts` green.
- [ ] core `tsc --noEmit` clean with `settings.ts` fields + barrel (types+registry+grammar only).

**Mac-gated (tracked in `p1-progress.md`):**
- [ ] `cargo build` / `npm run widget` clean; Rust `cargo test` serde round-trip green.
- [ ] command hotkey emits start/stop, registers on cold start, dictation unaffected.
- [ ] bold/delete-last-sentence/newline land in a 3rd-party app; focus never stolen.
- [ ] password field → `secure`; low-confidence → `noop`.
- [ ] `command_provider`/`command_hotkey` persist; old `settings.json` loads.
- [ ] `case` clipboard is restored to its pre-command contents.

## 4. Risks / notes
- `enigo` needs Accessibility (already required) — banner if `focus_route()=="no_access"`.
- `case`/`last-sentence` are app-dependent v1 best-effort with `noop` fallback.
- Classification runs in the backend (keys there), not the renderer.
