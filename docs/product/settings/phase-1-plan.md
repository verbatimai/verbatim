# Settings — Phase 1 (Wave 1) Implementation Plan

**Scope:** Wave 1 of `docs/product/settings-plan.md` §2, items **1.1–1.6**.
**Owner:** Mayank Banga · Saaslabs · **Drafted:** 13 Aug 2026
**Status:** planning only — no code written by this pass.

This plan is grounded in the live repo at `/home/claude/verbatim`. Line numbers below
are as-read on this date; treat symbol names as authoritative and re-locate by symbol if
lines have drifted.

---

## 0. Ground truth learned from the code (read this first)

The task brief and the parent settings-plan describe intent; a few implementation
realities from the actual source change how these items must be built:

1. **The overlay/orb is `index.html` + `src/main.ts`, NOT `app.ts`.**
   `tauri.conf.json` defines two windows:
   - `main` → no `url` → loads root `index.html` → `src/main.ts` (the floating orb + streaming card). This is the overlay.
   - `settings` → `url: "app.html"` → `src/app.ts` (the History/app shell that deep-links into `settings.html` + `src/settings.ts`).
   So for **1.5 (theme everywhere)** the theme must be applied in **three** webviews: `settings.ts` (already), `app.ts` (app shell, localStorage-only today), and `main.ts` (overlay/orb — currently has **no** theme code at all). The brief's "app.ts = overlay" is slightly off; see Open Questions.

2. **`AppConfig` already carries a container-level `#[serde(default)]`.**
   `main.rs:95` is `#[serde(rename_all = "camelCase", default)]`. Container `default` already fills *any* missing field from the `Default` impl on deserialize, so old `settings.json` files load fine **provided the `Default` impl (`main.rs:107-120`) is updated for every new field**. Per-field `#[serde(default)]` is therefore redundant here but harmless; the real hard requirement is: **add the field to the `Default` impl**. (Recommendation: keep the container default and just update `Default`; optionally add explicit `#[serde(default)]` per field as belt-and-suspenders in case someone later removes the container attr.)

3. **`set_config` (`main.rs:151-170`) shallow-merges camelCase patch keys** over the serialized current config and re-deserializes the whole object. Because `read_config` returns a fully-populated struct, the merged object always has every field, so the merge never fails on new fields. New patch keys sent from TS must be **camelCase**: `launchAtLogin`, `debug`, `theme`, `muteOthers`, `keyStorage`.

4. **The backend/sidecar gets its keys from `keychain_read` via `inject_keys` (`main.rs:311-324`), called by `spawn_backend` (`main.rs:326-363`).** For **1.6** this is the critical, easy-to-miss integration point: if key storage moves off the Keychain, `inject_keys`/`keychain_read` **must also read from the new local store**, or dictation silently breaks (backend starts with no keys). All five key commands touch the Keychain today: `key_save` (200), `key_get` (207), `key_has` (216), `key_delete` (223), `key_save_clipboard` (238), plus the per-vendor `set_key` (272), `has_key` (283), `delete_key` (294). A single storage adapter must back all of them **and** `keychain_read`.

5. **The `config-changed` listener in `settings.ts` (`settings.ts:411-417`) only refreshes a subset** (`initProviderControls`, `initDockIcon`, `refreshHotkeyUI`, `renderCapabilityErrors`). Any new control (mute-others, launch-at-login, debug, theme) must be added to this handler, or a `clear_config`/external write won't update it in the open window. This is a shared requirement across 1.1/1.3/1.4/1.5.

6. **Wave 1 touches no `packages/core` logic.** All six items are Rust + widget-TS/HTML. Therefore the only "cloud-runnable" verification is **typecheck** (`npm run typecheck --workspace @verbatim/widget` = `tsc --noEmit`) and static review; every behavioural check is on-Mac.

---

## Config schema — all Wave 1 deltas in one place

Add to the Rust `AppConfig` struct (`main.rs:96-105`) **and** its `Default` impl (`main.rs:107-120`), then mirror in the TS `AppConfig` type (`settings.ts:9-18`).

