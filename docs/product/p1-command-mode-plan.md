# Platform · P1 — Field-Scoped Command Mode — Implementation Plan

**Parent:** `platform-evolution.md` (§4a — the first handler on the platform track) · **Architecture:** `../architecture/overview.md` (provider roles), `../architecture/desktop-app-windows.md` (overlay + inject seam) · **Packages:** `packages/core` (new **IntentProvider** role — vendor-neutral, cloud-testable) + `apps/widget` (mode routing + native executor — Mac-only).

**Goal:** add a **second handler** beside dictation — **voice text-editing scoped to the field you're already in** (*"make that bold," "delete the last sentence," "new line," "scratch that"*) — by reusing the two hardest pieces we already built: the **AX focus read** (Phase 3.4) and **text injection** (`inject_text`). It introduces one new provider role in `packages/core` (mirroring `STTProvider` / `CorrectionProvider`), a **small, constrained command grammar**, a **deterministic executor**, and a **separate activation source** so command intent is never guessed from dictation text. The core is unit-testable in the cloud against a mock vendor; the AX/inject executor is proven on the Mac in a P1 exit demo.

> **Why P1 is first (recap from `platform-evolution.md` §4a/§8):** it's the *differentiated* command capability (scoped to the focused element — Siri structurally can't do this), it's the *smallest* build because it reuses AX + inject, and it *proves the `IntentProvider` role* that P2 (system commands) and the wake-word source (P3) then build on.

---

## Current state (grounded in the code)

Everything P1 needs to hang off already exists:

**Activation seam — `apps/widget/src-tauri/src/main.rs`.** The ⌥Space global shortcut runs a `Pressed`/`Released` state machine (`RECORDING`, `STARTED_THIS_PRESS`, `PRESS_AT`, `HOLD_MS`) giving tap-to-toggle + hold-to-talk, and emits `app.emit("dictation", "start"|"stop")`. On `Pressed` it calls `axinject::probe()` to **capture the focused field while the widget is still hidden**. The hotkey is runtime-configurable via a `CURRENT_TOGGLE` static + the `set_toggle_hotkey` command. The webview subscribes with `listen<string>("dictation", …)` in `apps/widget/src/main.ts`.

**Inject / AX seam — `apps/widget/src-tauri/src/axinject.rs`.** Public surface: `read_focus(max_wait_ms)`, `is_trusted()`, `probe()`, `inject(text) -> String`. The `inject_text` command returns a routing string the frontend already handles in `injectFinal()`: `"no_access"` (grant Accessibility), `"secure"` (password field → refuse + copy), `"no_field"` (copy instead), else inserted. **Note (from `STATUS.md`): AX-write via `kAXSelectedText` was a silent no-op on tested apps and is intentionally unused** — injection is clipboard + synthetic ⌘V. This shapes the executor design below.

**Provider-role pattern — `packages/core`.** `CorrectionProvider` (`correction/types.ts`) is `{ id, requiredKeys[], correct(), format?() }`. Resolution is a `PROVIDERS` map + `getCorrectionProvider()` + `assertCorrectionKeys()` (`correction/registry.ts`); the STT side mirrors it (`providers/registry.ts`). `correction/prompt.ts` holds the shared **JSON-in-text** discipline we copy wholesale: a system prompt, `parseJson()`, `reconstruct()`, and `validate()` — *validate the model's JSON, fall back if malformed*. `settings.ts` holds `AppSettings` + `resolveProviders()` + `capabilityErrors()`/`assertCapability()`.

**Pipeline transport.** Dictation runs over the M2 dev backend WS at `ws://127.0.0.1:8787`: the frontend sends `{type:"start", mode, sttProvider, correctionProvider, language}` then PCM frames, then `{type:"stop"}`; the server emits `ready` / `live` / `correction` / `formatted` / `done` / `error`. P1 rides the **same STT** to get one short utterance, but instead of `correction → format → inject` it runs `intent → execute`.

---

## Approach & key decisions

