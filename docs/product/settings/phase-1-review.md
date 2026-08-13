# Settings — Phase 1 (Wave 1) Plan Review

**Reviewer pass:** cross-check of `phase-1-plan.md` against the live repo at `/home/claude/verbatim`, before any dev implementation.
**Date:** 13 Aug 2026 · **Scope reviewed:** items 1.1–1.6 (settings-plan §0/§1/§2, Wave 1).

---

## Verdict: **APPROVED WITH REQUIRED CHANGES**

The plan is well-grounded — the vast majority of its line numbers, symbol names, and structural claims match the code exactly, and it correctly identifies the two highest-risk traps (the 1.6 `keychain_read`/`inject_keys` path, and the container-level `serde(default)`). Two claims are **wrong against the current code** and must be fixed before/at implementation (1.4 HEAR_DEBUG; 1.5 overlay CSS). Neither is fatal to the approach; both are now corrected inline in the plan. A handful of off-by-one line numbers were fixed. The dev is cleared to start **provided** the bullets under "Go/no-go" are followed.

---

## What I verified as CORRECT (no change needed)

- **1.1 mute-others bug is REAL exactly as described.** `settings.ts:47` `const muteOthersEl = $<HTMLInputElement>("muteOthers")` where `$` (`:37`) is `getElementById(...) as T` → returns `null` when the element is absent. `settings.ts:430` then does `muteOthersEl.checked = !!config?.muteOthers` unconditionally inside `DOMContentLoaded` → `TypeError: Cannot set properties of null` on every Settings open. `#muteOthers` does not exist in `settings.html`. The Rust side is complete: field `mute_others` (`main.rs:104`, Default `:117`), commands `get_output_muted`/`set_output_muted` (`:432-464`), overlay `muteOthersForSession`/`restoreOthersAudio` (`main.ts:412-427`, gated on `cfg?.muteOthers`).
- **Config schema / §0.2 — CONFIRMED.** `AppConfig` carries a **container-level** `#[serde(rename_all = "camelCase", default)]` at `main.rs:95`. Container `default` fills any missing field from the `Default` impl on deserialize, so old `settings.json` files load fine **as long as the `Default` impl (`:107-120`) gains every new field**. The planner's conclusion (update `Default`; per-field `#[serde(default)]` is redundant-but-harmless) is correct — and is *more* accurate than settings-plan §0's guardrail, which wrongly implies a new field alone breaks parsing. **Dev should follow phase-1-plan §0.2, not settings-plan §0 on this point.**
- **§0.3 `set_config` shallow-merge — CONFIRMED.** `set_config` (`main.rs:151-170`) serializes `read_config` (a fully-populated struct) to a `Value`, inserts camelCase patch keys, and re-deserializes the whole object into `AppConfig`. Because the base is always fully populated, the merge never fails on new fields. New patch keys from TS must be camelCase — correct.
- **§0.4 / 1.6 key-injection path — CONFIRMED and correctly flagged as the critical trap.** `keychain_read` (`main.rs:311`) is called by `inject_keys` (`:317-324`), called by `spawn_backend` (`:326-363`) for both dev (`:335-338`) and release (`:349-351`). If storage moves off the Keychain without rewiring `keychain_read`, the sidecar starts with no keys and dictation silently breaks. All eight key touchpoints exist where claimed: `key_save` (`:200`), `key_get` (`:207`), `key_has` (`:216`), `key_delete` (`:223`), `key_save_clipboard` (`:238`), `set_key` (`:272`), `has_key` (`:282`), `delete_key` (`:293`). `spawn_backend` already has `app: &tauri::AppHandle`, so threading `app` into `inject_keys`/`keychain_read` is clean.
- **`secrets.json` storage location — grounded.** `app.path().app_config_dir()` is already used in-tree (`hotkey_config_path`, `main.rs:582`), so the proposed `app_config_dir().join("secrets.json")` path is real. `.gitignore` "Secrets & keys" block is lines 1–11; the existing `secrets/` entry (a dir) does **not** cover a file named `secrets.json`, so adding `secrets.json` is a meaningful defensive entry (though the file lives outside the repo).
- **§0.5 `config-changed` listener subset — CONFIRMED.** `settings.ts:411-417` only calls `initProviderControls`, `initDockIcon`, `refreshHotkeyUI`, `renderCapabilityErrors`. It does **not** refresh mute-others, theme, launch-at-login, or debug. Must be expanded for Reset (1.3) and the new controls to live-update.
- **1.2 anchor points — CONFIRMED.** `tauri-plugin-store` at `Cargo.toml:21`, `keyring` at `:18`; store-plugin registration at `main.rs:710`; `migrate_legacy_config(app.handle())` at `:748`; `apply_hotkey` change-guard pattern at `:163-166`. Autostart driven from Rust needs no `capabilities/default.json` entry (verified the file lists only core + global-shortcut perms).
- **1.5 surface mapping — CONFIRMED.** `index.html` → `main.ts` is the overlay/orb (no theme code; `<body>` has no `data-theme`). `app.html` → `app.ts` is the app shell (localStorage-only theme, `app.ts:6-24`, no tauri imports at all). `settings.html` → `settings.ts` (`initTheme` `:379-399`, localStorage-only). The brief's "app.ts = overlay" is indeed off; the plan's three-webview target is correct.
- **Cloud-runnable typecheck — CONFIRMED runnable.** I ran `npm run typecheck --workspace @verbatim/widget` (= `tsc --noEmit`) in this cloud env: it executes and passes. `node_modules` and `@tauri-apps/api` types are present. Root `npm test` = `@verbatim/core` only, so widget TS is genuinely **not** covered by `npm test` — the plan's §0.6 statement is accurate.