| Field (Rust snake / TS camel)      | Type   | Default   | Item | Notes |
|------------------------------------|--------|-----------|------|-------|
| `mute_others` / `muteOthers`       | bool   | `true`    | 1.1  | **Already exists** in Rust (`main.rs:104`, Default `:117`). TS type has it as optional `muteOthers?`. Only the HTML element is missing. |
| `launch_at_login` / `launchAtLogin`| bool   | `false`   | 1.2  | New. Side-effect syncs the autostart plugin. |
| `debug` / `debug`                  | bool   | `false`   | 1.4  | New. Side-effect: restart backend with `HEAR_DEBUG` env. |
| `theme` / `theme`                  | String | `"system"`| 1.5  | New. Values `"system"|"light"|"dark"`. |
| `key_storage` / `keyStorage`       | String | `"local"` | 1.6  | New, **hidden** (no UI). Selects the secret backend (`"local"`|`"keychain"`). |

Every new field must appear in the `Default` impl (hard requirement per §0.2). `set_config`
needs **no** structural change.

---

## 1.1 Fix mute-others (missing `#muteOthers` element → TypeError on Settings open)

**Goal:** Add the missing toggle so opening Settings stops throwing and the existing Rust mute-others behaviour is user-controllable.

**Root cause:** `settings.ts:47` does `const muteOthersEl = $<HTMLInputElement>("muteOthers")`, and `$` (`settings.ts:37`) is `document.getElementById(id) as T` — returns `null` when absent. `settings.ts:430` then runs `muteOthersEl.checked = !!config?.muteOthers` unconditionally inside `DOMContentLoaded` → **`TypeError: Cannot set properties of null`** on every Settings open. The Rust field, command surface, and overlay behaviour already exist (`get_output_muted`/`set_output_muted` `main.rs:432-464`; overlay `muteOthersForSession`/`restoreOthersAudio` `main.ts:410-427`).

**Files & exact edits:**
- `apps/widget/settings.html` — add a toggle row inside the **Preferences** card (`<section data-pane="preferences">`, card at `settings.html:165-221`). Insert a `set-row` with an `<input type="checkbox" id="muteOthers">` (mirror the "Show app in dock" row markup at `:201-209`, which uses `id="dockIcon"`). Suggested copy: `Mute other audio while dictating` / `Silence system output while you dictate, then restore it.`
- `apps/widget/src/settings.ts` — no new wiring needed; the handler at `:429-433` already sets `.checked` and invokes `set_config` with `{ muteOthers }` on change. **But** add `muteOthers` to the `config-changed` listener (`:411-417`) so a reset/external write updates the toggle: `muteOthersEl.checked = !!config.muteOthers;`.
- (Optional hardening, recommended) Make the `DOMContentLoaded` mute-others wiring null-safe (`if (muteOthersEl) { ... }`) so a future missing element degrades instead of throwing.

**Config schema delta:** none (field already present). TS type already has `muteOthers?: boolean` — leave as-is or make non-optional.

**Test checklist**
Cloud-runnable (TS/typecheck):
- [ ] `npm run typecheck --workspace @verbatim/widget` passes.
- [ ] Grep confirms `id="muteOthers"` exists exactly once in `settings.html`.
On-Mac (`npm run widget`):
- [ ] Open Settings → **no** console `TypeError`; the toggle reflects `config.mute_others` (default ON).
- [ ] Toggle off, reopen Settings → stays off (persisted).
- [ ] Play music, start dictation with toggle ON → system output mutes; on stop → restores to prior level. With toggle OFF → music keeps playing.

**Risks / notes:** Low risk. This is the single item that currently breaks the whole Settings window, so it gates verifying every other item — do it first.

---

## 1.2 Launch at login (add `tauri-plugin-autostart`)

**Goal:** A working "Launch at login" toggle backed by a real macOS login item, persisted in config.

