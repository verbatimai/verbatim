# Settings — Phase 1 (Wave 1) Implementation Progress

**Owner:** Mayank Banga · Saaslabs · **Implemented:** 13 Aug 2026
**Scope:** items 1.1–1.6 of `phase-1-plan.md` (as corrected by `phase-1-review.md`).
**Env note:** Rust was authored but NOT compiled here (cloud can't `cargo build`). Only
the widget/backend TS typecheck + core test suite were runnable in the cloud.

---

## Summary (per item)

- **1.1 Mute-others toggle.** Added the missing `#muteOthers` checkbox to the Preferences
  card in `settings.html`, so opening Settings no longer null-dereferences. The old
  `DOMContentLoaded` wiring (which threw) was replaced with a null-safe `initMuteOthers()`
  bound via `.onchange`, and mute-others is now refreshed on `config-changed` / Reset.
- **1.2 Launch at login.** Added `tauri-plugin-autostart` (dep + `#[cfg(desktop)]` plugin
  registration). New `launch_at_login` config field + `apply_autostart()` helper. `set_config`
  syncs the macOS login item **only when the toggle flips** (change-guard); startup reconciles
  the OS login item with config. Settings row un-gated (`#launchAtLogin`, `disabled`/tag
  removed) and wired in `settings.ts`.
- **1.3 Reset settings.** New `clear_config` Tauri command: writes `AppConfig::default()`,
  re-registers default ⌥Space, clears the login item, restarts the sidecar only if it was in
  debug, emits `config-changed`, and **deliberately leaves secrets untouched** (API keys
  survive). Reset button un-gated (`#resetBtn`) with a confirm step; the `settings.ts`
  `config-changed` listener now calls a single `refreshControls()` that live-updates mute,
  debug, launch-at-login, dock, theme, hotkey, and provider controls.
- **1.4 Debug mode.** New `debug` config field. **Per the review's blocking correction, a real
  gate was added to the sidecar** (`apps/backend/src/server.ts`): `const DEBUG =
  process.env.HEAR_DEBUG === "1"` with a `dbg()` helper gating verbose `[hear]` lines
  (connection, live, batch, formatted). Rust `inject_keys` now injects `HEAR_DEBUG=1` when
  `config.debug`, and `set_config` restarts the sidecar when the toggle flips. Settings row
  un-gated (`#debugMode`). Secrets are never logged, even in debug.
- **1.5 Appearance / theme everywhere.** New `theme` config field (`"system"|"light"|"dark"`,
  default `"system"`), config is the source of truth (localStorage kept as a no-flash cache).
  Theme now applied in **all three** webviews: `settings.ts` (persists to config + reacts to
  `config-changed`), `app.ts` (app shell — reads `get_config`, follows `config-changed`,
  persists on toggle), and `main.ts` (overlay/orb — new theme block). **Real `data-theme`
  tokens were added to the overlay stylesheet** `style.css` (light + a `prefers-color-scheme`
  system path), tokenising the previously-hardcoded surfaces so the attribute flip is visible.
- **1.6 Keychain → local file storage.** New `secrets.rs` storage adapter behind a hidden
  `key_storage` flag (default `"local"`, no UI). Local backend = `secrets.json` in the app
  config dir, written `0600` via temp+rename, never logged. **All eight key commands AND the
  sidecar `inject_keys` path** now route through the adapter — `keychain_read` is deleted; no
  code path hits the raw Keychain under local storage. `keyring` stays compiled in and the
  keychain backend is reachable via `key_storage:"keychain"`. UI copy changed from Keychain
  wording to "Stored locally on this device." `secrets.json` added to `.gitignore`. Migrate-
  and-wipe is left as an explicit TODO in `secrets.rs` (not built — only `local` ships active).

---

## Files changed

| Path | What |
|------|------|
| `apps/widget/src-tauri/src/main.rs` | 4 new config fields + Default; `mod secrets`; `set_config` old-snapshot + change-guarded autostart/debug side-effects; `apply_autostart`; `clear_config`; `inject_keys(app,…)` + `HEAR_DEBUG`; all key commands routed through the adapter; `keychain_read` removed; autostart plugin registered + startup reconcile; `clear_config` in handler list. |
| `apps/widget/src-tauri/src/secrets.rs` | **New.** Storage adapter (`secret_set/get/has/delete`) dispatching on `key_storage`; local `secrets.json` (0600, atomic write, never logged); keychain backend; migrate-and-wipe TODO. |
| `apps/widget/src-tauri/Cargo.toml` | Added `tauri-plugin-autostart = "2"`; updated store-plugin comment. |
| `apps/backend/src/server.ts` | `HEAR_DEBUG === "1"` gate + `dbg()` helper; verbose lines gated; startup notice. |
| `apps/widget/settings.html` | Added `#muteOthers` row; un-gated launch-at-login/debug/reset rows (ids, removed `disabled`+"Not in use"); Appearance tag removed + copy; Providers/API-keys copy → "Stored locally on this device." |
| `apps/widget/src/settings.ts` | Type fields (`launchAtLogin/debug/theme/keyStorage`); new refs; `initMuteOthers/LaunchAtLogin/Debug/Reset`; config-driven theme (`applyThemeUI/currentTheme/cachedTheme`); `refreshControls()`; expanded `config-changed` listener; rebuilt `DOMContentLoaded`. |
| `apps/widget/src/app.ts` | Imports `invoke`/`listen`; reads `get_config`, follows `config-changed`, persists theme on toggle (inline config type — no cross-file import). |
| `apps/widget/src/main.ts` | New overlay theme block: `applyOverlayTheme()` from `get_config` + `config-changed`. |
| `apps/widget/src/style.css` | Tokenised surfaces; `body[data-theme="light"]` block + `@media (prefers-color-scheme: light) body[data-theme="system"]` path; surfaces switched to vars. |
| `apps/widget/index.html` | `<body data-theme="system">` so the OS-appearance path applies before JS. |
| `.gitignore` | Added `secrets.json`. |
| `docs/product/product-plan.md` | §Key model + §14 threat model reconciled to the local-file model (Keychain = future opt-in; plaintext-on-disk security note). |

---

## Config schema added

Rust `AppConfig` (+ `Default`) and mirrored in the TS `AppConfig` type:

| Rust (snake) / TS (camel) | Type | Default | Item | UI |
|---|---|---|---|---|
| `launch_at_login` / `launchAtLogin` | bool | `false` | 1.2 | yes |
| `debug` / `debug` | bool | `false` | 1.4 | yes |
| `theme` / `theme` | String | `"system"` | 1.5 | yes |
| `key_storage` / `keyStorage` | String | `"local"` | 1.6 | **hidden — no UI** |

(`mute_others`/`muteOthers` already existed in Rust; only the HTML element was missing.)

---

## Test results — Cloud (executed here)

- `npm test` (core): **`Test Files 13 passed (13)` · `Tests 77 passed (77)`** — no regression
  (Phase 1 touched no `packages/core`).
- `apps/widget` typecheck — `npx tsc --noEmit`: **exit 0 (pass)** for all settings.ts /
  app.ts / main.ts changes.
- `apps/backend` typecheck — `npx tsc --noEmit`: **exit 0 (pass)** for the server.ts debug gate.
- Grep: `id="muteOthers"` present once in `settings.html`; **no "Keychain" strings** remain in
  `settings.html`; no `keychain_read` references remain; all `keyring::` usage is confined to
  `secrets.rs`.

Cloud-runnable checkboxes from the plan:
- [x] 1.1 widget typecheck passes; `#muteOthers` exists exactly once.
- [x] 1.2 widget typecheck passes (TS type + ref).
- [x] 1.3 widget typecheck passes.
- [x] 1.4 widget typecheck passes.
- [x] 1.5 widget typecheck passes; `main.ts` + `app.ts` both attach a `config-changed`
      listener that sets `data-theme`.
- [x] 1.6 widget typecheck passes; static review — no secret is `println!`/`eprintln!`/logged
      in `secrets.rs` or the rewired commands; `.env` is never read; no "Keychain" copy left.

> Note: `tsc --noEmit` is the ONLY automated cloud gate for the widget (`npm test` = core
> only). It does NOT exercise the Rust or the runtime wiring — a green typecheck is necessary
> but not sufficient. The Rust below needs a `cargo check`/build on the Mac.

---

## Test checklist — On-Mac (UNCHECKED — for Mayank)

### Build (gates everything)
- [ ] `cd apps/widget/src-tauri && cargo check` (or `npm run widget`) compiles with
      `secrets.rs`, the 4 new fields, `tauri-plugin-autostart`, and `clear_config`.
- [ ] `keyring` still links (keychain backend intact).

### 1.1 Mute-others
- [ ] Open Settings → **no** console `TypeError`; toggle reflects `mute_others` (default ON).
- [ ] Toggle off, reopen → stays off (persisted).
- [ ] Play music, dictate with toggle ON → output mutes then restores; with OFF → keeps playing.

### 1.2 Launch at login
- [ ] Toggle ON → System Settings → General → Login Items shows Verbatim.
- [ ] Log out/in (or reboot) → app launches automatically.
- [ ] Toggle OFF → login item removed; survives restart as OFF.
- [ ] Change unrelated settings → login item not needlessly churned (change-guard holds).
- [ ] Verify against a **built app**, not `tauri dev` (LaunchAgent points at the dev binary).

### 1.3 Reset
- [ ] Change hotkey, dock, mute-others, theme, launch-at-login, debug, providers → Reset →
      confirm → all revert to defaults **live** (no reopen) via `config-changed`.
- [ ] Saved API keys remain (vendor rows still show "Saved").
- [ ] Default ⌥Space re-registered (press it → dictation starts).
- [ ] Login item removed on reset.

### 1.4 Debug mode
- [ ] Toggle Debug ON → backend restarts and subsequent logs show verbose `[hear]` output
      with **no** env var set.
- [ ] Toggle OFF → backend restarts quiet; verbose logs stop.
- [ ] Restart app with Debug ON → sidecar spawns already verbose (startup reads `config.debug`).
- [ ] Changing an unrelated setting does **not** restart the backend.
- [ ] With Debug ON, grep logs for any API-key value → none present.

### 1.5 Appearance / theme
- [ ] Pick **Dark** → settings window, app shell, AND overlay/orb all go dark immediately.
- [ ] Restart app → overlay + settings open in Dark (persisted in config, not just localStorage).
- [ ] Pick **System** → all three follow the OS appearance (toggle OS light/dark to confirm).
- [ ] Reset returns theme to System everywhere.

### 1.6 Local key storage
- [ ] Enter an API key in Settings → **zero** login-password prompts; row shows "Saved".
- [ ] Restart app → key persists; dictation works (proves `inject_keys` reads the local store).
- [ ] Delete the key via ⋯ menu → removed from `secrets.json`; **zero** prompts.
- [ ] `ls -l` on `secrets.json` → `-rw-------` (0600), in `app_config_dir`, **not** the repo.
- [ ] Grep the key value across logs + `git status`/repo → never appears; file is gitignored.
- [ ] (Optional) hand-edit `settings.json` `keyStorage:"keychain"` → keychain path still works
      (prompts as expected), proving the backend is reachable.

---

## Deviations from the plan

- **1.4 chose option A (recommended):** added a real `HEAR_DEBUG` gate to the sidecar rather
  than narrowing the acceptance criterion, so the on-Mac "verbose logs appear" test is real.
- **1.6 generic `key_*` commands were routed through the adapter (not removed)** — the safe
  Wave-1 default per review answer #4; none were dropped from `generate_handler!`.
- **`style.css` was refactored to tokenise surfaces** (card/final/inputs/buttons/scrollbar)
  rather than duplicating full rule blocks per theme, so the light + system paths only
  re-declare CSS variables. This touches a few existing dark-mode rules (now var-backed);
  values are unchanged for dark, so the dark look should be identical — worth an eyeball on Mac.
- **`index.html` body gained `data-theme="system"`** (not explicitly in the plan) so the OS
  appearance applies before `main.ts` runs, avoiding a dark flash on a light-mode Mac.

## Parked / needs Mayank's input

- **Rust compile is unverified** (cloud limitation). Run `cargo check` on the Mac; the most
  likely failure points are the `tauri-plugin-autostart` v2 API (`MacosLauncher::LaunchAgent`,
  `ManagerExt::autolaunch()`) and the `#[cfg(desktop)]` gating around `apply_autostart`.
- **Overlay light theme is a first pass** — the orb itself stays accent-blue in both themes
  (intentional); confirm the light card/final/inputs read well on device and tweak tokens if a
  surface looks off.
- **`key_storage` remains hidden with no migrate-and-wipe** (deferred per plan). When a
  user-facing storage toggle is added later, implement the migrate-and-wipe TODO in
  `secrets.rs` before shipping the toggle.
- **Rotate the pasted PyAI test key** before public release (unchanged pre-existing gate).
