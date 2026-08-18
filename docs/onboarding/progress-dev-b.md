# DEV-B progress — the Rust host (tasks B1–B8)

**Owner:** DEV-B · **Plan of record:** `implementation-plan.md` §6 (DEV-B column) · **Design:** `../product/onboarding-plan.md` §4, §6, §7
**Status: all 8 tasks complete.** No Rust in this pipeline can be compiled (no `cargo`/`rustc` on the device VM), so every task below carries a written self-review (§3) and every one of them also appears on the plan's §9 Mac-verify list.

## 1. Task table

| # | Task | Status | What I did |
|---|---|---|---|
| **B1** | `setup_state` in `AppConfig` | done | Added `pub setup_state: String` after `history_limit` in the struct **and** `setup_state: "unseen".into()` after `history_limit: 20` in `impl Default`. No field reordered, no `set_config` side-effect block (the field has no live consequence). |
| **B2** | `verify.rs` (new) | done | `VerifyOutcome { ok, reachable }` + `probe()` + `#[tauri::command(async)] key_verify`. One `ureq` GET per vendor, 2s agent timeout; `pyai` short-circuits to `{ok:true,reachable:false}`; unknown vendor is the only `Err`. |
| **B3** | `testkey.rs` (new) | done | `option_env!("VERBATIM_PYAI_TEST_KEY")`, `test_key_available`, `use_test_key` (secret store → `restart_backend`), `watermark_title`. |
| **B4** | `finish_onboarding` + `show_onboarding_window` | done | Both added to `window.rs` above `register_onboarding_close_handler`, in the plan's exact 6-step order: validate → read cfg + hide → revert activation policy → write `setup_state` → `tray::refresh_menu` → return the write result. |
| **B5** | Tray "Finish setup…" + hotkey label from config | done | Extracted `build_menu(&AppHandle) -> tauri::Result<Menu<Wry>>`, added `refresh_menu`, added private `hotkey_glyph`, added the conditional `"finishSetup"` item above `"settings"` plus its `on_menu_event` arm. Tooltip untouched. |
| **B6** | Wire into `main.rs` | done | `mod testkey;` / `mod verify;` (alphabetical, unconditional); 5 handler entries inserted **before** the cfg'd `wake::wake_mic_status`; the `setup_state`-aware launch gate; `testkey::watermark_title(app.handle())` after the close handlers; two new lines in the header module map. |
| **B7** | Window height + capabilities | done | `onboarding` window `"height": 480` → `566`. Added `"core:event:allow-emit"` / `"core:event:allow-listen"` to `capabilities/default.json`. Both files re-parsed with `python3 -c json.load`. |
| **B8** | Release absence gate | done | New `scripts/assert-no-test-key.sh` (POSIX `sh`, `set -eu`). Exit 0 clean / 1 key present / 2 misuse — including **exit 2 when `VERBATIM_PYAI_TEST_KEY_PREFIX` is unset**, so it can never silently pass. Header states CI has no macOS runner today, so it is a release-checklist step. |

## 2. Gates actually run

| Gate | Result |
|---|---|
| `rustfmt --edition 2021 --check` on `verify.rs`, `testkey.rs`, `tray.rs`, and the `window.rs` insert (reproduced verbatim in the cloud container — the device VM has no rustfmt) | **clean, no diff** — all four parse and are already canonically formatted |
| Brace / paren / bracket balance on all six touched `.rs` files (device, `python3`) | **0 / 0 / 0** on each |
| `invoke_handler!` audit (device, `python3`): entry count, duplicates, presence of the 5 new names | **52 entries** (47 existing + 5 new), **0 duplicates**, all 5 present, comma placement correct around the cfg'd trailing entry |
| `python3 -c json.load` on `tauri.conf.json` + `capabilities/default.json` | both parse |
| `bash -n` and `sh -n` on `scripts/assert-no-test-key.sh` | clean |

`cargo build` / `cargo clippy` did **not** run anywhere — impossible in this pipeline (plan §1).

## 3. Self-review checklist (the substitute for a compiler)

Every type below was read in this repo before use; the citation is where I verified it.