1. **New provider role, same shape as the other two.** Add `IntentProvider` in `packages/core/src/command/`: transcript → a **validated** `CommandIntent`. Same registry + capability pattern; adapters **reuse the existing correction vendors** (PyAI / OpenAI / Anthropic) as one wire-format file each, so **no new API keys** are introduced.
2. **Constrained grammar; JSON-in-text + validate-or-noop.** Copy the correction pipeline's discipline exactly: a **fixed action enum**, the model returns JSON only, we validate against a schema, and on any parse miss, unknown action, or low confidence we return **`noop` (do nothing)** rather than guess. There is no free-form action path.
3. **A deterministic executor performs the action — not the LLM.** The `IntentProvider` only *classifies*. A pure executor maps `CommandIntent` → concrete edits on the captured field. This keeps the model out of the action loop and makes behaviour predictable and testable.
4. **Separate activation, explicit mode.** P1 is reached by its **own activation** (a dedicated command hotkey now; a wake word later) — **never** by classifying dictation text (`platform-evolution.md` §2). `main.rs` emits a mode-tagged event; `main.ts` routes on it. The dictation and command paths never cross.
5. **Field-scoped only for P1.** Everything stays *inside the focused text field*: format / delete / case / insert / select over a selection or the last sentence/word. System actions (open app, volume) are **P2** (Shortcuts delegation), explicitly out of scope here.
6. **Cloud-testable core, Mac-only executor.** The `IntentProvider` + grammar + validation are pure TS → unit-tested in the cloud against a mock, exactly like the vendor adapters. The AX/inject executor is Mac-only (`cargo build` / `npm run widget`) and is proven in the P1 exit demo.
7. **Edits via synthetic keystrokes, not AX-write.** Because `kAXSelectedText` write is a known no-op (above), the executor expresses edits as **synthetic key events** (⌘B, ⌘A, ⌥⇧←, ⌫, Return) plus the existing clipboard-paste for literal inserts. Bonus: keystroke edits preserve the target app's **native ⌘Z undo**.

---

## The command grammar (v1 — deliberately small)

A closed union. The model must return one of these or `noop`; anything else fails validation → `noop`.

```ts
// packages/core/src/command/types.ts
type CommandIntent =
  | { action: 'format'; style: 'bold' | 'italic' | 'underline'; target: Target }
  | { action: 'delete'; target: Target }
  | { action: 'case';   mode: 'upper' | 'lower' | 'title'; target: Target }
  | { action: 'insert'; what: 'newline' }
  | { action: 'insert'; what: 'literal'; text: string }   // e.g. "type my email"
  | { action: 'select'; target: Target }
  | { action: 'noop';   reason: string };                 // low confidence → do nothing

type Target = 'selection' | 'last-word' | 'last-sentence' | 'all';

interface IntentProvider {
  readonly id: string;
  readonly requiredKeys: string[];
  interpret(transcript: string): Promise<IntentResult>;
}
interface IntentResult { intent: CommandIntent; valid: boolean; latencyMs: number; }
```

**System prompt shape** (mirrors `correction/prompt.ts`): *"Map the utterance to exactly one command from this JSON schema. Output ONLY the JSON. If it isn't clearly one of these actions, return `{\"action\":\"noop\",\"reason\":\"…\"}`. Never invent an action or target outside the enums."* Validation = the returned object type-checks against the union and every enum value is in range; otherwise `noop`.

**Executor mapping (v1, keystroke-expressible):**

| Intent | How the executor runs it |
|---|---|
| `format bold/italic/underline · selection` | ⌘B / ⌘I / ⌘U |
| `select all` / `delete all` | ⌘A / (⌘A then ⌫) |
| `insert newline` | Return |
| `insert literal` | clipboard + ⌘V (reuse `inject`) |
| `delete selection` | ⌫ |
| `delete/select last-word` | ⌥⇧← then (⌫ or leave selected) |
| `delete/select last-sentence` | best-effort: AX-read value+caret to compute the range, else repeated ⌥⇧← heuristic → `noop` if the field isn't AX-readable |
| `case …` | select target → clipboard transform → paste |

---

## Step-by-step