**Files & exact edits:**
- `apps/widget/src-tauri/Cargo.toml` — add under `[dependencies]` (near `tauri-plugin-store` `:21`): `tauri-plugin-autostart = "2"`.
- `apps/widget/src-tauri/src/main.rs`:
  - Register the plugin in `main()` alongside the store plugin (`:709-710`):
    `builder = builder.plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![])));`
  - Add `launch_at_login: bool` to `AppConfig` (`:96-105`) and `Default` (`:107-120`, `= false`).
  - Add a helper `fn apply_autostart(app: &tauri::AppHandle, enabled: bool)` that uses `tauri_plugin_autostart::ManagerExt` → `let m = app.autolaunch(); if enabled { let _ = m.enable(); } else { let _ = m.disable(); }`.
  - In `set_config` (`:151-170`), after computing `next` and before `emit`, add a side-effect mirroring the existing `apply_hotkey` block (`:163-166`): compare `old` vs `next` and call `apply_autostart(&app, next.launch_at_login)` when it changed. To get `old`, capture it before the merge: `let old = read_config(&app);` at the top of `set_config` (currently it only reads into a `Value`; add a typed read or reuse). Guarding on change avoids redundant enable/disable churn.
  - On startup, reconcile OS state with config once in `setup` (after `migrate_legacy_config`, near `:748`): `apply_autostart(app.handle(), read_config(app.handle()).launch_at_login);` — so the login item matches config even if the user changed it in System Settings.
- `apps/widget/settings.html` — the row already exists at `:180-188` ("Launch at login" with a **disabled** checkbox and a "Not in use" tag). Give the `<input>` `id="launchAtLogin"`, remove `disabled`, remove the `<span class="tag off">Not in use</span>`, and drop `class="switch disabled"` → `class="switch"`.
- `apps/widget/src/settings.ts`:
  - Add ref: `const launchAtLoginEl = $<HTMLInputElement>("launchAtLogin");`
  - Init + wire (new `initLaunchAtLogin()` called from `DOMContentLoaded`, mirroring `initDockIcon` `:402-407`): set `.checked = !!config.launchAtLogin`; on change `await patchConfig({ launchAtLogin: launchAtLoginEl.checked })`.
  - Add to the `config-changed` listener (`:411-417`): `launchAtLoginEl.checked = !!config.launchAtLogin;` (or call `initLaunchAtLogin()`).
  - Add `launchAtLogin?: boolean` to the `AppConfig` TS type (`:9-18`).

**Config schema delta:** `launch_at_login`/`launchAtLogin`, bool, default `false`. Add to Rust `Default` and TS type.

**Capabilities note:** because autostart is driven from **Rust** (side-effect in `set_config` + startup reconcile), the frontend never `invoke`s the autostart plugin, so **no** entry is needed in `capabilities/default.json`. If a future revision calls it from JS, add `autostart:allow-enable`, `autostart:allow-disable`, `autostart:allow-is-enabled`.

**Test checklist**
Cloud-runnable:
- [ ] `npm run typecheck --workspace @verbatim/widget` passes (TS type + ref).
- [ ] Cargo edit review only — cannot `cargo build` in cloud.
On-Mac:
- [ ] `cargo build` / `npm run widget` compiles with the new dep + plugin.
- [ ] Toggle ON → System Settings → General → Login Items shows Verbatim.
- [ ] Log out / log in (or reboot) → app launches automatically.
- [ ] Toggle OFF → login item removed; survives restart as OFF.
- [ ] Change several other settings (no launch_at_login change) → backend/login item not needlessly churned (verify the change-guard).

**Risks / notes:** In **dev**, the LaunchAgent points at the dev binary path, so the login-item entry may look odd or not relaunch a usable app — verify primarily against a built app. `MacosLauncher::LaunchAgent` is the standard choice for a menu-bar `Accessory` app.

---

## 1.3 Reset settings (`clear_config`; keep secrets)

**Goal:** A working "Reset" button that restores all config to defaults, keeps API keys, and live-updates the open Settings window.

**Files & exact edits:**
- `apps/widget/src-tauri/src/main.rs`:
  - New command:
    ```rust
    #[tauri::command]
    fn clear_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
        let def = AppConfig::default();
        write_config(&app, &def)?;            // uses existing write_config :137
        #[cfg(desktop)] { let _ = apply_hotkey(&app, &def.hotkey); } // re-register default ⌥Space
        apply_autostart(&app, def.launch_at_login); // 1.2 helper — disable login item on reset
        // debug default is false → if backend was in debug, restart it clean (1.4)
        let _ = app.emit("config-changed", &def);
        Ok(def)
    }
    ```
    Deliberately does **not** touch secrets (Keychain/local `secrets.json`) — matches the current HTML copy "Keychain keys are kept" (to be reworded per 1.6). Register `clear_config` in the `generate_handler!` list (`:898-920`).
