# First-Run Onboarding — Implementation Plan (executable subtasks)

**What this is:** the build plan for phases **O1–O7** of `../product/onboarding-plan.md`, partitioned for **three dev agents working concurrently** on the same working tree. It is not a design document — every design question is already answered in the design doc of record and in the interactive spec `../product/onboarding-prototype.html`. This file exists to make that design buildable in parallel without conflicts.

**Derives from:** `docs/product/onboarding-plan.md` (design of record, 18 Aug 2026) · `docs/product/onboarding-prototype.html` (visual + behavioural spec; the `s1`/`s1help`/`s2`/`s3` render functions and the `V`/`detect`/`resolve`/`combo` helpers are the reference behaviour).
**Owner:** Mayank Banga · Saaslabs · **Drafted:** 18 Aug 2026
**Status:** ready for implementation. No production code written by this pass.

**In scope:** O1 (resolver + Screen 1 + second-role key slot), O2 (key verification), O3 (Screen 2 permissions), O4 (Screen 3 try-it), O5 (`setup_state` + anti-nag + `finish_onboarding`), O6 (build-time test key), O7 (docs). Plus the two side-fixes the design doc justifies as bug fixes: `capabilityErrors()` must treat **zero-key providers** as satisfied *and* assert the configured provider id is **registered**; `tray.rs` must read the hotkey from config instead of hardcoding `⌥Space`.

**Out of scope:** **O8 (local models).** It is gated on design-doc §9 #5 (where local inference runs), which is unanswered. Nothing in this plan renders a local card, adds a `local` provider id, or writes `sttProvider: "local"`. The forward-compatible pieces that *are* in scope are the two `capabilityErrors()` fixes above — they are what makes O8 landable later without touching Settings again.

Symbol names below are authoritative; line numbers are as-read on 18 Aug 2026. Re-locate by symbol if lines have drifted.

---

## 1. Ground rules for dev agents

**The repo is not local.** It is reachable only through `mcp__remote-devices__device_bash` at `$HOME/mnt/verbatim`.

- Every call is a fresh `bash -c`. No cwd or env carries over. **Always** start with `cd $HOME/mnt/verbatim && …`.
- Hard **45s timeout** per call. Never start a long-running or watching process (no `vite`, no `tauri dev`, no `--watch`).
- The device is a **Linux arm64 VM, not macOS**. There is **no `cargo`, no `rustc`, no `clippy`** there. `node` v22 and `python3` exist. `tsc` works.
- `node_modules` is installed but holds **darwin** native binaries — **`vitest` cannot run** on the device (rollup native-module error). Do not try.
- **Never run `git`** (any subcommand). It leaves `.git/*.lock` files that cannot be deleted from this side.
- **Never `rm`** anything under `$HOME/mnt/verbatim`. Deletes are refused by the mount. To "delete" code, replace the file's contents.
- Write files with `cat > path <<'EOF' … EOF` heredocs (quoted delimiter, so `$`/backticks stay literal) or `python3 - <<'PY' … PY` scripts.
- **Author Rust carefully: it cannot be compiled anywhere in this pipeline.** `cargo build` needs macOS-only deps (`tauri-nspanel`, `core-graphics`, `keyring/apple-native`, `ort` binaries). Rust tasks are verified by (a) `rustfmt --check` parse in the cloud container, and (b) the written self-review checklist in each task. Every Rust task therefore also produces a line for §9 (Deferred to the Mac). Prefer the most boring, most obviously-correct construct over the clever one; mirror an existing function in the same file rather than inventing a shape.
- **Touch only the files your task owns** (§6). If a task appears to need a file another agent owns, stop and report it — do not edit it.

### The only gates that exist here

| Gate | Command | Applies to |
|---|---|---|
| **TS (authoritative)** | `cd $HOME/mnt/verbatim && npm run typecheck --workspace @verbatim/widget` (~1.2s) | every TS/HTML task, at the end, must be green |
| **Resolver truth table** | `node --experimental-strip-types /tmp/resolver-check.mts` (§5.4) | DEV-A only; the resolver module must stay import-free so this works |
| **Rust syntax** | `rustfmt --check` in the cloud container (orchestrator stages the `.rs` files) + task self-review checklist | every Rust task |
| **Shell syntax** | `bash -n scripts/<file>.sh` | B8 |
| **Core unit tests** | cloud container, copied `packages/core`, fresh Linux `npm install`, `npx vitest run` | final regression only, not per-task |

Anything needing a real macOS runtime — permission prompts, AX, injection, Dock icon, tray, `cargo build`, `npm run widget` — is a **Mac-verify** item for the user (§9), never a pipeline gate. **No acceptance criterion in this plan may depend on a gate not in the table above.**

---

## 2. The command contract (fix this first; A and B build against it in parallel)

DEV-A writes the TS that calls these; DEV-B writes the Rust that implements them. Neither may deviate. Tauri passes JS object keys through as-is and matches them to Rust parameter names in **camelCase**; every argument name below is a single lowercase word, so JS and Rust spellings are identical — that is deliberate, keep it that way.

Checked against the `invoke_handler!` list in `main.rs:121-172` on 18 Aug 2026: **none** of the five new names collide.

### 2.1 New commands

| Command | Rust (module) | JS call | Returns | Failure modes |
|---|---|---|---|---|
| `key_verify` | `verify.rs` | `await invoke<VerifyOutcome>("key_verify", { vendor, secret })` | `{ ok: boolean; reachable: boolean }` | never rejects on network trouble — see truth table below. `Err(String)` only for an unknown `vendor` id. |
| `finish_onboarding` | `window.rs` | `await invoke("finish_onboarding", { state })` | `void` | `Err("bad setup state: <s>")` if `state` is not `"skipped"` or `"done"`. Config-write failure returns `Err(String)`; the window is still hidden. |
| `show_onboarding_window` | `window.rs` | `await invoke("show_onboarding_window")` | `void` | `Err("no 'onboarding' window")` |
| `test_key_available` | `testkey.rs` | `await invoke<boolean>("test_key_available")` | `boolean` | infallible |
| `use_test_key` | `testkey.rs` | `await invoke("use_test_key")` | `void` | `Err("no test key in this build")` when the constant is `None`; `Err(String)` from the secret store |

Exact Rust signatures (copy these):

```rust
// verify.rs
#[derive(serde::Serialize)]
pub struct VerifyOutcome { pub ok: bool, pub reachable: bool }

#[tauri::command(async)]                       // MUST be off the main thread — see §8 risk R6
pub fn key_verify(vendor: String, secret: String) -> Result<VerifyOutcome, String>

// window.rs
#[tauri::command]
pub fn finish_onboarding(app: tauri::AppHandle, state: String) -> Result<(), String>
#[tauri::command]
pub fn show_onboarding_window(app: tauri::AppHandle) -> Result<(), String>

// testkey.rs
#[tauri::command] pub fn test_key_available() -> bool
#[tauri::command] pub fn use_test_key(app: tauri::AppHandle) -> Result<(), String>
```

`key_verify` verdict truth table — the **only** two booleans the UI reads:

| Probe outcome | `ok` | `reachable` | Screen 1 shows |
|---|---|---|---|
| HTTP 2xx | `true` | `true` | advance silently |
| HTTP 401 / 403 | `false` | `true` | `"<Vendor> rejected this key. Check it and paste again."` — **do not advance, do not save** |
| any other status (429/5xx), timeout, DNS, offline | `true` | `false` | `"Couldn't reach <Vendor> — saved anyway"`, then advance |
| vendor `pyai` (probe is design-doc §9 #1, unresolved) | `true` | `false` | same "saved anyway" chip |

Rule, stated once: **`ok === false` is the only thing that blocks.** A network failure must never look like a bad key.

Per-vendor probes (§4 of the design doc), 2s timeout, `ureq` (already a dependency, `Cargo.toml:44`):

| Vendor | Request | Header(s) |
|---|---|---|
| `openai` | `GET https://api.openai.com/v1/models` | `Authorization: Bearer <secret>` |
| `anthropic` | `GET https://api.anthropic.com/v1/models` | `x-api-key: <secret>`, `anthropic-version: 2023-06-01` |
| `deepgram` | `GET https://api.deepgram.com/v1/auth/token` | `Authorization: Token <secret>` |
| `pyai` | **no request** — return `{ ok: true, reachable: false }` | — |

The secret is a parameter and **must never be logged, `dbg!`'d, or included in an error string**. `key_verify` does not store anything; on `ok` the caller invokes the existing `set_key`.

### 2.2 Existing commands, reused as-is (DEV-B must not change their signatures)

| Command | Where | JS call | Notes for DEV-A |
|---|---|---|---|
| `set_key` | `keys.rs:74` | `invoke("set_key", { vendor, secret })` | **restarts the backend sidecar** on every call. Two keys ⇒ two restarts ⇒ `await` them **serially** (§8 R3). |
| `set_config` | `config.rs:128` | `invoke<AppConfig>("set_config", { patch })` | shallow merge of a **camelCase** JSON object; returns the whole new config. Unknown/snake_case keys are silently dropped (§8 R2). |
| `get_config` | `config.rs:121` | `invoke<AppConfig>("get_config")` | read once at boot for `hotkey`, `theme`, `correctionProvider` sanitising. |
| `ax_trusted` | `system.rs:41` | `invoke<boolean>("ax_trusted")` | poll target for Screen 2. |
| `open_mic_settings` | `system.rs:15` | `invoke("open_mic_settings")` | |
| `open_accessibility_settings` | `system.rs:27` | `invoke("open_accessibility_settings")` | |
| `get_toggle_hotkey` | `hotkey.rs:169` | `invoke<string>("get_toggle_hotkey")` | returns the raw id (`"alt-space"` or `"Alt+Shift+KeyD"`), **not** a glyph — render it with the copied `describeHotkey` (§6, task A9). |

### 2.3 The one JS→JS event seam (DEV-C emits, DEV-A listens)

Screen 3 must not depend on AX injection landing in our own window (design-doc §9 #3 is unresolved, and it is unverifiable here). The overlay therefore **broadcasts** what it already knows.

```ts
// emitted by apps/widget/src/main.ts (DEV-C), inside handle()
type DictationProgress =
  | { phase: "live";       transcript: string; active: string }
  | { phase: "correction"; raw: string; cleanText: string;
      ops: { type: "keep" | "remove" | "replace"; text: string; replacement?: string }[] }
  | { phase: "final";      text: string };

await emit("dictation-progress", payload);   // fire-and-forget, .catch(() => {})
```

DEV-A listens with `listen<DictationProgress>("dictation-progress", …)` in the onboarding window. The event name is `dictation-progress` — exactly that string, in both files. It is emitted unconditionally on every dictation (harmless when no one is listening) so there is no cross-window handshake to get wrong.

---

## 3. Config schema delta

One new field. `config.rs`'s own header warns: the container-level `#[serde(rename_all = "camelCase", default)]` (`config.rs:17`) covers migration of an existing `settings.json` **only if the `Default` impl gains a matching entry**. Missing that entry is how you break every existing install.

| Field (Rust / TS) | Type | Default | Values |
|---|---|---|---|
| `setup_state` / `setupState` | `String` | `"unseen"` | `"unseen"` \| `"skipped"` \| `"done"` |

Rust (`config.rs`) — add to **both** places:

```rust
// in struct AppConfig, after history_limit:
pub setup_state: String,          // onboarding re-entry state: "unseen" | "skipped" | "done"
// in impl Default for AppConfig, after history_limit: 20,
setup_state: "unseen".into(),
```

TS mirror (`settings.ts`'s `AppConfig` type, `settings.ts:24-58`) — add `setupState?: string;`. Optional, like every other late-added field there.

Launch gate (`main.rs:116`) changes from `if !keys::any_vendor_key_saved(...)` to:

```rust
let cfg = config::read_config(app.handle());
if cfg.setup_state == "unseen" && !keys::any_vendor_key_saved(app.handle()) {
    let _ = window::open_onboarding_window(app.handle());
}
```

Migration behaviour, by case: an existing install **with** a key → `setup_state` defaults to `"unseen"` but `any_vendor_key_saved` is true ⇒ never opens (unchanged from today). An existing install **without** a key → opens exactly once more, then the user's choice is recorded. A brand-new install → opens. No `settings.json` can fail to parse, because the field has a `Default` entry and the container default fills it in.

**Deliberate gap, do not "fix" it:** closing the window with the red X goes through `register_onboarding_close_handler` (`window.rs:172`), which hides and reverts the policy but leaves `setup_state` at `"unseen"`. That is correct — if the user saved a key mid-flow, `any_vendor_key_saved` now suppresses the auto-open anyway; if they saved nothing, they genuinely have not been set up and one more prompt is right. The tray's **Finish setup…** covers both.

`any_vendor_key_saved` (`keys.rs:97`) stays **exactly as it is**. The design doc's "rename to *is any source configured*" is O8 work (it only matters once a keyless local source exists) — out of scope here.

---

## 4. The resolver spec

The resolver is the single source of truth for "what did the user give us, what do we write, and what do we say". It lives in a **new, pure, import-free module** so it can be executed on the device VM without a test runner (§5.4).

### 4.1 Module shape — `apps/widget/src/onboarding-resolve.ts`

**Hard constraint: this file has ZERO imports.** No `@tauri-apps/*`, no DOM types, no other repo module. That is what makes the truth-table gate possible.

```ts
export type Vendor = "openai" | "pyai" | "deepgram" | "anthropic";
export type Role = "stt" | "correction";
export type Mode = "full" | "raw" | "needStt";

export type VendorInfo = {
  name: string;      // "OpenAI"
  stt: boolean;
  correction: boolean;
  url: string;       // "platform.openai.com"
  blurb: string;     // one-line role, for the "I don't have a key yet" view
};
export const VENDORS: Record<Vendor, VendorInfo>;

/** camelCase keys only — this object is handed straight to set_config. */
export type ConfigPatch = {
  sttProvider?: string;
  correctionProvider?: string;
  correct?: boolean;
  format?: boolean;
};

export type Resolution = {
  mode: Mode;
  headline: string;              // the <p> under the title on Screen 1
  patch: ConfigPatch;            // {} when mode === "needStt"
  sttVendor: Vendor | null;      // which pasted key is the STT key (for set_key ordering)
  corrVendor: Vendor | null;     // which pasted key is the cleanup key (may be null)
};

export function detect(key: string): Vendor | null;
export function roleOk(v: Vendor, role: Role): boolean;
export function resolveFirst(v: Vendor | null): { mode: Mode; headline: string; chip: string } | null;
export function secondSlot(first: Vendor | null):
  { need: "none" } | { need: "optional" | "required"; role: Role; label: string; okList: string };
export function combo(first: Vendor | null, second: Vendor | null): Resolution | null;
export function slotError(first: Vendor | null, second: Vendor | null): string | null;
export function continueBlocked(first: Vendor | null, second: Vendor | null): boolean;
/** Repairs an existing unresolvable correctionProvider (defect #1) — see 4.5. */
export function sanitizeCorrection(current: string): string | undefined;
```

`VENDORS` is a direct port of the prototype's `V` (prototype lines 369-374), with `corr` renamed `correction` to match the rest of the codebase.

### 4.2 Detection (prototype `detect`, lines 375-383)

| Test, in this order | Vendor |
|---|---|
| `/^sk-ant-/i` | `anthropic` |
| `/^sk-/i` | `openai` |
| `/^[0-9a-f]{32,48}$/i` | `deepgram` |
| else, `trim().length >= 8` | `pyai` |
| else | `null` |

Order matters (`sk-ant-` before `sk-`). Detection is a **hint** rendered as an editable chip; the user can override it from the chip's picker, and `key_verify` is the real gate.

### 4.3 The resolution table (input → patch → mode → copy)

`first` = vendor of the key in the main field. `second` = vendor of the key in the second-role slot (or `null`).

| first | second | `mode` | `patch` written | `headline` |
|---|---|---|---|---|
| `openai` | *(any — ignored)* | `full` | `{sttProvider:"openai", correctionProvider:"openai", correct:true, format:true}` | "You're fully set up." |
| `pyai` | `null` | `raw` | `{sttProvider:"pyai", correct:false, format:false}` | "PyAI covers speech-to-text. Self-correction stays off until you add an OpenAI or Anthropic key." |
| `deepgram` | `null` | `raw` | `{sttProvider:"deepgram", correct:false, format:false}` | "Deepgram covers speech-to-text. Self-correction stays off until you add an OpenAI or Anthropic key." |
| `pyai` \| `deepgram` | `openai` \| `anthropic` | `full` | `{sttProvider:first, correctionProvider:second, correct:true, format:true}` | "Fully set up — speech and cleanup both covered." |
| `pyai` \| `deepgram` | `pyai` \| `deepgram` | `raw` | *(patch as the `raw` row; the slot shows `slotError` and Continue is blocked)* | as the `raw` row |
| `anthropic` | `null` | `needStt` | `{}` | "Anthropic does the cleanup. Verbatim also needs a speech-to-text key." |
| `anthropic` | `pyai` \| `deepgram` \| `openai` | `full` | `{sttProvider:second, correctionProvider:"anthropic", correct:true, format:true}` | "Fully set up." |
| `anthropic` | `anthropic` | `needStt` | `{}` | as the `needStt` row (slot error, Continue blocked) |
| `null` | any | — | `combo` returns `null` | "Paste one API key. That's the whole setup." |

**A `second` value is ignored whenever `secondSlot(first).need === "none"`.** This matters: a user can type a second key and *then* change the first key to an OpenAI one, leaving a stale `second` in state. `combo("openai", anything)` must return the OpenAI `full` resolution, `slotError(first, second)` must return `null`, and `continueBlocked` must be `false` — otherwise a stale value silently jams the Continue button with no visible cause. Same rule for `first === null`.

`sttVendor` / `corrVendor` tell the caller which key to save under which vendor id, and in what order: **STT key first, cleanup key second**, so the sidecar's last restart already has both.

### 4.4 Second slot, role gating, and Continue

`secondSlot(first)` (design doc §2.4):

| `first` covers | `need` | `role` asked for | `label` | `okList` |
|---|---|---|---|---|
| speech only (`pyai`, `deepgram`) | `"optional"` | `"correction"` | `"Cleanup key"` | `"OpenAI or Anthropic"` |
| cleanup only (`anthropic`) | `"required"` | `"stt"` | `"Speech-to-text key"` | `"PyAI, Deepgram or OpenAI"` |
| both (`openai`) | `"none"` | — | — | — |
| `null` | `"none"` | — | — | — |

`slotError(first, second)` returns `null` when `secondSlot(first).need === "none"` or `second === null`; otherwise `null` unless the `second` vendor cannot serve the asked-for role, in which case:
`"<Vendor> can't do <cleanup|speech-to-text>. Use <okList>."`

`continueBlocked(first, second)` is `true` iff:
- `first === null`, **or**
- `slotError(...) !== null` (a key was pasted into the wrong role — stop and explain, never silently discard), **or**
- `secondSlot(first).need === "required"` and `second` does not satisfy that role.

An **optional** slot left empty never blocks. An optional slot with a wrong-role key **does** block — that is the design's deliberate choice (§2.4).

### 4.5 Invariants (each is a self-test assertion in §5.4)

1. **Never write a provider id a registry can't resolve.** `patch.sttProvider ∈ {"pyai","deepgram","openai"}` (matching `providers/registry.ts`'s `STT_PROVIDERS`) and `patch.correctionProvider ∈ {"openai","anthropic"}` (matching `correction/registry.ts`'s `PROVIDERS`). No branch may emit `"local"`, `"fixture"`, `"mock"`, or `"pyai"` as a correction id. **There is no `local` branch in this pipeline** (O8).
2. **Never leave `correct`/`format` on without a correction capability.** `patch.correct === true` ⇔ `patch.format === true` ⇔ `patch.correctionProvider` is present in the same patch. In `raw` mode both are explicitly `false` — never omitted, because the config's stored value may already be `true`.
3. **`raw` mode does not name a correction vendor** — it leaves `correctionProvider` at the config default (`"openai"`: valid-but-keyless, which `server.ts` handles silently) rather than writing an id that would banner. **Exception (defect #1 repair):** if the *current* config's `correctionProvider` is not in `{"openai","anthropic"}` — i.e. an install already poisoned with `"pyai"` by today's onboarding — `sanitizeCorrection(current)` returns `"openai"` and the caller merges it into the `raw` patch. For any already-valid value it returns `undefined` and nothing is written.
4. **Role capability is checked in both slots before anything is saved.** No `set_key` and no `set_config` may run while `continueBlocked(...)` is true.
5. **`needStt` writes nothing at all.** An Anthropic-only setup must not leave a half-written config behind.

---

## 5. File ownership (exclusive) and shared conventions

No two agents write the same file. This is the property that makes concurrency safe; it is not negotiable.

| Agent | Owns, exclusively |
|---|---|
| **DEV-A** | `apps/widget/onboarding.html`, `apps/widget/src/onboarding.ts`, `apps/widget/src/onboarding-resolve.ts` *(new)*, `apps/widget/src/onboarding.css` |
| **DEV-B** | everything under `apps/widget/src-tauri/src/` (new `verify.rs`, new `testkey.rs`; edits to `config.rs`, `window.rs`, `tray.rs`, `main.rs`), `apps/widget/src-tauri/capabilities/default.json`, `apps/widget/src-tauri/tauri.conf.json`, `scripts/assert-no-test-key.sh` *(new)* |
| **DEV-C** | `apps/widget/src/settings.ts`, `apps/widget/settings.html`, `apps/widget/src/main.ts`, `apps/widget/index.html`, `README.md`, `docs/product/STATUS.md`, `docs/product/onboarding-plan.md` |

`main.rs`'s `invoke_handler!` list is the classic three-way conflict magnet — that is precisely why **one** agent owns all Rust.

Files nobody touches: `apps/widget/vite.config.ts` (the `onboarding` rollup input already exists — do not add a page), `apps/widget/src-tauri/Cargo.toml` (`ureq` is already there — **no new dependency is needed by any task in this plan**), `packages/core/**`, `apps/backend/**`.

### 5.1 No cross-file imports between agents' code

`settings.ts` and `main.ts` are page-entry modules with top-level DOM side effects; importing either from `onboarding.ts` would execute them. DEV-A therefore **copies** the ~18 lines of `PRESET_LABELS` + `describeHotkey` from `settings.ts:432-449` into `onboarding.ts`, exactly as `settings.ts` itself duplicates `VENDOR_ENV` from Rust. Note the duplication in a comment, same as the existing precedents.

### 5.2 CSS

`onboarding.html` already loads `/src/settings.css` then `/src/onboarding.css`. The prototype's design tokens (lines 9-31) are **verbatim copies of `settings.css`'s** `:root` / `body[data-theme="dark"]` blocks, so DEV-A inherits them and must **not** redefine any `--*` variable. Port only the window-internal rules from the prototype: lines **85-262** (`.pane`, `.head`, `.dots`, `.preview`, `.cut`, `.previewTag`, `.field`, `.meta`, `.chip`, `.err`, `.okline`, `.spin`, `.vpop`, `.testkey`, `.secondRow`, `.kg`, `.kr`, `.trust`, `.foot`, `.link`, `.btn`, `.prow`, `.stat`, `.info`, `.trybox`, `.pill`, `.tips`, `.tip`, `.done`) plus the keyframes at lines 121-128, 151, 248, 258. **Skip** `.win`, `.tbar`, `.topbar`, `.board*`, `.bcell`, `.notes`, `.stage`, `.menubar`, `.bubble`, `.orb`, `.modelrow`, `.prog`, `.dlrow`, `.localcard` — those are prototype chrome, macOS window simulation, or O8.

`.btn` / `.btn.primary` also exist in `settings.css`. Keep the prototype's versions scoped under `.onboard` (e.g. `.onboard .btn { … }`) so nothing in Settings shifts.

### 5.3 Theme

`onboarding.html`'s `<body class="settings-window" data-theme="system">` already works. Set `document.body.dataset.theme = cfg.theme ?? "system"` from the boot `get_config`, and update it on `config-changed`. Do not invent a second theme mechanism.

### 5.4 The resolver truth-table gate (DEV-A's own gate)

`node --experimental-strip-types` runs TypeScript directly on the device VM (verified: node v22.22.3). Because `onboarding-resolve.ts` has no imports, it can be driven straight from a scratch file **outside the repo** (`/tmp`, so nothing is added to the tree and nothing needs deleting):

The device VM's `$HOME` is not predictable and a static `import` needs a literal specifier — so use a **dynamic** import of a computed path (verified working under `--experimental-strip-types`, node v22.22.3):

```bash
cd $HOME/mnt/verbatim && cat > /tmp/resolver-check.mts <<'EOF'
const R: any = await import(process.env.HOME + "/mnt/verbatim/apps/widget/src/onboarding-resolve.ts");
const { detect, combo, secondSlot, slotError, continueBlocked, sanitizeCorrection } = R;
const STT_OK = new Set(["pyai","deepgram","openai"]);
const CORR_OK = new Set(["openai","anthropic"]);
let bad = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { bad++; console.log("FAIL", label, "got", a, "want", b); }
};
// … one `eq` per row of §4.3 and §4.4, plus the invariant sweep below …
for (const f of [null,"openai","pyai","deepgram","anthropic"] as const)
  for (const s of [null,"openai","pyai","deepgram","anthropic"] as const) {
    const r = combo(f as any, s as any); if (!r) continue;
    if (r.patch.sttProvider && !STT_OK.has(r.patch.sttProvider)) { bad++; console.log("FAIL inv1 stt", f, s, r.patch); }
    if (r.patch.correctionProvider && !CORR_OK.has(r.patch.correctionProvider)) { bad++; console.log("FAIL inv1 corr", f, s, r.patch); }
    const on = r.patch.correct === true;
    if (on !== (r.patch.format === true) || on !== (r.patch.correctionProvider !== undefined)) { bad++; console.log("FAIL inv2", f, s, r.patch); }
    if (r.mode === "needStt" && Object.keys(r.patch).length) { bad++; console.log("FAIL inv5", f, s, r.patch); }
  }
console.log(bad ? `${bad} FAILURES` : "resolver OK");
process.exit(bad ? 1 : 0);
EOF
node --experimental-strip-types /tmp/resolver-check.mts
```

The check must print `resolver OK` and exit 0. It writes only to `/tmp` on the device VM — never into the repo.

---

## 6. Task list

24 tasks. **DEV-A: 10 · DEV-B: 8 · DEV-C: 6.** A1, B1 and C1 have no dependencies — all three agents start immediately. Within an agent, tasks are ordered; across agents there is exactly one runtime dependency (A's calls need B's commands to exist at *Mac-verify* time, not at authoring time, because the contract in §2 is fixed).

Legend for **Verify**: `TS` = the typecheck gate · `RES` = the §5.4 resolver check · `RUST` = rustfmt parse + self-review checklist · `SH` = `bash -n` · `MAC` = deferred to §9.

### DEV-A — the onboarding webview

**A1 · Resolver module** — *new* `apps/widget/src/onboarding-resolve.ts`. Implement §4 exactly: `VENDORS`, `detect`, `roleOk`, `resolveFirst`, `secondSlot`, `combo`, `slotError`, `continueBlocked`, `sanitizeCorrection`, and the types. **Zero imports.** No DOM, no `invoke`. Deps: none. **Verify: TS + RES** (write `/tmp/resolver-check.mts` per §5.4 with one assertion per row of §4.3/§4.4 plus the invariant sweep; must print `resolver OK`).

**A2 · HTML shell** — `apps/widget/onboarding.html`. Replace the entire `<main class="onboard">…</main>` block (the vendor grid, `#onboardKey`, `#onboardError`, `#onboardSkip`, `#onboardSave`) with a single mount point: `<main class="onboard" id="root"></main>`. Keep `<head>` (both stylesheets, the favicon, the title) and `<body class="settings-window" data-theme="system">` and the `<script type="module" src="/src/onboarding.ts">` tag unchanged. Do **not** leave any `<input>` in the markup — A4 creates both key fields in TS and keeps those nodes alive across renders. Replace the file's contents; never `rm` it. Deps: none. **Verify: TS** (plus `grep -c 'id="root"' apps/widget/onboarding.html` = 1).

**A3 · Styles** — `apps/widget/src/onboarding.css`. Replace its contents with the ported rules per §5.2. Keep a `.onboard` root rule that makes the pane a full-height flex column (the prototype's `.pane`, lines 101-102, is the model: `flex:1; display:flex; flex-direction:column; padding:18px 24px 16px; overflow:hidden`). Delete the old `.onboard-vendors` / `.onboard-vendor` / `#onboardKey` / `.onboard-error` / `.onboard-actions` rules — nothing references them after A2. Deps: A2. **Verify: TS** (CSS is not typechecked; confirm no `--`-variable is redefined: `grep -c '^[[:space:]]*--' apps/widget/src/onboarding.css` = 0, i.e. no `--var:` declaration lines).

**A4 · Screen 1 shell, state, and the render loop** — `apps/widget/src/onboarding.ts`. Rewrite the file. Port the prototype's `s1` (lines 484-568) minus the local card. Requirements:
- Boot: `const cfg = await invoke<AppConfig>("get_config")` once; store `hotkey`, `theme`, `correctionProvider`. Apply the theme (§5.3).
- State object mirroring the prototype's `base()` minus every local-model field: `{ screen, key, vendor, pick, reveal, verify, help, mode, key2, v2, second, mic, ax, tryState }`.
- **The two `<input>` elements are created ONCE and never re-rendered.** Re-render only the surrounding chrome and re-insert the same input nodes. This is a deliberate deviation from the prototype: `s1`'s `value="${shownKey}"` string interpolation breaks on a key containing a quote and forces the `paint`/`paint2` focus/caret hack (prototype lines 774-800). Keeping the nodes alive removes the interpolation, the caret bug, and the duplicated wiring in one move. Masking is done with `input.type = reveal ? "text" : "password"`, not by substituting bullet characters into the value.
- Autofocus the first input; `Enter` in either input triggers the Continue action; the eye button toggles `reveal` for both inputs.
- Editable detected-vendor chip + the 4-button override picker (prototype `.vpop`, lines 551-552), which sets `state.vendor` and resets `verify` to `"idle"`.
- The animated preview + its caption render only while `state.vendor === null` (prototype's `compact` flag).
- The `"I don't have a key yet"` full-view replacement (prototype `s1help`, lines 458-482): four `.kr` rows from `VENDORS`, OpenAI flagged `1 key = all`, links opened with `window.open("https://" + VENDORS[v].url)`.
- The BYOK trust line and the `"Set up later"` link (wired in A10).
- **Never `console.log` a key or interpolate one into HTML.**
Deps: A1, A2, A3. **Verify: TS.**

**A5 · The second-role slot** — `apps/widget/src/onboarding.ts`. Port prototype lines 554-570 using `secondSlot`/`slotError`/`continueBlocked`. Collapsed one-liner when `need === "optional"` (expands on click, `state.second = true`); always expanded when `need === "required"`; absent when `need === "none"`. Show the ok-line or the role error under the field. The Continue button's `disabled` follows `continueBlocked(state.vendor, state.v2) || state.verify === "checking"`. The first key's chip keeps describing the *first* key while the headline reflects the *combined* result (`combo(...).headline`). Deps: A4. **Verify: TS.**

**A6 · Verify + save + advance** — `apps/widget/src/onboarding.ts`. On Continue from Screen 1, in this exact order:
1. `if (continueBlocked(...)) return;`
2. `state.verify = "checking"`, re-render (spinner chip).
3. `const v1 = await invoke<VerifyOutcome>("key_verify", { vendor: state.vendor, secret: state.key })`. If `!v1.ok` ⇒ `state.verify = "bad"`, render the rejection copy, **do not save, do not advance**.
4. If the slot is in use (`state.v2 !== null`), the same call for `{ vendor: state.v2, secret: state.key2 }`, same rule.
5. `state.verify = v1.reachable ? "ok" : "offline"`.
6. Save keys **serially**. Build `const secretOf: Partial<Record<Vendor, string>> = { [state.vendor]: state.key, ...(state.v2 ? { [state.v2]: state.key2 } : {}) }` — the two pasted keys indexed by their vendor — then `await invoke("set_key", { vendor: r.sttVendor, secret: secretOf[r.sttVendor] })`, and, only if `r.corrVendor && r.corrVendor !== r.sttVendor`, the same for `r.corrVendor`. **STT first** (§4.3), never `Promise.all` (§8 R3).
7. Build the patch: `const patch = { ...r.patch }`; if `r.mode === "raw"`, `const fix = sanitizeCorrection(cfg.correctionProvider); if (fix) patch.correctionProvider = fix;` then `const next = await invoke<AppConfig>("set_config", { patch })`.
8. `state.mode = r.mode; state.screen = 2;` render.
Any thrown error from `set_key`/`set_config` surfaces as `"Couldn't save that key — check it and try again."` and leaves the user on Screen 1 with Continue re-enabled. Deps: A5, contract §2. **Verify: TS** + MAC.

**A7 · Internal test-key button** — `apps/widget/src/onboarding.ts`. On boot, `const internal = await invoke<boolean>("test_key_available").catch(() => false)`. Render the `.testkey` button (prototype lines 572-578) only when `internal && state.vendor === null`. On click: `await invoke("use_test_key")`, then apply the **PyAI `raw`** resolution — `combo("pyai", null)` — through the same save path as A6 step 7 (patch only; `use_test_key` already stored the secret and restarted the sidecar, so **do not call `set_key`**), set `state.mode = "raw"`, advance to Screen 2. Sub-label copy from §7. Deps: A6. **Verify: TS** + MAC (both build variants).

**A8 · Screen 2 — permissions** — `apps/widget/src/onboarding.ts`. Port prototype `s2` (lines 634-668) minus the local strip.
- Mic row: the button calls `navigator.mediaDevices.getUserMedia({ audio: true })`, then **immediately** `stream.getTracks().forEach(t => t.stop())`, sets `state.mic = true`. On rejection: `state.mic = false` and swap the button to `open_mic_settings` + re-check.
- AX row: `state.ax = await invoke<boolean>("ax_trusted")` on entry, then **poll every 1000 ms while and only while Screen 2 is visible** (`setInterval` started on entry, `clearInterval` on leave and on `beforeunload`). The button calls `open_accessibility_settings`. Show the "watching for the toggle" spinner line while `!state.ax`.
- Disclosure strip: amber `.info` for `state.mode === "raw"`, nothing for `"full"`. No local/green variant (O8).
- `Continue` is **never disabled**; its label is `"Continue anyway"` while either row is unmet, `"Continue"` when both are granted. `Back` returns to Screen 1 (and must clear the AX poll interval on the way out).
Deps: A6. **Verify: TS** + MAC (real prompts).

**A9 · Screen 3 — try it** — `apps/widget/src/onboarding.ts`. Port prototype `s3` (lines 671-720) minus the download-waiting branch.
- Copy `PRESET_LABELS` + `describeHotkey` from `settings.ts:432-449` (§5.1) and render `describeHotkey(await invoke<string>("get_toggle_hotkey"))` in every place the prototype hardcodes `⌥Space` — the headline, the `.pill`, and the `.tip` keycap.
- Subscribe to `listen<DictationProgress>("dictation-progress", …)` (§2.3) and drive `tryState`: `live` ⇒ `"listening"` (render `transcript`), `correction` ⇒ `"correcting"` (render `cleanText` with removed spans as `<s>`, from `ops`), `final` ⇒ `"done"` (render `text`). **The in-window `.trybox` is the primary surface; AX injection into our own field is not required and is not relied on** (design-doc §9 #3 is unresolved and unverifiable here — the design doc's own fallback becomes the primary implementation; see §8 R7).
- `"Skip the test"` jumps straight to `tryState = "done"`.
- Unsubscribe on `beforeunload`.
Deps: A8. **C3 is a runtime dependency only** — the event name and payload are frozen in §2.3, so DEV-A authors against the contract and never waits for DEV-C; only Mac-verify M10 needs both halves. **Verify: TS** + MAC (a real hold of the hotkey).

**A10 · Exit paths** — `apps/widget/src/onboarding.ts`. `"Set up later"` ⇒ `await invoke("finish_onboarding", { state: "skipped" })`. `"Done"` ⇒ `await invoke("finish_onboarding", { state: "done" })`. **No call to `getCurrentWindow().hide()` may remain anywhere in the file** — that is the Dock-icon leak (design-doc §0.6). Remove the `getCurrentWindow` import entirely if nothing else needs it. Both calls are `.catch(() => {})` — Rust hides the window *before* it writes the config (B4), so a write failure must not surface as a stuck button. Deps: A4, contract §2. **Verify: TS** + `grep -c "getCurrentWindow" apps/widget/src/onboarding.ts` must be `0` + MAC.

### DEV-B — the Rust host

**B1 · `setup_state` in the config** — `apps/widget/src-tauri/src/config.rs`. Add the field to `AppConfig` (after `history_limit`, `:53`) **and** the matching entry to `impl Default` (after `history_limit: 20`, `:93`) exactly as §3 specifies. No side-effect block in `set_config` is needed (the field has no live consequence). Deps: none. **Verify: RUST.** Self-review: field present in *both* struct and `Default`; snake_case in Rust; no other field reordered.

**B2 · `verify.rs`** — *new* `apps/widget/src-tauri/src/verify.rs`. Implement `VerifyOutcome` + `key_verify` per §2.1. Structure: one `fn probe(vendor: &str, secret: &str) -> Result<VerifyOutcome, String>` doing the `ureq` call, called from the `#[tauri::command(async)]` wrapper. Build the agent once per call: `ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(2)).build()`. Classify with ureq 2's error enum: `Ok(_)` ⇒ `{ok:true,reachable:true}`; `Err(ureq::Error::Status(401 | 403, _))` ⇒ `{ok:false,reachable:true}`; every other `Err` and every other status ⇒ `{ok:true,reachable:false}`. `"pyai"` returns `{ok:true,reachable:false}` without a request, with a comment citing design-doc §9 #1. Unknown vendor ⇒ `Err(format!("unknown vendor: {vendor}"))`. Deps: none. **Verify: RUST.** Self-review: the `secret` never appears in a `format!`/`eprintln!`; `#[tauri::command(async)]` present (§8 R6); no `unwrap()` on network results; `use` statements resolve to crates already in `Cargo.toml`.

**B3 · `testkey.rs`** — *new* `apps/widget/src-tauri/src/testkey.rs`. Exactly the design doc's §7 sketch: `const TEST_KEY: Option<&str> = option_env!("VERBATIM_PYAI_TEST_KEY");`, `test_key_available()`, and `use_test_key(app)` which calls `crate::secrets::secret_set(&app, "PYAI_API_KEY", k)?` then `crate::backend::restart_backend(&app)`. Also add the internal watermark: a `pub fn watermark_title(app: &tauri::AppHandle)` that, when `TEST_KEY.is_some()`, sets the onboarding window title to `"Welcome to Verbatim (internal build)"` — called from `setup()` in B6. The account name `"PYAI_API_KEY"` must match `keys.rs::vendor_key_name`'s `"pyai"` arm (`keys.rs:65`) and `backend.rs::VENDOR_KEYS` (`backend.rs:15`). Deps: none. **Verify: RUST.** Self-review: `option_env!` (compile-time), **not** `std::env::var`; the key string is never returned to the renderer, never logged; `use_test_key` returns `Result<(), String>`.

**B4 · `finish_onboarding` + `show_onboarding_window`** — `apps/widget/src-tauri/src/window.rs`. Add both commands per §2.1, next to `open_onboarding_window` (`:160`). `finish_onboarding` must run in exactly this order, so that **the window closes and the policy reverts even if the config write fails**:
1. validate `state` ∈ `{"skipped","done"}` — else return `Err(format!("bad setup state: {state}"))` **before** touching anything;
2. `let mut cfg = crate::config::read_config(&app);` then hide the `"onboarding"` webview (`app.get_webview_window("onboarding")` → `let _ = w.hide();`);
3. `#[cfg(target_os = "macos")] let _ = app.set_activation_policy(desired_activation_policy(cfg.dock_icon));` — the whole point (design-doc §0.6);
4. `cfg.setup_state = state; let wrote = crate::config::write_config(&app, &cfg);` — **use `write_config` on a full struct, not `set_config`**, so there is no JSON merge and no `config-changed` broadcast storm;
5. `crate::tray::refresh_menu(&app);` (B5) — after the write, since it reads `setup_state`;
6. `wrote` is the return value. `show_onboarding_window` just calls `open_onboarding_window(&app)`. Leave `register_onboarding_close_handler` untouched — it still handles the red X. Deps: B1, B5. **Verify: RUST.** Self-review: the activation-policy revert reads `dock_icon` (not a hardcoded `Accessory`); the hide happens even if the config write failed — order the `?` accordingly or hide before returning the error.

**B5 · Tray: "Finish setup…" + hotkey label from config** — `apps/widget/src-tauri/src/tray.rs`. Refactor: extract `fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>>` from the body of `setup` and add `pub fn refresh_menu(app: &tauri::AppHandle)` that rebuilds it and calls `app.tray_by_id("main-tray")` → `tray.set_menu(Some(menu))`. In `build_menu`: (a) the show item's label becomes `format!("Show Verbatim  ({})", hotkey_glyph(&crate::config::read_config(app).hotkey))` instead of the hardcoded `"Show Verbatim  (⌥Space)"` (`:12`) — add a small private `hotkey_glyph` mirroring `settings.ts`'s `describeHotkey` (preset map + `Alt|Control|Shift|Meta` → `⌥⌃⇧⌘` + `Key*`/`Digit*` stripping); (b) insert a `"finishSetup"` item labelled `"Finish setup…"` **only when** `crate::config::read_config(app).setup_state != "done"`, positioned above `"settings"`; (c) its handler calls `crate::window::open_onboarding_window(app)`. Deps: B1. **Verify: RUST.** Self-review: `tray_by_id` id string matches `TrayIconBuilder::with_id("main-tray")` (`:18`); the `on_menu_event` match gains a `"finishSetup"` arm; `build_menu`'s return type matches what `TrayIconBuilder::menu()` accepts; the tooltip string is left alone (it is not a menu item).

**B6 · Wire it into `main.rs`** — `apps/widget/src-tauri/src/main.rs`. (1) `mod testkey;` and `mod verify;` alongside the other `mod` lines (`:30-45`, alphabetical). (2) Register the five new commands in `invoke_handler!` (`:121-172`) — insert them **before** the trailing `#[cfg(target_os = "macos")] wake::wake_mic_status` entry (`:170-171`), because that cfg'd last element has no trailing comma and appending after it is the easiest way to break the macro: `verify::key_verify, testkey::test_key_available, testkey::use_test_key, window::finish_onboarding, window::show_onboarding_window,`. (3) Replace the `setup()` onboarding gate (`:114-118`) with the `setup_state`-aware version from §3. (4) Call `testkey::watermark_title(app.handle())` in `setup()` after the close handlers. (5) Update the module map in the file's header doc comment (`:8-24`) with one line each for `verify.rs` and `testkey.rs` — that comment is load-bearing documentation in this repo. Deps: B1, B2, B3, B4, B5. **Verify: RUST.** Self-review: exactly 5 new handler entries, each `module::function`; no duplicate names against the existing 47; commas correct around the cfg'd entry; `mod` declarations are unconditional (both new modules are cross-platform — `ureq` and `option_env!` are).

**B7 · Window size + capabilities** — `apps/widget/src-tauri/tauri.conf.json`, `apps/widget/src-tauri/capabilities/default.json`. (1) Change the `onboarding` window's `"height": 480` to `"height": 566` (design-doc §3: Connect is the tallest screen at 566). **Decision: the window is a fixed 566 for all three screens rather than growing 480→566 at runtime** — the window is `"resizable": false`, so a JS `setSize` is a per-macOS-version gamble that buys nothing but a nicer first frame; a fixed height removes the failure mode entirely. (2) In `capabilities/default.json`, add `"core:event:allow-emit"` and `"core:event:allow-listen"` to `permissions`. They are almost certainly already implied by `"core:default"`, but the JS→JS seam in §2.3 is the first place this app emits from a webview, and an explicit grant costs nothing and pre-empts a Mac-only debugging session. `"onboarding"` is already in `windows`. If the Tauri build rejects either identifier as unknown or duplicated, drop them again — `"core:default"` already implies both, and this is belt-and-braces (§8 R14). Deps: none. **Verify:** `python3 -c "import json;json.load(open('apps/widget/src-tauri/tauri.conf.json'))"` and the same for `capabilities/default.json` (both must parse) + MAC.

**B8 · Release absence gate** — *new* `scripts/assert-no-test-key.sh`. A POSIX shell script taking the path to a built `.app` and failing loudly if the test key's distinguishing prefix appears in the binary: `strings "$APP/Contents/MacOS/verbatim-widget" | grep -q "$VERBATIM_PYAI_TEST_KEY_PREFIX" && { echo "FAIL: test key present in a public artifact"; exit 1; }`. Take the prefix from `$VERBATIM_PYAI_TEST_KEY_PREFIX` (an env var supplied at release time) and **exit 2 with a clear message if that var is unset** — never silently pass. Include a header comment stating that `.github/workflows/ci.yml` has **no macOS runner today** (it is `ubuntu-latest` throughout), so this script is a **release-checklist step**, not a CI job, until a macOS build job exists. Deps: none. **Verify: SH** (`bash -n scripts/assert-no-test-key.sh`) + MAC.

### DEV-C — Settings, the overlay, and docs

**C1 · TS config mirror** — `apps/widget/src/settings.ts`. Add `setupState?: string;` to the `AppConfig` type (after `historyLimit?`, `:56`). Deps: none. **Verify: TS.**

**C2 · `capabilityErrors()` — the two side-fixes** — `apps/widget/src/settings.ts:155-169`. Replace the two `hasKey[...]` checks with role-aware, registry-aware logic:
```ts
// Mirrors packages/core's registries. Kept in sync manually, like VENDOR_ENV above.
const STT_REGISTERED = new Set(["pyai", "deepgram", "openai"]);       // providers/registry.ts
const CORR_REGISTERED = new Set(["openai", "anthropic"]);             // correction/registry.ts
function roleErrors(role: "STT" | "Correction", id: string, registered: Set<string>): string[] {
  if (!registered.has(id)) return [`${role} '${id}' isn't a provider Verbatim can use — pick another.`];
  const env = VENDOR_ENV[id];
  if (!env) return [];                       // zero-key provider (design-doc §0.12) — satisfied
  return hasKey[id] ? [] : [`${role} '${id}' needs ${env}.`];
}
```
called for `config.sttProvider` / `config.correctionProvider`. This fixes both defects at once: today a `correctionProvider: "pyai"` reports **zero** errors (the PyAI key *is* saved) while being unresolvable, and a future zero-key id would report `needs undefined`. Leave the PyAI-English-only rule (`:165-169`) exactly as it is. Deps: none. **Verify: TS.**

**C3 · Emit dictation progress** — `apps/widget/src/main.ts`. Add `emit` to the existing `@tauri-apps/api/event` import (`:29`). In `handle()` (`:600-645`), emit the three `dictation-progress` payloads of §2.3: in the `"live"` branch (`:602`), the `"correction"` branch (`:603`), and the `"formatted"` branch (`:608`, payload `{ phase: "final", text: m.text }`). Each call is fire-and-forget with `.catch(() => {})` and must sit **after** the existing behaviour in the branch, so a failed emit can never affect the overlay. Deps: none. **Verify: TS** + `grep -c "dictation-progress" apps/widget/src/main.ts` ≥ 3 (three emits; a comment may add more).

**C4 · The friendly not-set-up banner** — `apps/widget/index.html` + `apps/widget/src/main.ts`.
- `index.html`: add `<button id="finishSetup" class="banner-btn">Finish setup</button>` inside `#bannerActions` (`:24-29`), `hidden` like its siblings.
- `main.ts`: add `"setup"` to the `BannerActions` union (`:332`) and set `finishSetupBtn.hidden = actions !== "setup"` in `showBanner` (`:333-348`); wire `finishSetupBtn.onclick = () => void invoke("show_onboarding_window").catch(() => {})`.
- In `handle()`'s `"error"` branch (`:627-635`): when the message matches `/needs:? [A-Z_]*API_KEY|Unknown (STT|correction) provider|is invalid — using/i` — which covers all three shapes the backend actually sends: `Provider 'pyai' needs: PYAI_API_KEY…` (`providers/registry.ts::assertKeys`), `Unknown correction provider 'x'` (`correction/registry.ts`), and `Correction 'x' is invalid — using openai` (`server.ts:307-312`) **and** `cfg.setupState !== "done"`, call `showBanner("warn", "Verbatim isn't set up yet. Add an API key and it'll start transcribing.", "setup")` instead of `showBanner("err", friendlyError(m.message), …)`, and skip the `copyErr`/`bannerLog` reveal. Read `setupState` from the config the overlay already fetches (`applyPrefs`, `:58` / `connect`, `:653`) — cache it in a module-level `let cfgSetupState = ""` updated in the `config-changed` listener.
- Show it **at most once per launch**: a module-level `let nudgedThisLaunch = false`.
Deps: C1, contract §2. **Verify: TS** + MAC.

**C5 · Settings can no longer hide a broken provider id** — `apps/widget/settings.html` + `apps/widget/src/settings.ts`. In `initProviderControls` (`:301-303`), after assigning `.value`, detect `selectedIndex === -1` on either provider select and, if so, insert a `disabled` `<option>` labelled `` `${id} (unavailable)` `` and select it, so the field is never mysteriously blank (design-doc §0.5). Do **not** add a `local` option — that is O8. `settings.html` needs no change unless the guard is implemented as markup; prefer the TS guard. Deps: C2. **Verify: TS** + MAC.

**C6 · Docs** — `README.md`, `docs/product/STATUS.md`, `docs/product/onboarding-plan.md`. (1) `README.md`: rewrite Quick start / Configuration around first run — the three screens, "paste one key, the vendor is detected", the STT-only vs full distinction, where keys are stored (macOS keychain / 0600 local file), and that skipping is permanent until you use the tray's **Finish setup…**. Onboarding is currently mentioned only inside the repo-layout tree (design-doc defect #11). (2) `STATUS.md`: refresh the handoff snapshot — it predates onboarding and still reads M4/M5-in-progress; record what O1-O7 landed and what is Mac-pending. (3) `onboarding-plan.md`: mark O1-O7 done, leave O8 open with its §9 #5 blocker, and link to this file. Deps: every other task complete. **Verify: TS** (unaffected, but run it) + a link check by eye: every relative path in the new prose resolves.

---

## 7. Microcopy — every user-visible string, one voice

Taken from the prototype. Three agents must not invent three voices; if a string is not here, take it verbatim from the prototype rather than writing a new one.

### Screen 1 — Connect

| Slot | String |
|---|---|
| Window title | `Welcome to Verbatim` |
| Headline | `Welcome to Verbatim` |
| Sub, no key yet | `Paste one API key. That's the whole setup.` |
| Sub, key detected | *the `headline` from `combo(...)` — see §4.3* |
| Preview text | `send it by ` + struck `8 pm no no make it ` + `9 pm tomorrow` |
| Preview caption | `Live preview — no key, no mic. This is what Verbatim does to your words.` |
| Key field placeholder | `Paste your API key` |
| Chip, empty | `We detect the vendor for you` |
| Chip, typing, undetected | `Keep typing…` |
| Chip, detected | `Detected: <Vendor> ▾` |
| Role note — OpenAI | `covers speech + cleanup` |
| Role note — PyAI/Deepgram | `speech-to-text only` |
| Role note — Anthropic | `cleanup only` |
| Verifying | `Checking with <Vendor>…` |
| Rejected | `<Vendor> rejected this key. Check it and paste again.` |
| Unreachable | `Couldn't reach <Vendor> — saved anyway` |
| Save failed | `Couldn't save that key — check it and try again.` |
| Second slot, collapsed | `+ Add a cleanup key for self-correction — optional` |
| Second slot label, optional | `Cleanup key` · `optional · OpenAI or Anthropic` |
| Second slot label, required | `Speech-to-text key` · `required · PyAI, Deepgram or OpenAI` |
| Second slot placeholder | `Paste a <first name in okList> key` |
| Second slot, wrong role | `<Vendor> can't do <cleanup\|speech-to-text>. Use <okList>.` |
| Second slot, satisfied | `<Vendor> — <cleanup\|speech> covered` |
| Test key button | `Use the Saaslabs test key` / `PyAI speech-to-text · shared quota · adds no cleanup key` / pill `internal` |
| Helper link | `› I don't have a key yet` |
| Trust line | `Stored in your macOS keychain. Sent only to the vendor you picked — never to us.` |
| Skip link | `Set up later` |
| Primary button | `Continue` |

### Screen 1 — "Where to get a key" view

| Slot | String |
|---|---|
| Headline / sub | `Where to get a key` / `Verbatim is bring-your-own-key. Any one of these works.` |
| OpenAI row | `Speech-to-text + cleanup` · tag `1 key = all` · `platform.openai.com` |
| PyAI row | `Speech-to-text (Verbatim default)` · `pyai.com` |
| Deepgram row | `Speech-to-text, 30+ languages` · `console.deepgram.com` |
| Anthropic row | `Cleanup only — needs a speech key` · `console.anthropic.com` |
| Link label | `Get a key ↗` |
| Trust line | `Keys stay in your macOS keychain and go only to the vendor you picked.` |
| Buttons | `‹ Back` · `I have one now` |

### Screen 2 — Permissions

| Slot | String |
|---|---|
| Headline / sub | `Two macOS permissions` / `Verbatim asks for exactly these two, and nothing else.` |
| Mic row | `Microphone` / `So Verbatim can hear you. macOS will ask once.` / button `Allow` |
| AX row | `Accessibility` / `Lets Verbatim type into whatever app you're in. Without it, your text is copied to the clipboard instead.` / button `Open Settings` |
| Status chips | `Granted` · `Not granted` |
| AX poll note | `Watching for the toggle — this page updates itself when you flip it.` |
| Amber strip (`raw`) | `Self-correction is off.` + ` Your key covers speech-to-text only — dictation works now, and you can add an OpenAI or Anthropic key any time in Settings.` |
| Buttons | `Back` · `Continue` / `Continue anyway` |

### Screen 3 — Try it

| Slot | String |
|---|---|
| Headline, before | `Give it one try` |
| Sub, before | `Hold <hotkey> and say anything. It lands in the box below.` |
| Headline, after | `That's it — you're set.` |
| Sub, after | `Verbatim lives in your menu bar from here.` |
| Box labels | `Your turn` · `Listening` · `Cleaning up` · `Inserted` |
| Idle line | `Hold the hotkey and speak…` |
| Pills | `Hold <hotkey> to dictate` · `Listening…` · `Correcting…` |
| Done line | `Typed into the field, corrections and all.` |
| Tips | `<hotkey> anywhere — hold to talk, tap to toggle` · `The menu-bar icon has your history and settings` |
| Buttons | `Skip the test` · `Done` |

### Outside the window

| Slot | String |
|---|---|
| Tray item | `Finish setup…` |
| Tray show item | `Show Verbatim  (<hotkey glyph>)` |
| Overlay nudge | `Verbatim isn't set up yet. Add an API key and it'll start transcribing.` + button `Finish setup` |
| Internal watermark | window title `Welcome to Verbatim (internal build)` |

`<hotkey>` is always `describeHotkey(config.hotkey)` — never a literal `⌥Space` in any of the three agents' code.

---

## 8. Risk register

| # | Risk | Guard |
|---|---|---|
| **R1** | **The activation-policy leak survives.** Both onboarding exits currently call `getCurrentWindow().hide()`, which never fires `CloseRequested`, so the app stays `ActivationPolicy::Regular` (Dock icon, can become frontmost) for the rest of the session despite `dock_icon: false` (design-doc §0.6). | A10's acceptance check greps `getCurrentWindow` out of `onboarding.ts` (must be 0). B4 reverts via `desired_activation_policy(cfg.dock_icon)` — **not** a hardcoded `Accessory`, or a user who *wants* the Dock icon loses it. Mac-verify M4. |
| **R2** | **`set_config` silently ignores a bad patch key.** It shallow-merges the patch into the serialized config and re-deserializes; an unknown or snake_case key is dropped on the way back out through `write_config`, so a typo is a silent no-op, not an error. | Every patch key in §4.3 is camelCase. A6 reads the returned `AppConfig` from `set_config` and (Mac-verify) the values are confirmed in `settings.json`. Never send `stt_provider`. |
| **R3** | **Two `set_key` calls = two sidecar restarts.** `keys::set_key` calls `restart_backend` unconditionally (`keys.rs:77`). Firing both in parallel (`Promise.all`) races two spawns for port 8787. | A6 awaits them **serially**, STT first. Both happen on Screen 1, so the restarts overlap with the user granting permissions on Screen 2 rather than with a dictation attempt. If Screen 3 finds the backend not up yet, `main.ts`'s `connect()` already retries 6× at 250 ms. |
| **R4** | **Regressing the existing overlay.** `main.ts` is the most load-bearing file in the app. | C3's emits are appended **after** existing branch behaviour and are `.catch(()=>{})`. C4 adds a *new* member to the `BannerActions` union and one more `hidden` assignment — the existing `"mic"`/`"ax"`/`"none"` paths must be re-read to confirm all four buttons are still explicitly set on every call. Mac-verify M8. |
| **R5** | **Regressing Settings.** `settings.ts:155`'s `capabilityErrors` feeds a visible list; over-reporting is as bad as under-reporting. | C2 keeps the PyAI-English rule untouched and preserves the exact existing message text for the "needs \<ENV\>" case, so nothing that passes today starts failing. Mac-verify M9 covers all four vendors. |
| **R6** | **A blocking HTTP call on the main thread freezes the app.** In Tauri v2 a plain `#[tauri::command] fn` runs on the **main thread**; a 2s `ureq` call there hangs the whole UI, including the overlay. No command in this codebase is async today, so there is no precedent to copy. | B2 uses `#[tauri::command(async)]` on a sync fn (Tauri runs the body off-thread). **Fallback if that attribute is rejected at compile time on the Mac:** make it `pub async fn` and wrap the body in `tauri::async_runtime::spawn_blocking(move \|\| probe(&vendor, &secret)).await.map_err(\|e\| e.to_string())?`. This is the single highest-risk Rust line in the plan and it is Mac-verify M1. |
| **R7** | **Screen 3 can't inject into our own window.** Whether AX injection lands in the onboarding window's own field while Verbatim is frontmost is unproven (design-doc §9 #3), and it is unverifiable in this pipeline. | The design doc's *fallback* is promoted to the *primary* implementation: the `.trybox` renders from the `dictation-progress` event (§2.3), so the hotkey lesson and the end-to-end self-test both land regardless. If injection turns out to work on the Mac, it is a free bonus, not a dependency. |
| **R8** | **`setup_state` breaks an existing `settings.json`.** `set_config` deserializes the whole merged object into `AppConfig`; a field without a `Default` entry makes every existing config fail to parse. | B1 adds the field to the struct **and** `Default` in the same edit (§3). The container `#[serde(rename_all = "camelCase", default)]` (`config.rs:17`) then fills it for old files. Mac-verify M2 opens Settings against a pre-existing `settings.json`. |
| **R9** | **The tray menu can't be rebuilt.** "Finish setup…" must disappear once setup is done, but the menu is built once in `tray::setup`. | B5 extracts `build_menu` + `refresh_menu` using `app.tray_by_id("main-tray")` → `set_menu`, called from `finish_onboarding`. If `set_menu` proves unavailable in the pinned Tauri version, the acceptable degradation is: the item is decided at launch only, and disappears on the next relaunch. Mac-verify M6. |
| **R10** | **The test key leaks into a public build.** Anyone holding the internal `.app` can recover the key with `strings`. | `option_env!` ⇒ absent by construction in a secret-less build (B3). B8's script is the release-checklist assertion. The key must be a dedicated, quota-capped, rotatable one — and per `STATUS.md`'s open security item, **the key pasted during early development must be rotated before any of this ships**. |
| **R11** | **A pasted key ends up in the DOM, a log, or an error string.** | A4 keeps the `<input>` nodes alive and never interpolates a value into HTML (this also fixes the prototype's quote-breaking `value="${shownKey}"`); masking is `input.type`, not a bullet substitution. B2 never formats the secret into an error. No `console.log` of a key anywhere. |
| **R12** | **Screen 2's AX poll leaks a timer.** A 1 Hz `setInterval` that outlives the screen keeps invoking `ax_trusted` forever in a hidden window. | A8 clears the interval on leaving Screen 2 **and** on `beforeunload`. The window is hidden, never destroyed, so a leaked timer really would run for the app's lifetime. |
| **R13** | **The window is too short for Screen 1.** Two key slots plus the trust line plus the footer exceed 480 px. | B7 fixes the window at 566 px, and A3/A4 keep `.pane` `overflow: hidden` with the footer pinned by `margin-top: auto` (prototype `.foot`, line 214) so nothing can push the buttons off-screen. Mac-verify M3 checks the worst case (Anthropic first + required slot + error line). |

| **R14** | **An explicit capability identifier is rejected.** `"core:event:allow-emit"` / `"core:event:allow-listen"` may be reported as unknown or as a duplicate of what `"core:default"` already grants, failing the build. | They are additive belt-and-braces only. If the Mac build complains, remove them (B7) — the seam in §2.3 still works through `"core:default"`. Mac-verify M1. |

---

## 9. Deferred to the user's Mac

Nothing below can run in this pipeline. Exact commands, in the order the user should run them.

```bash
cd ~/Claude/shuuuu/verbatim
npm run typecheck --workspaces --if-present        # sanity, should already be green
cd apps/widget/src-tauri && cargo build            # THE compile gate — impossible in the cloud
cd ../../.. && npm run widget                      # dev run: tauri dev + backend sidecar
```

| # | Mac-verify item | How |
|---|---|---|
| **M1** | `cargo build` succeeds. Highest-risk lines: `#[tauri::command(async)]` in `verify.rs` (R6), `ureq::AgentBuilder`/`Error::Status` shapes, `tray_by_id`/`set_menu` (R9), `MenuItem` ownership in the refactored `build_menu`. | `cargo build`; on failure apply the R6/R9 fallbacks. |
| **M2** | An existing `settings.json` still parses and gains `setupState: "unseen"`. | Launch with a pre-existing config; open Settings; `cat "$HOME/Library/Application Support/co.saaslabs.verbatim.widget/settings.json"`. |
| **M3** | Fresh-profile flow (design-doc exit criteria 1-5): `clear_config` + delete keys ⇒ onboarding opens; a wrong OpenAI key is rejected **in the window**; a good key advances; mic prompts in-window; the AX row flips **without** a manual re-check; Done leaves `setupState: "done"` and a resolvable provider pair. Check Screen 1 at 566 px with the required-slot error showing (R13). | Manual click-through. |
| **M4** | **No Dock icon appears or persists** across the whole flow, with `dockIcon: false`; and with `dockIcon: true` the icon is *kept* after Done. | Watch the Dock during and after onboarding. |
| **M5** | Design-doc exit criteria 6-8: PyAI-only ⇒ finishes, dictates raw, amber strip, **no error banner** on first dictation. PyAI + Anthropic via the optional slot ⇒ `stt=pyai · correction=anthropic`, `correct`/`format` on, a real correction diff. Anthropic first ⇒ Continue disabled until a speech key lands; a Deepgram key in the *cleanup* slot is refused by role; the same key in the *speech* slot is accepted. | Manual, three passes. |
| **M6** | Criterion 9: **Set up later** ⇒ relaunch shows **no** onboarding; the tray shows **Finish setup…**; it opens the window; after Done the item is gone (R9's degradation is acceptable). | Relaunch twice. |
| **M7** | Criterion 10: internal build (`VERBATIM_PYAI_TEST_KEY=… cargo build`) shows the button and one click behaves like M5's PyAI case; the title reads `(internal build)`. A secret-less build shows **no** button, and `bash scripts/assert-no-test-key.sh <app>` passes on it and **fails** on a deliberately poisoned build. | Two builds. |
| **M8** | The overlay is unchanged: dictation, correction reveal, injection, mic/AX banners, Show Last Result, command mode, history all behave as before; the new `dictation-progress` emits cost nothing visible. | Regression pass. |
| **M9** | Settings is unchanged except the intended fix: all four vendor rows, both provider selects, capability errors correct for every combination — **including** a config poisoned with `correctionProvider: "pyai"`, which must now report an error and show `pyai (unavailable)` rather than a blank field. | Regression pass. |
| **M10** | Screen 3 with a real hotkey hold: live transcript, strike-through reveal, final text, all in the `.trybox`. Note separately whether injection *also* landed in the field (closes design-doc §9 #3). | One hold. |
| **M11** | `key_verify` against a live 401 per vendor, and with Wi-Fi off (must show "saved anyway", never "rejected"). | Four keys + one airplane-mode run. |
| **M12** | Open items the Mac can close: design-doc §9 #1 (PyAI key prefix + cheapest authenticated GET) and #2 (does `AXIsProcessTrusted()` flip live, or is a relaunch required — if relaunch, Screen 2 needs a **Relaunch Verbatim** button instead of the self-flipping row). Record findings in `docs/research/pyai-api-findings.md`. | Probes. |
| **M13** | **Rotate the PyAI key** pasted during early development before shipping anything from O6 (open security item in `STATUS.md`). | Vendor console. |

---

## 10. Definition of done for this pipeline

1. All 24 tasks in §6 complete, each with its stated acceptance check green.
2. `npm run typecheck --workspace @verbatim/widget` is green on the final tree.
3. `node --experimental-strip-types /tmp/resolver-check.mts` prints `resolver OK` (exit 0), covering every row of §4.3/§4.4 and all five invariants of §4.5.
4. Every `.rs` file touched parses under `rustfmt --check` in the cloud container, and each Rust task has a completed written self-review.
5. `bash -n scripts/assert-no-test-key.sh` is clean; both JSON files parse.
6. `packages/core` unit tests pass in the cloud container on a fresh Linux install (regression only — no task in this plan touches `packages/core`).
7. Static conflict audit: for each of the 20 owned files, exactly one agent's diff touches it. `apps/widget/src/onboarding.ts` contains no `getCurrentWindow`; `main.rs`'s handler list has exactly 5 new entries and no duplicates; no `"local"` string appears in `onboarding-resolve.ts`.
8. Every command DEV-A's TS invokes appears in §2 **and** in `main.rs`'s `invoke_handler!`.
9. §9's Mac-verify list is handed to the user as the pipeline's output, unmodified — no item on it is claimed as verified here.

---

## Plan review (self)

Re-read adversarially on 18 Aug 2026 with one question: *if a dev agent followed this literally, where would it get stuck, produce a conflict, or write something unverifiable?* What was checked, and what changed as a result.

### Checked and confirmed sound

- **Exclusive ownership.** All 20 files in §5 were cross-referenced against every task in §6. No file appears under two agents. The three highest-risk shared surfaces were traced specifically: `main.rs`'s `invoke_handler!` (DEV-B only), `main.ts` (DEV-C only — DEV-A reaches it exclusively through the frozen event contract in §2.3), and `settings.ts` (DEV-C only — DEV-A **copies** `describeHotkey` rather than importing, per §5.1, because both files are page entries with top-level DOM side effects). `vite.config.ts` and `Cargo.toml` are explicitly on the do-not-touch list; nothing in the plan needs either (`ureq` is already a dependency, and the `onboarding` rollup input already exists).
- **Command closure.** The 12 commands DEV-A's TS invokes were listed and matched one-by-one against §2 and against `main.rs:121-172`. Seven are pre-existing and reused unchanged; five are new and all five are registered in B6. All five new names were checked against the 47 existing handler entries — no collision. `show_onboarding_window` was **added** during this pass: C4's overlay banner needs a JS-invokable way back into onboarding, and the tray path (a direct Rust call) does not cover it. Without it that task would have dead-ended.
- **Gate validity.** Every acceptance check in §6 resolves to the table in §1: `typecheck`, the `/tmp` resolver run, `rustfmt`+self-review, `bash -n`, `python3 -c json.load`, or `grep`. No task claims `cargo build`, `vitest`, `npm run widget`, or any macOS runtime as a gate; all of those are in §9 attributed to the user.
- **No forbidden device commands.** No task instructs `git`, `rm`, `cargo`, `clippy`, or a watching process on the device VM. The only `cargo`/`strings` invocations in the document are inside §9 (Mac) and B8's script body (which runs on the Mac). A3 and A2 say "replace the file's contents", never delete.
- **`setup_state` cannot break an existing `settings.json`.** B1 adds the field to the struct **and** the `Default` impl in one edit; the container `#[serde(rename_all = "camelCase", default)]` at `config.rs:17` then fills it for older files. Traced all three migration cases (existing install with a key / without a key / fresh) in §3 — none can regress, and none can nag.
- **Resolver invariants.** Walked all 25 `(first, second)` pairs. Every emitted `sttProvider` is in `STT_PROVIDERS` and every emitted `correctionProvider` is in the correction `PROVIDERS`; `correct`/`format` are on only alongside a correction id; `needStt` writes nothing. Confirmed the **`local` branch is absent entirely** rather than present-but-gated — a gated branch is a live hazard, since `local` is registered in neither core registry and a later agent could wire the flag on.

### Found and fixed in this pass

1. **The resolver truth-table gate was broken as written.** It used a static `import` from a hardcoded `/root/mnt/...` path; the device VM's `$HOME` is actually `/sessions/<id>` and is not predictable. A static specifier can't be computed. Replaced with a dynamic `await import(process.env.HOME + …)`, verified working under `node --experimental-strip-types` (v22.22.3). Without this fix DEV-A's only executable gate would have failed on the first run for a reason unrelated to the code.
2. **A stale second key could jam Continue with no visible cause.** If a user types a cleanup key and *then* changes the first key to an OpenAI one, `secondSlot(...).need` becomes `"none"` while `state.v2` is still set. `slotError` as originally specified would have kept returning an error for an invisible field, permanently disabling Continue. §4.4 now states explicitly that `second` is ignored — and `slotError` returns `null` — whenever `need === "none"` or `first === null`.
3. **A6 didn't say which secret goes with which vendor.** It referred to a vague `sttOrFirstVendor` and `<that key>`. Since the resolver may *swap* the roles (Anthropic first ⇒ the second key becomes STT), a dev agent could easily have saved each key under the wrong vendor id. Now specified as an explicit `secretOf` map keyed by vendor, with a guard against saving the same vendor twice.
4. **`finish_onboarding`'s ordering was hand-waved** ("order the `?` accordingly"). Rewritten as six numbered steps that hide the window and revert the activation policy **before** the config write, so a write failure can never leave the user staring at a stuck window with a Dock icon — the exact defect (design-doc §0.6) this command exists to fix.
5. **A9 declared a hard dependency on C3**, which would have idled DEV-A behind DEV-C for no reason. Downgraded to a runtime-only dependency, since the event name and payload are frozen in §2.3.
6. **The `correction` event payload was typed `ops: unknown[]`**, forcing DEV-A to invent a cast to render the strike-through spans. Replaced with the real `Op` shape from `main.ts:60`.
7. **C4's error-matching regex missed a case.** It covered the missing-key assert but not `server.ts:307-312`'s `Correction 'x' is invalid — using openai`, which is *precisely* the message today's broken PyAI config produces — the single most likely error a skipper sees. All three real message shapes are now in the pattern, each cited to its source.
8. **A3's CSS check used `\s`**, which plain `grep` BRE does not support; replaced with `[[:space:]]`. A2 contained a garbled half-sentence about the persistent inputs; rewritten as a positive instruction. `apps/widget/settings.html` was misspelled `appsly/…` in the ownership table — a typo that would have sent DEV-C hunting for a nonexistent path.
9. **Screen 2's `Back` button** appeared in the microcopy table but in no task; added to A8, together with the requirement to clear the AX poll interval on the way out (R12).
10. **The red-X exit path** was undocumented, inviting an agent to "fix" it by writing `setup_state` from the close handler. §3 now records it as deliberate, with the reasoning.
11. **R14 added:** the two explicit `core:event:*` capability identifiers B7 adds may be rejected as unknown or duplicate. They are additive only, so the guard is "remove them if the Mac build complains" — stated so a compile failure there is diagnosed in seconds rather than debugged.

### Known-unverifiable, accepted, and labelled as such

- Every Rust line. `cargo build` is impossible in this pipeline; **R6** (blocking `ureq` on the main thread ⇒ `#[tauri::command(async)]`, with a `spawn_blocking` fallback) and **R9** (`tray_by_id` → `set_menu`, with a "decided at launch only" degradation) are the two most likely compile failures, each carrying a pre-written fallback so the Mac session is a two-minute fix rather than a redesign.
- Screen 3's injection question (design-doc §9 #3). Resolved by *design* rather than by verification: the in-window `.trybox` renders from the event stream, so the screen works whether or not AX injection reaches our own field (**R7**). The design doc's stated fallback is promoted to the primary implementation.
- PyAI's key prefix and verification probe (design-doc §9 #1). `key_verify("pyai", …)` deliberately returns `{ok: true, reachable: false}` — the "saved anyway" path — so the unresolved probe blocks nothing and misleads no one. Recorded as **M12**.

### One open question that could slow a dev agent (does not block a start)

Design-doc §9 #2 — whether `AXIsProcessTrusted()` flips live for a running process or needs a relaunch — decides whether Screen 2's self-flipping AX row is achievable at all. It cannot be answered anywhere but the Mac (**M12**). A8 is written for the self-flipping design because that is what the design doc specifies; if the Mac says a relaunch is required, the delta is one button ("Relaunch Verbatim") plus one line of copy in the same file A8 already owns. No other task is affected, so this is safe to discover late.