---

## Corrections required before dev

1. **(1.4 — BLOCKING) The sidecar does not read `HEAR_DEBUG`.** The process Rust spawns is `apps/backend/src/server.ts`, which has **no** `HEAR_DEBUG` gate — its logging is unconditional (`server.ts:19,42,218-221`). The only `HEAR_DEBUG` reader in the repo is the legacy `scripts/dev.mjs` (`DEBUG = process.env.HEAR_DEBUG !== "0"`), which the widget never spawns. Injecting `HEAR_DEBUG=1` into the sidecar therefore changes **nothing**, and the on-Mac acceptance test ("verbose `[hear]`-style logs appear") cannot pass as written. **Fix (now applied inline in the plan, §1.4):** either (A, recommended) add `const DEBUG = process.env.HEAR_DEBUG === "1";` to `server.ts` and gate verbose lines behind it so the injected env actually lights up, or (B) narrow 1.4's acceptance to "the sidecar receives `HEAR_DEBUG=1` in its env" and defer the verbose behaviour with an explicit `server.ts` TODO. Do not ship 1.4 claiming verbose logs work until the gate exists.

2. **(1.5 — REQUIRED sub-task, was flagged only as optional) The overlay stylesheet has no theme tokens.** `apps/widget/src/style.css` has **0** `data-theme` rules and no `prefers-color-scheme` — only a single `:root{}` palette (`style.css:3`). Setting `document.body.dataset.theme` in `main.ts` flips the attribute but produces **no visual change**. The dev MUST add `[data-theme="dark"]` (and a light override if the base isn't already light) token blocks plus a `prefers-color-scheme`-aware "system" path to `style.css`, mirroring `settings.css` (which has 4 `data-theme` rules). The "overlay goes dark" test depends on this CSS, not just the JS. (Now applied inline in the plan, §1.5.)

3. **(1.5 — minor) `app.ts` has no shared `AppConfig` type.** `app.ts` currently imports nothing from `@tauri-apps/api` and has no config type. When adding `invoke(...)`/`listen(...)` there, inline a local type — e.g. `invoke<{ theme?: string }>("get_config")` and `listen<{ theme?: string }>("config-changed", …)` — rather than importing `AppConfig` (which lives only in `settings.ts`), or `tsc --noEmit` will fail. Cheap; call it out so the dev doesn't reach for a cross-file import.

4. **(line-number drift — fixed by reviewer)** Two off-by-ones corrected in the plan: `mute_others` in the `Default` impl is `main.rs:117` (plan said `:118`); the dev-mode `inject_keys` call site is `main.rs:337` (plan said `:338`; release `:351` was correct). Symbol names in the plan are otherwise authoritative and matched; re-locate by symbol if lines drift further.

---

## Answers to the planner's open questions

1. **Overlay theme scope (1.5).** Confirmed: the intended surfaces are `settings.ts`, `app.ts` (app shell), and `main.ts` (orb) — three webviews, exactly as planned. **The orb stylesheet (`style.css`) does NOT define light/dark tokens** (0 `data-theme` rules, no `prefers-color-scheme`); new tokens are required (see correction #2). This is real CSS work, not a maybe.
2. **`HEAR_DEBUG` truthiness (1.4).** The sidecar ignores the var entirely, so "omit vs `0`" is moot for it. The only consumer (`dev.mjs`) uses `!== "0"` → absence means **ON**, which is the opposite of the plan's "omit = off" assumption. **Recommendation:** if you add the sidecar gate (correction #1A), make it explicit and unambiguous — `process.env.HEAR_DEBUG === "1"` on the sidecar; Rust injects `"1"` when on and omits when off. Don't rely on the `dev.mjs` convention.
3. **`key_storage` mechanism (1.6).** Agree with the planner: use the **runtime hidden config field** (`key_storage`, default `"local"`, no UI), not a Cargo feature. It matches settings-plan §1.6.1 ("a config field with no UI"), lets you flip to `keychain` for release-path testing without a rebuild, and keeps `keyring` compiled in (`Cargo.toml:18` stays as-is). Keep the keychain backend behind `#[cfg(target_os = "macos")]` as today.
4. **Generic `key_*` commands (1.6).** They are still registered (`generate_handler!` `:912-916`) but the current `settings.ts` UI only calls the per-vendor `set_key`/`has_key`/`delete_key` (`:145,193,178`) — the generic `key_save`/`key_get`/`key_has`/`key_delete`/`key_save_clipboard` have **no** live caller in the widget TS. **Recommendation:** route them through the adapter for consistency (cheap, safe) OR drop the unused four from `generate_handler!` to shrink the surface — but if you remove any, you must confirm no other entrypoint (tray, tests, docs) calls them; the safe default for Wave 1 is route-through, defer removal. Either way, none may keep hitting the raw Keychain, or they re-introduce the password prompts 1.6 exists to kill.
5. **`set_config` `old` read (1.2/1.4).** Two reads per `set_config` call (one typed `old` for change-detection, one already-serialized for the merge) is fine — `read_config` is a cheap store lookup, `set_config` is user-action-frequency, not hot-path. No objection; not worth restructuring the merge.
6. **Backend restart on debug toggle (1.4).** Acceptable. `restart_backend` (`:371`) is the same seam `set_key`/`key_save_clipboard` already use; it briefly drops the loopback socket, which is fine between dictations. Keep the change-guard so unrelated settings don't churn it.
7. **Autostart in dev (1.2).** Correct — verify against a built/bundled app, not `tauri dev`; the LaunchAgent points at the dev binary path and won't relaunch a usable app. `MacosLauncher::LaunchAgent` is the right choice for an `Accessory` menu-bar app.

---

## Cloud-runnable vs on-Mac check labelling

- **No check is mislabeled as cloud-runnable that actually needs the Mac.** Every "Cloud-runnable" item is either `tsc --noEmit` (verified runnable + passing here) or a static grep; every behavioural check is correctly under "On-Mac". Note explicitly (as the plan does) that the widget's Vite TS is **not** exercised by `npm test` (`@verbatim/core` only) — typecheck is the only automated cloud gate, so a green `tsc --noEmit` is necessary but not sufficient; it will not catch Rust or runtime-wiring errors.
- **Secrets hygiene: PASS.** No plan step reads `.env` or logs a key value. (For the record: the *backend* `server.ts` itself loads `.env` via `loadEnv()` (`:45-61`) and prints `PYAI_API_KEY=set/MISSING` — never the value — at `:220`. That is pre-existing backend behaviour, out of scope for Wave 1, and does not leak the secret. The 1.4/1.6 plan steps correctly stay away from both.)
- **Key-storage toggle stays hidden: PASS.** 1.6 keeps `key_storage` as a config-only field with no `settings.html`/`settings.ts` surface. Nothing user-facing ships. Good.

---

## Go / No-go for the dev agent: **GO (with required changes)**

The dev is cleared to start. Follow the plan as corrected, and treat these as MUST-DOs:

- **1.1 first** — it gates the whole Settings window. Add `#muteOthers` to `settings.html` (mirror the `#dockIcon` row `:201-209`), add it to the `config-changed` listener, and make the `DOMContentLoaded` wiring null-safe.
- **1.4:** do NOT claim verbose logging works until you add a real `HEAR_DEBUG === "1"` gate to `apps/backend/src/server.ts` (option A) — or explicitly narrow the acceptance to "env is injected" (option B). Injecting the env alone is a no-op against today's sidecar.
- **1.5:** adding theme tokens to `apps/widget/src/style.css` is required, not optional — the JS attribute flip does nothing without it. Use `settings.css` as the token template. In `app.ts`, inline the config type (no cross-file `AppConfig` import).
- **1.6:** rewire `keychain_read`/`inject_keys` to the new adapter (the make-or-break integration point) and route **all** eight key commands through the adapter so none keep hitting the raw Keychain. Keep `key_storage` hidden (no UI), keep `keyring` compiled in, `secrets.json` at `0600` in `app_config_dir`, never logged.
- **Shared Rust pass:** add all five `Default` entries, capture `let old = read_config(&app)` in `set_config`, and add the change-guarded side-effects (autostart, debug restart) in one edit. Expand the `settings.ts` `config-changed` listener once to cover mute-others, launch-at-login, debug, and theme.
- **Reconcile docs** (product-plan §14 threat model + any Keychain mention) to the local-file model as part of 1.6, per project convention.