- `apps/widget/settings.html` — the Reset row is at `:562-573` (in the `card danger`, Advanced pane) with a **disabled** button and "Not in use" tag. Give the button `id="resetBtn"`, remove `disabled`, remove the tag. Update the description text to reflect 1.6 ("API keys are kept").
- `apps/widget/src/settings.ts`:
  - Add ref `const resetBtnEl = $<HTMLButtonElement>("resetBtn");` and wire with a confirm step: `resetBtnEl.onclick = async () => { if (!confirm("Reset all settings to defaults? Your API keys are kept.")) return; config = await invoke<AppConfig>("clear_config"); /* refresh UI */ };`. After reset, refresh the form — simplest is to call the same init functions the `config-changed` listener calls **plus** the new controls (mute-others, launch-at-login, debug, theme). Since `clear_config` also emits `config-changed`, wiring those into the listener (per §0.5) means the button handler can rely on it; still re-read `config` from the return for immediacy.

**Config schema delta:** none.

**Test checklist**
Cloud-runnable:
- [ ] `npm run typecheck --workspace @verbatim/widget` passes.
On-Mac:
- [ ] Change hotkey, dock icon, mute-others, theme, launch-at-login, providers → click Reset → confirm → all revert to defaults live (no reopen needed) via `config-changed`.
- [ ] Saved API keys remain present (vendor rows still show "Saved").
- [ ] Default hotkey ⌥Space is actually re-registered (press it, dictation starts).
- [ ] Login item is removed on reset (matches `launch_at_login=false`).

**Risks / notes:** `window.confirm` works in the focusable Settings NSWindow (unlike the non-key overlay). If a nicer modal is wanted later, out of scope for Wave 1. Ensure the `config-changed` handler is expanded (§0.5) or the open form won't fully refresh after reset.

---

## 1.4 Debug mode (persist `debug`; mirror `HEAR_DEBUG`)

**Goal:** A persisted Debug toggle that turns on the backend's verbose `HEAR_DEBUG` logging without needing the env var.

**⚠ REVIEWER CORRECTION (blocking): the sidecar does NOT read `HEAR_DEBUG` today.** The process Rust actually spawns is `apps/backend/src/server.ts` (`npm run start --workspace @verbatim/backend`, `main.rs:335` / the release sidecar). That file has **no** `HEAR_DEBUG` gate — its logging is unconditional `console.log`/`console.error` plus a PyAI error file (`server.ts:19,42,218-221`). The **only** `HEAR_DEBUG` consumer in the repo is the legacy `scripts/dev.mjs` raw-Hear streamer (`DEBUG = process.env.HEAR_DEBUG !== "0"`), which the widget never spawns. So injecting `HEAR_DEBUG=1` into the sidecar env produces **zero** change in output — the acceptance test "verbose `[hear]`-style logs appear" cannot pass as written.
Do ONE of:
- **(A, recommended) Add a debug gate to the sidecar.** In `apps/backend/src/server.ts`, add `const DEBUG = process.env.HEAR_DEBUG === "1";` and put the extra verbose lines behind it (e.g. gate the per-session `console.log`s, or add new ones). Then Rust injects `HEAR_DEBUG=1` when `config.debug` and the gate lights up. This makes the on-Mac test real.
- **(B) Narrow the scope.** Persist `debug` + inject the env now, but change the acceptance criterion to "the sidecar receives `HEAR_DEBUG=1` in its env when the toggle is on" and explicitly defer the verbose-logging behaviour with a TODO in `server.ts`. Do **not** claim verbose logs work until the gate exists.

**How debug is injected:** Rust injects backend env in `inject_keys` (`main.rs:317-324`) during `spawn_backend` (`:326-363`). Mirroring = inject `HEAR_DEBUG` when `config.debug` is on, and restart the backend when the toggle flips (same mechanism `set_key` already uses via `restart_backend` `:371`).