### B1 `config.rs`
- `AppConfig` field is `String`, snake_case; the container `#[serde(rename_all = "camelCase", default)]` (`config.rs:17`) maps it to `setupState` and fills it for an existing `settings.json`. **Both** the struct entry and the `Default` entry are present — verified by `grep -n setup_state config.rs` returning exactly two lines (54, 95). This is the file's own documented failure mode (`config.rs:8-11`, plan R8).

### B2 `verify.rs`
- `ureq::AgentBuilder::new().timeout(Duration).build()` → `ureq::Agent`; `agent.get(&str)` → `ureq::Request`; `Request::set(self, &str, &str) -> Self` (owned, so the `format!` temporary is not borrowed past the statement); `Request::call() -> Result<Response, ureq::Error>`; `ureq::Error::Status(u16, Response)`. `ureq = "2"` at `Cargo.toml:44`; the existing call site `ureq::get(url).call()` is `wake.rs:110`. **Not verified against the crate source** — the exact `AgentBuilder`/`Error::Status` shape is plan risk **R6/M1**.
- Or-pattern `Err(ureq::Error::Status(401 | 403, _))` — edition 2021 (`Cargo.toml:4`).
- Return type `Result<VerifyOutcome, String>` matches the contract; `VerifyOutcome` derives `serde::Serialize` only (serde has `derive`, `Cargo.toml:13`). A command returning `Result<T, String>` with `T: Serialize` is the shape of `keys::key_get` (`keys.rs:20`) and `config::set_config` (`config.rs:128`).
- **Secret handling:** the `secret` reaches exactly three expressions — `format!("Bearer {secret}")`, `format!("Token {secret}")`, `.set("x-api-key", secret)`. There is no `println!`/`eprintln!`/`dbg!` in the file at all, and the `Err(_)` arm **drops** the ureq error instead of formatting it (a ureq error can echo request headers). The only `Err` string is `format!("unknown vendor: {vendor}")` — vendor id, not secret. Nothing is stored.
- `#[tauri::command(async)]` on a sync fn: both args are `String` (`Send`), no `AppHandle`, so nothing non-`Send` crosses the thread boundary.
- No `unwrap()`/`expect()` anywhere in the file.