### 1. Core — the command role (`packages/core/src/command/`)
- `types.ts` — `IntentProvider`, `CommandIntent`, `IntentResult` (above).
- `grammar.ts` — the action/target enums + `validate(intent): boolean` (schema/range check) + a tiny **local deterministic parser** for a handful of exact, unambiguous phrases (*"new line", "scratch that", "select all"*) that bypasses the LLM entirely.
- `prompt.ts` — `SYSTEM_PROMPT` + `parseIntent(text)` (reuse `parseJson`'s first-JSON-object extraction).
- `registry.ts` — `getIntentProvider(id)` + `assertIntentKeys()` (mirror `correction/registry.ts`; named distinctly so the barrel `export *` doesn't collide).
- `mock.ts` — offline canned intents for cloud tests (mirrors `correction/mock.ts`).

### 2. Core — vendor adapters
`command/pyai.ts`, `command/openai.ts`, `command/anthropic.ts` — each maps the shared prompt onto its vendor chat wire format and returns raw JSON to `parseIntent` + `validate`. **Reuse the correction adapters' request plumbing**; `requiredKeys` are the *same* per-vendor keys, so no new keychain entries.

### 3. Settings — add the command provider
`settings.ts`: add `commandProvider?: CorrectionVendor` (reuse the existing vendor set), resolve it in `resolveProviders()`, and cover it in `capabilityErrors()`/`assertCapability()`. The Rust config store (`get_config`/`set_config`, `config-changed`) is generic — add the field + an optional `commandHotkey`.

### 4. Rust — a command activation source (`main.rs`)
Register a **second configurable hotkey** mirroring `CURRENT_TOGGLE` (e.g. `CURRENT_COMMAND` + `set_command_hotkey`). On `Pressed`, call `axinject::probe()` to capture focus exactly like dictation, then emit a **mode-tagged event** — either `app.emit("activate", { source, mode: "command" })` or reuse `"dictation"` with a `{mode}` payload. Keep the tap/hold machine if push-to-talk is wanted for commands; use **separate statics** so the dictation state machine is untouched.

### 5. Frontend — mode routing (`main.ts`)
Generalize the `listen("dictation", …)` handler to route by `mode`. In **command** mode: run the same mic → STT to capture one short utterance, but on stop send it down an **intent path** (a new backend message, or a direct core call) instead of `correction`/`format`; receive a `CommandIntent`; hand it to the executor via `invoke("run_command", { intent })`. Give the orb/card a distinct **command-mode indicator** so the user knows which mode they're in.

### 6. Rust — the executor (`run_command`)
New `#[tauri::command] fn run_command(intent)` that maps the intent to `axinject` operations against the captured focus using **synthetic keystrokes** (decision 7) plus `inject` for literal text. Return the **same routing contract** as `inject_text` (`"no_access"` / `"secure"` / `"no_field"` / `"done"`) so the frontend reuses `injectFinal`'s banner handling. Field-scoped edits only; **refuse in secure fields** (satisfies the security gate).

### 7. Backend (dev) — an intent branch
The M2 backend gains a `mode:"command"` branch: after STT finalize, run the `IntentProvider` instead of `correction`/`format` and emit `{type:"intent", intent}` (mirroring the `ready`/`live`/… protocol). *(Post-M4, when the client-side `@verbatim/core` path lands — roadmap M4.9 — this moves in-process and the dev backend drops, same as dictation.)*

### 8. Tests (cloud-green, no network)
`command/*.integration.test.ts` against a mock vendor WS/HTTP server (parse + validate + **noop-on-garbage**), `grammar.test.ts` (schema validation + the local fast-path parser), and a pipeline test (`transcript → intent`). Mirror `providers/deepgram.stt.integration.test.ts`. `npm run typecheck` clean.

---

## Safety / determinism

- **Bias to `noop`** on low confidence or any out-of-enum action — never execute a non-schema action.
- **Paths never cross:** the command executor never runs on dictation text and vice versa (separate activation + explicit `mode`).
- **Destructive edits stay undoable:** express edits as keystrokes so the target app's native ⌘Z works; `delete all` is a select-then-delete the user can immediately undo.
- **Secure/no-field** routing is inherited from the injection layer (password fields refused).
- Security gate unchanged: secret-scan + SAST + dep-audit; **no new keys** and no new secret surface (adapters reuse existing vendor keys).

---

## Acceptance criteria + verification

- **Cloud (no network):** `npm test` green including the new command suite (grammar validation, mock-vendor intent parse, noop-on-garbage, `transcript → intent`); `npm run typecheck` clean. *(Same bar the vendor adapters already meet.)*
- **On-Mac (P1 exit demo):** with the command hotkey, say *"make that bold"* / *"delete the last sentence"* / *"new line"* over Notes/Slack → the focused field changes correctly, the **widget never steals focus**, a **password field is refused**, and a low-confidence phrase is a **no-op** (nothing happens). *(Rust changes must be `cargo build` / `npm run widget`-verified on the Mac — they can't compile in the cloud authoring env.)*

---

## Risks / gotchas

- **Edits beyond paste are the real new native work.** `inject` only pastes; formatting/selection/delete need synthetic keystrokes (⌘B, ⌘A, ⌥⇧←, ⌫, Return). AX-write (`kAXSelectedText`) is a known no-op (`STATUS.md`), so **keystrokes are the path** — and they preserve native undo. Scope v1 to keystroke-expressible ops.
- **"Last sentence" resolution is app-dependent.** Computing the range needs the field value + caret via AX; some fields (Chromium/Electron lazy trees) won't expose it. v1: make **selection-scoped** ops rock-solid (⌘-based), and treat last-word/last-sentence as best-effort with a documented **fallback to `noop`** where the field isn't AX-readable.
- **Latency must feel instant.** Short utterance + a fast/cheap intent model (open decision in `platform-evolution.md` §9.1); the **local deterministic parser** handles the common exact phrases with zero model round-trip.
- **Mode discoverability.** Users must know they're in command mode — distinct orb/card state + indicator; otherwise a command reads as a failed dictation.
- **Don't regress dictation.** The second hotkey + event must use separate statics and not perturb `RECORDING`/`STARTED_THIS_PRESS`/`HOLD_MS`. This is a hard gate (`platform-evolution.md` §3, "never regress the core").

---

## Out of scope for P1 (tracked elsewhere)

- **System commands** (open app, volume, timers) → **P2** (macOS Shortcuts / AppleScript delegation).
- **Wake-word activation** → **P3** (openWakeWord, on-device).
- **Meeting handler** → parallel track (different capture path).
- **Going backend-free** (client-side `@verbatim/core`) → roadmap **M4.9 / M4 backbone**; P1 rides the dev backend like M3 until then.

---

## Definition of done

- [ ] `packages/core/src/command/`: `types.ts` (IntentProvider, CommandIntent, IntentResult), `grammar.ts` (+validate +local fast-path), `prompt.ts` (+parseIntent), `registry.ts` (getIntentProvider + assertIntentKeys), `mock.ts`.
- [ ] Command adapters `pyai.ts` / `openai.ts` / `anthropic.ts` (reuse correction plumbing; **no new keys**).
- [ ] `settings.ts` `commandProvider` (+ optional `commandHotkey`) resolved + capability-checked; Rust config field added.
- [ ] `main.rs`: command activation source (2nd configurable hotkey → `CURRENT_COMMAND`), `probe()`-on-press, distinct mode-tagged event; separate statics.
- [ ] `main.ts`: mode routing (dictate vs command); command path → intent → `run_command`; command-mode indicator.
- [ ] `run_command` Rust executor — keystroke-expressible field edits + literal paste; `inject_text` routing contract; secure/no-field refused.
- [ ] Backend `mode:"command"` intent branch emitting `{type:"intent", intent}` (dev path).
- [ ] Command tests green in cloud (grammar, mock-vendor parse, noop, `transcript → intent`); `tsc --noEmit` clean.
- [ ] On-Mac P1 exit demo: bold / delete-sentence / newline over a 3rd-party app; focus never stolen; password refused; low-confidence = noop.