**Files & exact edits:**
- `apps/widget/src-tauri/src/main.rs`:
  - Add `debug: bool` to `AppConfig` (`:96-105`) + `Default` (`:107-120`, `= false`).
  - Thread debug into backend env. Cleanest: change `inject_keys` (`:317`) to take the app handle — `fn inject_keys(app: &tauri::AppHandle, cmd: &mut std::process::Command)` — and inside add `if read_config(app).debug { cmd.env("HEAR_DEBUG", "1"); }`. Update both call sites in `spawn_backend` (`:337` dev, `:351` release) to pass `app`. (`spawn_backend` already has `app: &tauri::AppHandle`.)
  - In `set_config` (`:151-170`), add a change-guarded side-effect: `if next.debug != old.debug { restart_backend(&app); }` (reusing the `old = read_config(&app)` captured for 1.2). This makes the backend pick up / drop `HEAR_DEBUG` live.
- `apps/widget/settings.html` — Debug row is at `:541-549` (Advanced pane) with a **disabled** checkbox + "Not in use" tag. Add `id="debugMode"`, remove `disabled`, remove tag, `switch disabled`→`switch`.
- `apps/widget/src/settings.ts`:
  - Ref `const debugEl = $<HTMLInputElement>("debugMode");`; init `.checked = !!config.debug`; on change `await patchConfig({ debug: debugEl.checked })`.
  - Add to `config-changed` listener; add `debug?: boolean` to TS `AppConfig`.

**Config schema delta:** `debug`/`debug`, bool, default `false`.

**Test checklist**
Cloud-runnable:
- [ ] `npm run typecheck --workspace @verbatim/widget` passes.
On-Mac:
- [ ] Toggle Debug ON → backend restarts and subsequent logs show the verbose `[hear]`-style output without any env var set.
- [ ] Toggle OFF → backend restarts quiet; verbose logs stop.
- [ ] Restart app with Debug ON → backend spawns already verbose (startup `spawn_backend` reads `config.debug`).
- [ ] Changing an unrelated setting does **not** restart the backend (change-guard holds).
- [ ] **Secrets never logged:** with Debug ON, grep the log output for any API key value → none present.

**Risks / notes:** Restarting the backend briefly drops the loopback socket; fine between dictations, avoid toggling mid-session. Confirm the backend actually honors `HEAR_DEBUG` at the value we set (`"1"`); if it expects a specific truthy convention, match it (see Open Questions). **Do not** read `.env`.

---

## 1.5 Appearance — persist theme to config + apply to overlay/orb

**Goal:** Theme selection persists to config and themes **all** webviews (settings window, app shell, overlay/orb), not just the settings window's localStorage.

**Today:** `settings.ts:initTheme` (`:379-399`) and `app.ts:9-24` both drive `document.body.dataset.theme` from `localStorage["verbatim.theme"]` only. `main.ts` (overlay/orb) has **no** theme code, and `index.html`'s `<body>` has no `data-theme`. There is no `theme` field in config.