### B3 `testkey.rs`
- `option_env!` is a compile-time macro returning `Option<&'static str>` — assigned to a `const`, so `std::env::var` cannot creep in.
- `crate::secrets::secret_set(&AppHandle, &str, &str) -> Result<(), String>` — verified at `secrets.rs:75`. `crate::backend::restart_backend(&AppHandle)` returns `()` — verified at `backend.rs:84`.
- `.ok_or("no test key in this build")?` in a `-> Result<(), String>` fn relies on `impl From<&str> for String`; the identical construct is `secrets.rs:49` (`.ok_or("no config dir")?`). Error text matches the contract exactly.
- Account string `"PYAI_API_KEY"` matches `keys.rs:65` (`vendor_key_name`'s `"pyai"` arm) and `backend.rs:15` (`VENDOR_KEYS[0]`), so the sidecar's `inject_keys` picks it up.
- `watermark_title(app: &tauri::AppHandle)` takes a **reference** (called as `app.handle()` from `setup`, matching `backend::spawn_backend(app.handle())`, `main.rs:106`). `WebviewWindow::set_title(&str) -> tauri::Result<()>`, result discarded with `let _ =`, mirroring `win.eval(...)` at `window.rs:109`. `get_webview_window` needs `Manager`, imported function-locally.
- The key never reaches the renderer: `use_test_key` returns `Result<(), String>` and `test_key_available` returns `bool`.

### B4 `window.rs`
- `finish_onboarding(app: tauri::AppHandle, state: String)` — by-value `AppHandle` and `String`, the shape every command in this crate uses (`config.rs:128`, `keys.rs:74`).
- `crate::config::read_config(&app) -> AppConfig` (`config.rs:101`) and `crate::config::write_config(&app, &cfg) -> Result<(), String>` (`config.rs:113`). `write_config` — **not** `set_config` — so there is no JSON merge and no `config-changed` broadcast.
- `desired_activation_policy(bool) -> tauri::ActivationPolicy` is `#[cfg(target_os = "macos")]` and lives in this same module (`window.rs:39`); it is called under a matching `#[cfg(target_os = "macos")]` statement attribute on a `let _ = …` line — the identical construct at `config.rs:245-246` and `window.rs:181-184`. It reads `cfg.dock_icon`, never a hardcoded `Accessory` (plan R1). `AppHandle::set_activation_policy` on an owned handle is proven at `config.rs:199`.
- Ordering: hide + policy revert happen **before** the write; the `?` operator is deliberately **not** used on the write — the result is bound to `wrote` and returned last, so a write failure cannot skip the hide, the policy revert, or the menu refresh.
- `state` is compared before being moved into `cfg.setup_state`; the error arm returns first, so the `format!("bad setup state: {state}")` borrow and the later move do not overlap.
- On non-macOS, `cfg` is still read and mutated, so `let mut cfg` produces no unused-variable/unused-mut warning.
- `show_onboarding_window` is a verbatim copy of `show_settings_window`'s shape (`window.rs:117-120`); the `"no 'onboarding' window"` error string comes from the existing `open_onboarding_window` (`window.rs:166`), matching the contract.
- `register_onboarding_close_handler` untouched (red-X path unchanged, plan §3's deliberate gap).

### B5 `tray.rs`
- `build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>>`. In the old code `h = app.handle()` was already a `&AppHandle` and was passed straight to `MenuItem::with_id` / `Menu::with_items`, so the manager type is unchanged; `R` was already inferred as `Wry` (`tauri::App` = `App<Wry>`), now written explicitly as the plan specifies.
- **Caught without a compiler:** `MenuItem::with_id` shares ONE generic parameter between `text: S` and `accelerator: Option<S>`. Passing a `String` label alongside `None::<&str>` would not unify, so the label is passed as `show_label.as_str()`. Every existing call site (`tray.rs:12-15` as it was) used `&str` + `None::<&str>`, which is what made the constraint visible.
- Conditional item: `finish_i: Option<MenuItem<Wry>>`, then `items: Vec<&dyn IsMenuItem<tauri::Wry>>`. `Menu::with_items` takes `&[&dyn IsMenuItem<R>]`, so `&items` derefs correctly and `items.push(f)` unsize-coerces `&MenuItem<Wry>` at the argument position. `finish_i` is bound in the enclosing scope, so every reference in `items` outlives the `with_items` call.
- `refresh_menu` uses `app.tray_by_id("main-tray")` (needs `Manager`, imported locally) with the id string matching `TrayIconBuilder::with_id("main-tray")` in the same file, then `tray.set_menu(Some(menu))` with the result discarded. **`tray_by_id` + `set_menu` are the least-verified lines in my share** — plan risk **R9 / M1**, with the documented degradation (decide the item at launch only) if `set_menu` is unavailable.
- `let Ok(menu) = build_menu(app) else { return; };` — let-else, already used in this crate (`secrets.rs:38`, `config.rs:260`).
- `refresh_menu` is `#[cfg(desktop)]` with a `#[cfg(not(desktop))] pub fn refresh_menu(_app: &tauri::AppHandle) {}` no-op twin, so `window::finish_onboarding` (not cfg-gated) always has a callee. This dual-cfg pair mirrors `config::apply_autostart` (`config.rs:208-219`) exactly.
- `hotkey_glyph` is a direct port of `settings.ts:432-449` (`describeHotkey`), preset ids cross-checked against `hotkey::preset_shortcut` (`hotkey.rs:35-46`). `str::strip_prefix` and `Vec::pop().unwrap_or("")` only; no indexing, so no panic path. The `⌥Space` string in the **tooltip** is left alone (not a menu item, per the plan).
- `on_menu_event`'s closure signature is unchanged; the new `"finishSetup"` arm calls `crate::window::open_onboarding_window(app)` where `app: &AppHandle` — the same shape as the neighbouring `"settings"` arm.

### B6 `main.rs`
- `mod testkey;` / `mod verify;` unconditional and alphabetical (`system, testkey, text, tray, verify, window`).
- Handler entries are 5, each `module::function`, all inserted **before** the `#[cfg(target_os = "macos")] wake::wake_mic_status` element so the cfg'd no-trailing-comma element stays last. Audited by script: 52 entries, no duplicates.
- `config::read_config(app.handle())` — `app.handle()` is `&AppHandle` inside `setup`, matching `read_config`'s signature and the existing `backend::spawn_backend(app.handle())` call. `cfg` is consumed by the `if`, so no unused warning.
- Gate semantics: `cfg.setup_state == "unseen" && !keys::any_vendor_key_saved(...)`. `any_vendor_key_saved` (`keys.rs:97`) is unchanged.

### B7 JSON
- Only the `onboarding` entry's `height` changed (`440` width untouched, `resizable: false` untouched). Both files re-parsed after editing.

### B8 shell
- POSIX `sh` only (`[ ]`, `command -v`, no bashisms), `set -eu`, and the prefix is never echoed. `bash -n` + `sh -n` clean.

## 4. Deviations from the plan, and why

1. **`show_label.as_str()` in `build_menu`** — the plan's sketch implies `format!(…)` passed directly as the label. `MenuItem::with_id` binds `text` and `accelerator` to the same generic parameter, so a `String` label with `None::<&str>` cannot unify. Passing `&str` keeps the existing call shape. *This is a fix, not a design change.*
2. **`refresh_menu` has a `#[cfg(not(desktop))]` no-op twin.** The plan asks only for the `#[cfg(desktop)]` version, but `window::finish_onboarding` is not cfg-gated and would fail to resolve the call on a non-desktop target. Pattern copied from `config::apply_autostart`.
3. **`hotkey_glyph` and `build_menu`/`refresh_menu` are `#[cfg(desktop)]`,** matching the pre-existing gate on `tray::setup` (the whole file's only public fn was already desktop-only).
4. **`probe()` returns early for `pyai` before building the agent** rather than inside the vendor `match`, so a no-request vendor never constructs an HTTP agent. Same observable behaviour as specified.
5. **A small `unreachable()` helper** builds the `{ok:true, reachable:false}` value used by three arms, so the "network trouble is never a bad key" rule exists in one place. (Name is local to the module and does not shadow `std::unreachable!`, which is a macro.)

## 5. Things I could not verify without `cargo` (all already on the plan's §9 list)

| Risk | Where | Plan ref |
|---|---|---|
| `#[tauri::command(async)]` accepted on a sync fn | `verify.rs:key_verify` | R6 / M1 — fallback: `pub async fn` + `tauri::async_runtime::spawn_blocking` |
| `ureq::AgentBuilder::new().timeout(..).build()` and `ureq::Error::Status(u16, _)` exact shapes | `verify.rs:probe` | M1 / M11 |
| `Manager::tray_by_id("main-tray")` accepting a `&str` id, and `TrayIcon::set_menu(Some(menu))` | `tray.rs:refresh_menu` | R9 / M6 |
| `Vec<&dyn IsMenuItem<Wry>>` + `Menu::with_items(&items)` borrow lifetimes | `tray.rs:build_menu` | M1 |
| `WebviewWindow::set_title` on a hidden window | `testkey.rs:watermark_title` | M7 |
| Whether the two `core:event:*` capability identifiers are accepted | `capabilities/default.json` | R14 — remove them if the build objects |
| Every runtime behaviour: policy revert, tray refresh, config migration, 401 handling offline | all | M2, M3, M4, M6, M7, M11 |

**One ordering caveat for the Mac session:** `ureq` is declared under `[target.'cfg(target_os = "macos")'.dependencies]` (`Cargo.toml:30-44`), **not** the portable `[dependencies]` table, so the unconditional `mod verify;` the plan specifies makes the crate macOS-only in a way it arguably already is (`keyring/apple-native`, `core-graphics`, `ort` and `cpal` sit in the same target table). I followed the plan (unconditional `mod`, no `Cargo.toml` edit — it is on the do-not-touch list). If a non-macOS build is ever wanted, moving `ureq` to `[dependencies]` is the one-line fix; nothing in `verify.rs` needs to change.

## 6. Notes for the other agents / files I did NOT touch

- **Nothing outside DEV-B's column was edited.** `keys.rs` needed no change: `set_key`, `has_key` and `any_vendor_key_saved` keep their exact signatures, and `vendor_key_name`'s `"pyai"` arm is only *read* by `testkey.rs` (as a hardcoded string, with a comment pointing at it).
- **DEV-A:** all five commands are registered and match §2.1 byte-for-byte — `key_verify {vendor, secret}` → `{ok, reachable}`; `finish_onboarding {state}` with `Err("bad setup state: <s>")`; `show_onboarding_window` with `Err("no 'onboarding' window")`; `test_key_available` → `bool`; `use_test_key` with `Err("no test key in this build")`. The onboarding window is a fixed **566 px** tall — no runtime `setSize` is needed or wanted.
- **DEV-C:** the Rust field is `setup_state`, so the TS mirror is `setupState?: string` with values `"unseen" | "skipped" | "done"`. `"unseen"` is what an existing `settings.json` will report after migration. `show_onboarding_window` is live for C4's banner button.
- `Cargo.toml`, `vite.config.ts`, `packages/core/**` and `apps/backend/**` untouched, as required.

---

## Follow-up: `ureq` gating

Raised by the coordinator after the first pass, which flagged that `ureq` sat under
`[target.'cfg(target_os = "macos")'.dependencies]` while `mod verify;` is declared
unconditionally. `apps/widget/src-tauri/Cargo.toml` was lifted off the do-not-touch list for
this one change.

### Decision: option (a) — `ureq` moved into the top-level `[dependencies]`

`Cargo.toml` now declares `ureq = "2"` once, in `[dependencies]`, with the comment amended to
record both consumers (P3's macOS-only `wake.rs::ensure_models` and O2's cross-platform
`verify.rs::probe`) and why it must not go back into the target table. The macOS target table
keeps exactly the five genuinely-platform-bound crates: `tauri-nspanel`, `core-foundation`,
`core-graphics`, `ort`, `cpal`.

**Why (a) and not (b):** option (b) would have to cfg-gate a *command*, and the plan's own §6/B6
identifies the cfg'd trailing element of `invoke_handler!` as the easiest thing in this file to
break; a second cfg'd entry doubles that surface. It would also mean `key_verify` exists on one
target and not another while §2.1 freezes it as an unconditional part of the contract DEV-A codes
against — a mismatch that would surface as a runtime "command not found", not a compile error.
And it would leave the trap in place for the next module that wants an HTTP call. (a) is one line
moved, zero code changed, and it makes the dependency table tell the truth about what is
platform-bound. `ureq` is pure Rust with rustls, so nothing regresses on any target.

**One correction to the framing, for the record:** this was *not* a blocker for `cargo build` on
the user's Mac. On macOS the target table applies, so `ureq` was already available to
`verify.rs`; the defect was latent, and only a non-macOS build would have hit it. That build
cannot succeed today for unrelated pre-existing reasons — `keyring = { features =
["apple-native"] }` sits in the portable `[dependencies]` table (`Cargo.toml:18`), and
`main.rs` unconditionally declares `mod tray;`/`mod window;` whose macOS paths are cfg'd but
whose crates are not. So `verify.rs` was never what made this crate macOS-only, and (a) does not
make it portable — it just stops adding a *new* reason. Making the crate genuinely
cross-platform is a separate piece of work and is not in this pipeline's scope.

`Cargo.lock` is untouched and needs no regeneration: it already pins `ureq 2.12.1` (from the P3
work), and moving a dependency between tables does not change resolution. Useful side-finding —
the lock also contains a `ureq 3.4.0` from some other crate's tree, which confirms our *direct*
dependency resolves to **2.12.1** and therefore that `verify.rs`'s v2 API surface
(`AgentBuilder::timeout`, `Request::set`, `Error::Status`) is the correct one rather than v3's
renamed API.

### Re-audit for the same class of mistake

| Check | Result |
|---|---|
| External crates referenced by `verify.rs` | `ureq` (5 refs) + `serde` (1). `serde` is top-level (`Cargo.toml:13`). **`ureq` was the only target-gated dep in my share** — now fixed. |
| External crates referenced by `testkey.rs` | **none** beyond `tauri` itself; everything else is `crate::secrets` / `crate::backend`. |
| Are `secrets` and `backend` unconditional modules? | Yes — `mod backend;` (`main.rs:32`) and `mod secrets;` (`main.rs:41`) both sit in the unconditional block (32-49), with no `#[cfg]` on the preceding line. Same for `config` (34), `tray` (47), `verify` (48), `window` (49), `testkey` (45). |
| Do `secrets.rs` / `backend.rs` themselves pull anything target-gated? | No. `secrets.rs`'s only external import is `tauri::{AppHandle, Manager}` and its cfg gates are `unix` / `not(unix)` (file permissions), not macOS. `backend.rs` imports nothing outside `std` + `crate`. So `use_test_key`'s whole call chain is portable. |
| macOS-only APIs called from an unconditionally-declared module I wrote | None in `verify.rs` or `testkey.rs` (grep for `set_activation_policy` / `ActivationPolicy` / `nspanel` / `core_graphics` / `axinject`: no hits). `window.rs`'s policy revert and `tray.rs`'s menu code are cfg-gated as before, and `tray::refresh_menu` has the `#[cfg(not(desktop))]` no-op twin. |

### Gates re-run after the edit

**How rustfmt is run** (the device VM has no Rust toolchain at all, and
`device_stage_files` is currently refused with `untrusted_device` — the desktop app's
sign-in on this Mac has gone stale, so nothing can be staged until the user
re-authenticates): each file is read from the device with `cat`, written byte-for-byte into
the **cloud container** (which does have `rustfmt` at `/root/.cargo/bin/rustfmt`), and the copy
is proven identical to the device's with `sha256sum` **on both sides** before rustfmt runs.
Empty stub files stand in for the modules not under review so `rustfmt` can resolve `main.rs`'s
module tree. Hashes verified this pass: `main.rs 59731f71…`, `window.rs 6e681573…`,
`config.rs 8dc71199…`, `verify.rs 7af3220a…`, `testkey.rs a3bd9f0a…`, `tray.rs 380c4978…`,
`Cargo.toml fec23bdd…`.

| Gate | Result |
|---|---|
| `rustfmt --edition 2021 --check` — **parse** | **All six `.rs` files parse.** Every finding is a formatting `Diff in …`, not an `error:`. |
| `rustfmt --check` — **formatting**, per file | `main.rs`, `verify.rs`, `testkey.rs`, `tray.rs`, `window.rs`: **0 diffs.** `config.rs`: **3 diffs.** |
| Are `config.rs`'s 3 diffs mine? | **No — all three are pre-existing.** Proven by reconstructing the pre-edit file (my two lines removed) and re-running: the identical three diffs appear, at lines 23 / 113 / 234, which are exactly lines 23 / 115 / 236 shifted by my +2 lines. They are (1) the struct's hand-aligned trailing comments, which rustfmt wants to collapse to a single space across ~30 fields, (2) `write_config`'s `store.set(…)` one-liner, (3) a comment indent at `clear_config`. All three are in code I did not touch. **I deliberately did not reformat them:** it would rewrite ~30 unrelated lines in a file DEV-C's TS mirrors, for zero behavioural gain. My added field line follows the file's existing local alignment, and rustfmt reformats the whole block either way, so its spelling changes nothing about the gate outcome. |
| `invoke_handler!` audit | **52 entries** (47 pre-existing + 5 new), **0 duplicates**, all 5 new names present, cfg'd `wake::wake_mic_status` still the last element. |
| `tauri.conf.json` + `capabilities/default.json` JSON parse | Both parse. Onboarding window reads `width 440, height 566, resizable false, title "Welcome to Verbatim"`; capability list is 12 permissions. |
| `Cargo.toml` TOML parse (`tomllib`, in the container) | Parses. `ureq` present in `[dependencies]`, **absent** from the macOS target table; `[[bin]]` and `edition = "2021"` intact. |
| `bash -n` / `sh -n` on `scripts/assert-no-test-key.sh` | Clean (unchanged this pass). |

### Still unverifiable without `cargo`

The `Cargo.toml` move itself is now low-risk: it is verified by a real TOML parse, `ureq 2.12.1`
is already in `Cargo.lock`, and no Rust source changed because of it. What remains open is
unchanged from §5 above — the `ureq` 2.x API surface in `verify.rs`, `#[tauri::command(async)]`
(R6), `tray_by_id`/`set_menu` (R9), the `Vec<&dyn IsMenuItem>` borrow, and every runtime
behaviour. Nothing in this follow-up closes or adds to that list.