**Files & exact edits:**
- `apps/widget/src-tauri/src/main.rs` — add `theme: String` to `AppConfig` (`:96-105`) + `Default` (`= "system".into()`). No side-effect needed; `set_config` already emits `config-changed` which the webviews listen to.
- `apps/widget/src/settings.ts` — in `initTheme` (`:379-399`), when the user picks a theme (`apply(t)` and the `seg`/`themeToggle` click handlers `:394-398`), also persist to config: `void patchConfig({ theme: t })`. Keep `localStorage` as a synchronous fast-path so the window doesn't flash on open. Initialize `current` from `config.theme` (fallback to localStorage/"system"). Also update the segmented control's active state from `config.theme` on load and in the `config-changed` listener. Remove the "Not in use" tag on the Appearance row (`settings.html:168`).
- `apps/widget/src/app.ts` — replace the localStorage-only init with: on load, `invoke("get_config")` → `applyTheme(cfg.theme ?? localStorage ?? "system")`; keep the localStorage fast-path first to avoid flash; add `listen<AppConfig>("config-changed", e => applyTheme(e.payload.theme))`. Import `invoke`/`listen` from `@tauri-apps/api`.
- `apps/widget/src/main.ts` (overlay/orb) — **new** small theme block: on startup `const cfg = await invoke("get_config").catch(()=>({}))` → set `document.body.dataset.theme = cfg.theme ?? "system"`; add `listen<any>("config-changed", e => { document.body.dataset.theme = e.payload.theme ?? "system"; })`. `main.ts` already imports `invoke` (`:12`) and `listen` (`:13`).
- **⚠ REVIEWER CORRECTION (required sub-task, not optional):** `apps/widget/src/style.css` (the overlay stylesheet) currently has **ZERO** `data-theme` rules and **no** `prefers-color-scheme` — just a single `:root{}` palette (`style.css:3`). Flipping `document.body.dataset.theme` will therefore change the attribute but **not** the appearance. You MUST add `[data-theme="dark"]{…}` (and, if the base palette isn't already the light one, `[data-theme="light"]{…}`) token overrides to `style.css`, plus a `[data-theme="system"]` path that respects `@media (prefers-color-scheme: dark)`. Mirror the token structure already in `settings.css` (which has 4 `data-theme` rules). The on-Mac "overlay goes dark" test depends on this CSS, not just the JS.
- `apps/widget/settings.html` — remove the `<span class="tag off">Not in use</span>` from the Appearance heading (`:168`) and update the description ("Applies to the widget and settings.").

**Config schema delta:** `theme`/`theme`, String, default `"system"`. Add to Rust `Default` + TS `AppConfig` type.

**Test checklist**
Cloud-runnable:
- [ ] `npm run typecheck --workspace @verbatim/widget` passes (new invoke/listen in `app.ts`/`main.ts`, `theme` in TS type).
- [ ] Static check: `main.ts` and `app.ts` both attach a `config-changed` listener that sets `data-theme`.
On-Mac:
- [ ] Pick **Dark** in Settings → settings window, app shell, and the overlay/orb all go dark immediately (via `config-changed`).
- [ ] Restart app → overlay + settings both open in Dark (persisted in config, not just localStorage).
- [ ] Pick **System** → all three follow the OS appearance.
- [ ] Reset (1.3) returns theme to System everywhere.

**Risks / notes:** Keep the localStorage fast-path to avoid a flash-of-wrong-theme before `get_config` resolves. The orb stylesheet (`style.css`) may not yet define dark/light tokens — verify it themes visually, not just that the attribute flips. Two writers (localStorage + config) must not fight; config is the source of truth, localStorage is a cache.

---

## 1.6 Remove the macOS Keychain → local key storage (adapter + hidden flag)

**Goal:** Replace Keychain-backed secret storage with a file-backed `secrets.json` (gitignored, `0600`, in the app config dir, separate from `settings.json`), behind an adapter so the Keychain stays reachable via a hidden `key_storage` flag (default `local`). Command surface unchanged; honest UI copy. Entering/deleting a key must never prompt for the login password.

**Design — one storage adapter behind the existing command names.** Introduce a small module (e.g. `apps/widget/src-tauri/src/secrets.rs`) exposing four functions keyed by **account name** (the env-var string like `"PYAI_API_KEY"`, matching the current Keychain `account`):
```
fn secret_set(app: &AppHandle, account: &str, secret: &str) -> Result<(), String>
fn secret_get(app: &AppHandle, account: &str) -> Option<String>
fn secret_has(app: &AppHandle, account: &str) -> bool
fn secret_delete(app: &AppHandle, account: &str) -> Result<(), String>
```
Each dispatches on `read_config(app).key_storage`:
- `"local"` (default): read/modify/write a JSON map in `secrets.json`.
- `"keychain"`: the existing `keyring::Entry` calls (kept in-tree, macOS-cfg'd).

**`secrets.json` mechanics (local backend):**
- Path: `app.path().app_config_dir()?.join("secrets.json")` (same dir as `settings.json`; **outside** the repo — macOS `~/Library/Application Support/co.saaslabs.verbatim.widget/`). Do **not** use `tauri-plugin-store` for it (keeps it plainly separate from `settings.json` and easy to wipe).
- Shape: `{ "PYAI_API_KEY": "...", ... }` — a `serde_json::Map<String,String>` (or `HashMap`). Read = parse file (missing file → empty map). Write = serialize, `create_dir_all` the parent, write, then set perms.
- **Permissions `0600`:** after write, on unix set mode: `use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))`. Create the file with restrictive perms from the start where possible.
- **Never logged:** no `println!`/`eprintln!` of key values anywhere in the adapter; return `()`/`bool`/`Option` as the commands already do, never echo the secret.

**Rewire every key touchpoint to the adapter (`main.rs`):**
- Per-vendor commands (keep JS-facing signatures identical — Tauri injects `app`, so `invoke("has_key",{vendor})` etc. are unchanged even after adding an `app` param):
  - `set_key` (`:272`) → `secret_set(&app, acct, &secret)` then `restart_backend(&app)`.
  - `has_key` (`:283`) → needs `app`: change to `fn has_key(app: tauri::AppHandle, vendor: String) -> bool` → `secret_has(&app, acct)`. **JS call unchanged** (`invoke("has_key",{vendor})`).
  - `delete_key` (`:294`) → needs `app`: `fn delete_key(app: tauri::AppHandle, vendor: String)` → `secret_delete(&app, acct)`.
- Generic commands `key_save` (`:200`), `key_get` (`:207`), `key_has` (`:216`), `key_delete` (`:223`), `key_save_clipboard` (`:238`) → route through the adapter too (add `app` param where missing). These are still registered in `generate_handler!` (`:912-916`); leaving them on the raw Keychain would re-introduce prompts, so convert them. (`key_save_clipboard` also calls `restart_backend` — keep that.)
- **Backend key injection — the critical one:** `keychain_read` (`:311`) is used by `inject_keys` (`:317-324`). Replace its body with the adapter read: `secret_get(app, account)`. This requires `inject_keys` to have `app` (also needed for 1.4) — pass it through from `spawn_backend`. Without this, the sidecar starts with **no** keys under local storage and dictation fails.
- `KEYCHAIN_SERVICE` (`:198`) stays, used only by the `keychain` backend.

**Hidden flag / feature:** add `key_storage: String` to `AppConfig` (default `"local"`) with **no UI** — not surfaced in `settings.html`/`settings.ts`. Selecting `"keychain"` is done by hand-editing `settings.json` (or a future Advanced pane). Keep `keyring` in `Cargo.toml` (`:18`) as-is so the keychain backend still compiles. (Alternative the brief allows: a Cargo `keychain` feature instead of a runtime field — but a runtime `key_storage` field is simpler to flip for testing the release path and matches settings-plan §1.6.1's "config field with no UI"; recommend the field.)

**Honest UI copy:** `settings.html` — the Providers pane header (`:363-366`, "Keys stay in your Keychain.") and the API Keys section-note (`:412-417`, "Stored in the macOS Keychain — never written to disk in plaintext.") must change to e.g. **"Stored locally on this device."** Also reword the Reset row copy (`:565-569`, "Keychain keys are kept") → "Your API keys are kept."

**.gitignore:** add `secrets.json` defensively (root `/home/claude/verbatim/.gitignore`, under the "Secrets & keys" block `:1-9`). Note: the file lives outside the repo in `app_config_dir`, so this is belt-and-suspenders; harmless and matches the plan.

**Docs to reconcile (durable):** `product-plan.md` §14 threat model ("OS-keychain storage") and any Keychain mention in architecture docs must state the current local-file model and that Keychain returns as an opt-in. (Update alongside, or immediately after, this item.)

**Deferred (do NOT build now):** the **migrate-and-wipe** rule (move key into new store + securely delete old copy when `key_storage` changes) is only relevant when the backend can change at runtime. Only `local` ships active, so document it as a future requirement of the eventual user-facing toggle — no migration code in Wave 1.

**Config schema delta:** `key_storage`/`keyStorage`, String, default `"local"`. Add to Rust `Default`. **Not** mirrored into the TS `AppConfig` type in a user-facing way (hidden); may add as an optional `keyStorage?: string` for completeness but keep it out of the UI.

**Test checklist**
Cloud-runnable:
- [ ] `npm run typecheck --workspace @verbatim/widget` passes (settings.ts unchanged except copy; no key logic change on TS side).
- [ ] Static review: no `println!`/`eprintln!`/`log` prints a secret in `secrets.rs` or the rewired commands; `.env` is never read.
- [ ] Grep `settings.html` → no remaining "Keychain" strings in user-facing copy.
On-Mac (`cargo build` / `npm run widget`):
- [ ] Build compiles with `secrets.rs` + `key_storage` field; `keyring` still linked (keychain backend intact).
- [ ] Enter an API key in Settings → **zero** login-password prompts; vendor row shows "Saved".
- [ ] Restart app → key persists; dictation works (proves `inject_keys` reads local store).
- [ ] Delete the key via the row's ⋯ menu → removed from `secrets.json` on disk; **zero** prompts.
- [ ] Inspect `secrets.json`: `ls -l` shows `-rw-------` (`0600`); it sits in `app_config_dir`, not the repo.
- [ ] `grep` the key value across logs and `git status`/repo → never appears; file is gitignored.
- [ ] (Backend hand-off) With a key saved and `key_storage=local`, backend env receives it (dictation succeeds); toggling `debug` doesn't leak it.
- [ ] (Optional, flip hidden flag) hand-edit `settings.json` `keyStorage:"keychain"` → keychain backend path still works (prompts as expected, proving it's reachable).

**Risks / notes:**
- **Biggest trap:** forgetting to rewire `keychain_read`/`inject_keys` → backend gets no keys under local storage and dictation silently breaks. Called out explicitly above.
- Security **downgrade**: keys are now plaintext-on-disk. Acceptable for pre-release single-user BYOK on the user's own Mac; the docs must not overstate security. Keep the "rotate the pasted PyAI test key before public release" gate.
- Concurrency: `secret_set`/`secret_delete` do read-modify-write on one file; two rapid writes could race. Single-user, single-process (Rust owns all writes) makes this low-risk, but do the write atomically (write temp + rename) if trivial.
- `key_save_clipboard` still returns a masked `••••{last4}` preview (`:251-254`) — keep the masking, never the full value.

---

## Cross-cutting implementation order (recommended)

1. **1.1** first (unblocks the Settings window — everything else is unverifiable while it throws).
2. Add all five config fields + `Default` entries in one Rust pass (schema table above), plus the `old = read_config` capture and the change-guarded side-effects in `set_config` (1.2 autostart, 1.4 debug restart).
3. **1.6** adapter (self-contained; touches the most Rust) — verify dictation still works end-to-end.
4. **1.2 / 1.3 / 1.4** commands + wiring.
5. **1.5** theme across the three webviews.
6. Expand the `settings.ts` `config-changed` listener once to cover mute-others, launch-at-login, debug, theme (§0.5).

---

## Open questions for reviewer

1. **Overlay theme scope (1.5):** the brief names `app.ts` as "the overlay/orb webview," but in the code the orb is `index.html` + `main.ts`; `app.ts` is the History/app-shell in the `settings` window. I've planned theme changes in **all three** (`settings.ts`, `app.ts`, `main.ts`). Confirm that's the intended surface, and whether the orb's stylesheet (`style.css`) already defines light/dark tokens or needs new ones.
2. **`HEAR_DEBUG` truthiness (1.4):** I plan to inject `HEAR_DEBUG=1` when `debug` is on and omit it when off. The backend reads this env (root `dev:quiet` sets `HEAR_DEBUG=0`). Does the backend treat `"0"` as off and any presence as on, or does it need the var absent to be off? This decides whether to set `"0"` vs. omit. (I plan to **omit** when off.)
3. **`key_storage` mechanism (1.6):** runtime hidden config field vs. Cargo `keychain` feature. I recommend the runtime field (easier to flip for release-path testing, matches settings-plan §1.6.1). Confirm we keep the `keyring` dep compiled in (yes, per plan) rather than feature-gating it out.
4. **Generic `key_*` commands (1.6):** `key_save`/`key_get`/`key_has`/`key_delete`/`key_save_clipboard` are still registered but appear superseded by the per-vendor `set_key`/`has_key`/`delete_key` used by `settings.ts`. I plan to route them all through the adapter for consistency. Confirm none are still needed as raw-Keychain, or whether some can be **removed** from `generate_handler!` to shrink the surface.
5. **`set_config` `old` read (1.2/1.4):** adding a typed `let old = read_config(&app)` at the top of `set_config` means two reads per call (one typed for change-detection, one already-serialized for the merge). Acceptable, or prefer deserializing the merged `Value` once and comparing fields? Minor; flagging for style.
6. **Backend restart on debug toggle (1.4):** acceptable UX to briefly restart the sidecar when Debug flips? It drops the loopback socket momentarily. Assumed fine between dictations.
7. **Autostart in dev (1.2):** the LaunchAgent will point at the dev binary; verification is only meaningful on a built app. Confirm we verify against a bundle, not `tauri dev`.
