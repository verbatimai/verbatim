# Settings config audit — app-level + Rust-side wiring

Read-only verification audit. Goal: for every setting, confirm the chain **Settings UI →
Rust config store → effect** is intact, hunting the bug class "wired in the UI but never
takes effect."

Scope of files traced:
- `apps/widget/src/settings.ts` (Settings window controls)
- `apps/widget/src-tauri/src/main.rs` (`AppConfig`, `set_config`, side-effects)
- `apps/widget/src-tauri/src/secrets.rs` (secret storage adapter)
- `apps/widget/src/main.ts` (overlay; WS `start` frame)
- `apps/backend/src/server.ts` (backend `start` handler)
- `packages/core/src/settings.ts` + provider/correction adapters (model resolution)

Rust cannot be compiled in the cloud env, so this audits **logic/threading/wiring**, not
compilation. Items marked *(Mac)* need on-device runtime to fully confirm behaviour.

---

## Verdict table

Legend: ✅ stored **and** wired to a real effect · ⚠️ stored + effect present but with a
caveat · ❌ stored but **no effect** (dead).

| Setting (config field) | Stored? | Wired to effect? | Evidence (file:line) | Verdict |
|---|---|---|---|---|
| `stt_model` (sttModel) | Yes | **No** — never leaves the store | Stored `settings.ts:259`; **absent** from WS start frame `main.ts:336-348`; not read in `server.ts:198-219`; adapters read only `process.env.*_MODEL` (`deepgram.stt.ts:34`, `openai.stt.ts:37,52`) | ❌ |
| `correction_model` (correctionModel) | Yes | **No** — never leaves the store | Stored `settings.ts:260`; absent from start frame `main.ts:336-348`; adapters read only env (`correction/pyai.ts:46,68`, `correction/openai.ts:85,111`, `correction/anthropic.ts:53,74`) | ❌ |
| `dock_icon` (dockIcon) | Yes | **No** — nothing reads it | Stored `settings.ts:535`, `main.rs:119`; no reader of `dock_icon`; activation policy hard-coded `Accessory` at startup `main.rs:921` | ❌ |
| `stt_provider` | Yes | Yes | start frame `main.ts:339`; `server.ts:204`, `getSTTProvider` `server.ts:221` | ✅ |
| `correction_provider` | Yes | Yes | start frame `main.ts:340`; `server.ts:205,226` | ✅ |
| `language` | Yes | Yes | start frame `main.ts:341`; `server.ts:206`, into session/format | ✅ |
| `hotkey` | Yes | Yes | `set_config` → `apply_hotkey` `main.rs:206`, re-register `main.rs:846-856`; startup `main.rs:1012` | ✅ *(Mac)* |
| `mute_others` (muteOthers) | Yes | Yes | `main.ts:447-462` reads `muteOthers`, calls `get/set_output_muted` `main.rs:662,679` | ✅ *(Mac)* |
| `launch_at_login` (launchAtLogin) | Yes | Yes | flip side-effect `main.rs:210-212` → `apply_autostart` `main.rs:237-245`; startup reconcile `main.rs:1011` | ✅ *(Mac)* |
| `debug` | Yes | Yes | flip → `restart_backend` `main.rs:215`; `inject_keys` sets `HEAR_DEBUG` `main.rs:510-512`; backend gate `server.ts:70` | ✅ *(Mac)* |
| `theme` | Yes | Yes | overlay `main.ts:22-28` (config-changed); settings window `settings.ts:504-529` | ✅ |
| `correct` | Yes | Yes | start frame `main.ts:342`; `server.ts:209`, gate `server.ts:133` | ✅ |
| `format` | Yes | Yes | start frame `main.ts:343`; `server.ts:210`, gate `server.ts:152` | ✅ |
| `paste_last_hotkey` (pasteLastHotkey) | Yes | Yes | flip → `apply_paste_last_hotkey` `main.rs:219-221,862-875`; handler injects `LAST_RESULT` `main.rs:1050-1068` | ✅ *(Mac)* |
| `mic_device_id` (micDeviceId) | Yes | Yes | `main.ts:386` reads `micDeviceId` into getUserMedia constraint | ✅ |
| `auto_detect_language` (autoDetectLanguage) | Yes | Yes | start frame `main.ts:344` (→ `autoDetect`); `server.ts:212,245` | ✅ |
| `telemetry` | Yes | Yes (parked) | start frame `main.ts:347`; `server.ts:219` gates `Telemetry` (NoopSink transport parked by design) | ⚠️ |
| `fn_push_to_talk` (fnPushToTalk) | Yes | Yes | flip → `fnkey::set_enabled` `main.rs:226-228`; startup `main.rs:1145` | ✅ *(Mac)* |
| `ptt_key` (pttKey) | Yes | Yes | same side-effect path `main.rs:226-228,1145` | ✅ *(Mac)* |
| `key_storage` (hidden) | Yes | Yes | `secrets.rs:23-24` selects backend; default `local` `main.rs:149` | ✅ |
| Reset (`clear_config`) | — | Yes | `main.rs:252-272` resets all fields, re-registers hotkeys, keeps secrets, emits config-changed | ✅ *(Mac)* |
| config-changed live refresh | — | Yes | `settings.ts:792-795` → `refreshControls()` `settings.ts:758-774` refreshes every control | ✅ |

---

## Findings

### [HIGH] F1 — `stt_model` / `correction_model` overrides are DEAD end-to-end

**Root cause.** The model-override fields are the exact "wired in the UI, never takes
effect" bug class. The chain is broken in *multiple* places:

1. `settings.ts:259-260` persists `sttModel`/`correctionModel` into the config store via
   `patchConfig` — this part works.
2. The overlay's WS `start` frame **omits both fields**. `apps/widget/src/main.ts:336-348`
   sends `sttProvider, correctionProvider, language, correct, format, autoDetect,
   vocabulary, snippets, telemetry` — no `sttModel`, no `correctionModel`.
3. The backend never reads them. `apps/backend/src/server.ts:198-219` parses the start
   frame and never references `msg.sttModel`/`msg.correctionModel`.
4. Every adapter resolves its model **only** from `process.env.*_MODEL`:
   - STT: `providers/deepgram.stt.ts:34,80` (`DEEPGRAM_STT_MODEL`),
     `providers/openai.stt.ts:37,52` (`OPENAI_STT_MODEL`/`OPENAI_BATCH_MODEL`).
   - Correction: `correction/pyai.ts:46,68` (`PYAI_MODEL`),
     `correction/openai.ts:85,111` (`OPENAI_CORRECTION_MODEL`),
     `correction/anthropic.ts:53,74` (`ANTHROPIC_MODEL`).
5. The Rust host does **not** bridge the config to those env vars either.
   `inject_keys` (`main.rs:508-518`) injects only `HOST`, `PORT`, `HEAR_DEBUG`, and the
   four `VENDOR_KEYS` (API keys). It never maps `stt_model`/`correction_model` →
   `DEEPGRAM_STT_MODEL` / `OPENAI_STT_MODEL` / `PYAI_MODEL` / etc.

**Net effect.** Typing a model into the Settings "Models" pane (the UI's headline landing
tab, `settings.ts:487` `show("models")`) changes the stored config and nothing else. The
only working way to override a model today is a repo `.env` (dev) or an env var in the
sidecar's environment — i.e. the `process.env.*_MODEL` path, which the UI never touches.
PyAI STT (`providers/pyai.stt.ts`) has no model override at all (hard-coded `pyai-hear`),
so a `sttModel` value for PyAI is meaningless regardless.

**Fix (pick one; option A is consistent with every other runtime setting).**
- **A — thread through the start frame (preferred).** Add `sttModel: cfg.sttModel` and
  `correctionModel: cfg.correctionModel` to the start frame in `main.ts:336-348`; read
  `msg.sttModel`/`msg.correctionModel` in `server.ts` and pass an explicit `model` option
  into `getSTTProvider(...).startSession/transcribeBatch` and
  `getCorrectionProvider(...).correct/format`. That requires threading a `model?` field
  through the adapter `types.ts` option objects and using `opts.model ?? process.env.* ??
  DEFAULT` in each adapter. This makes the override per-session and store-driven, matching
  `correct`/`format`/`autoDetect`.
- **B — bridge in Rust (smaller diff, coarser).** In `inject_keys` (`main.rs:508-518`),
  read `read_config(app)` and, per selected provider, set the matching `*_MODEL` env var
  from `stt_model`/`correction_model` when non-empty; call `restart_backend` when either
  model field changes in `set_config` (add to the change-guards at `main.rs:209-228`).
  Simpler but the model only applies to the *selected* provider and needs a sidecar
  restart on change.

Whichever path: PyAI STT should ignore `sttModel` (or the UI should disable the STT-model
field when `sttProvider === "pyai"`), since the model is fixed.

---

### [MEDIUM] F2 — `dock_icon` toggle is stored but never applied

**Root cause.** Same bug class. `settings.ts:531-536` (`initDockIcon`) reads and persists
`dockIcon`, and the field exists in `AppConfig` (`main.rs:119`, default `false`
`main.rs:144`). But **nothing reads `config.dock_icon`.** A repo-wide search for the field
finds only the struct declaration/default — no reader. The activation policy is hard-coded:
`configure_non_activating_panel` sets `ActivationPolicy::Accessory` at startup
(`main.rs:921`, "no Dock icon"), and the Settings-window close handler reverts to
`Accessory` (`main.rs:989`). The transient `Regular` at `main.rs:88` exists only to give
the Settings window keyboard focus and is unrelated to the toggle. So flipping "Show Dock
icon" persists a value and changes nothing visible.

**Fix.** In `set_config`, add a change-guard on `dock_icon` that calls
`app.set_activation_policy(Regular|Accessory)` accordingly (respecting that the Settings
window's focus dance must still restore to the *configured* policy, not always
`Accessory`), and read `config.dock_icon` in `configure_non_activating_panel` / startup so
the choice is honoured on launch. Note macOS nuance: `Regular` shows a Dock icon but can
let the overlay panel take focus — verify the non-key panel still injects correctly under
`Regular` *(Mac runtime needed)*. If honouring this cleanly is out of scope, remove the
toggle from the UI rather than shipping a dead control.

---

### [INFO] F3 — serde camelCase mirroring: NO mismatch found (verified clean)

`AppConfig` uses `#[serde(rename_all = "camelCase", default)]` (`main.rs:110-133`). Every
one of the 20 fields serializes to a camelCase name that the TS side reads under the exact
same key. Full cross-check:

`sttProvider, correctionProvider, sttModel, correctionModel, language, hotkey, dockIcon,
muteOthers, launchAtLogin, debug, theme, keyStorage, correct, format, pasteLastHotkey,
micDeviceId, autoDetectLanguage, telemetry, fnPushToTalk, pttKey`

— all present and identically spelled in `settings.ts`'s `AppConfig` type (`settings.ts:9-30`)
and in every `cfg.*` read in `main.ts` (`sttProvider`/`correctionProvider`/`language`/
`correct`/`format`/`autoDetectLanguage`/`telemetry` at `main.ts:339-347`, `micDeviceId`
`main.ts:386`, `muteOthers` `main.ts:451`, `theme` `main.ts:25-28`). The container-level
`default` also means legacy/partial stored configs deserialize without error, and the
`set_config` shallow-merge (`main.rs:195-200`) merges camelCase patch keys over a camelCase
base, so the merge is key-consistent. **No silently-undefined setting from a rename
mismatch.** (The dead settings F1/F2 are wiring gaps, not serde gaps.)

---

### [LOW] F4 — capability guard parity: agrees, with a structural caveat

`packages/core/src/settings.ts:72-116` `capabilityErrors` and the widget mirror
`settings.ts:112-127` agree on the PyAI-English-only auto-detect guard: both fire the
English-only error whenever `sttProvider === "pyai" && !isEnglish(language)`, both append
the same "(Auto-detect doesn't apply…)" note when `autoDetectLanguage` is on, and both use
an identical `isEnglish` helper (`core settings.ts:61-64` vs `settings.ts:105-108`). Match.

Caveat (not a bug today): the core version reports *per-required-key* misses
(`stt.requiredKeys.filter(k => !env[k])`), while the widget mirror checks a single
`hasKey[provider]` boolean (`settings.ts:114-119`). Every current vendor has exactly one
required key, so they agree; if any vendor ever needs two keys, the widget mirror would
under-report. Keep them in sync — same manual-sync hazard called out in the code comments
(`settings.ts:32-40`).

---

### [INFO] F5 — Secrets / keychain removal (Phase 1.6): correctly routed and gated

- **All read/write paths go through the adapter.** `key_save`/`key_get`/`key_has`/
  `key_delete`, the vendor wrappers `set_key`/`has_key`/`delete_key`, `key_save_clipboard`,
  and the sidecar's `inject_keys` all call `secrets::secret_{set,get,has,delete}`
  (`main.rs:416-518`). No path bypasses the adapter.
- **Default backend is `local`.** `key_storage` defaults to `"local"` (`main.rs:149`); the
  adapter's `backend()` reads it (`secrets.rs:23-24`). The `keyring` branch is only reached
  when `key_storage == "keychain"` (`secrets.rs:76-124`), and **no UI writes `keyStorage`**
  (it's the hidden field, `settings.ts:21` type-only, no control) — so on the active path
  the OS keychain is never touched and no login-password prompt can appear. The `keyring`
  code is dead-but-present (kept for a future opt-in), not on the active path.
- **`secrets.json` is 0600 and never logged.** `write_map` does an atomic temp+rename and
  calls `set_owner_only` (chmod 0600) on both the temp and the final file
  (`secrets.rs:46-73`); the map holding secret values is only serialized/written, with an
  explicit "NEVER log it" contract (`secrets.rs:51`). No `println!`/`eprintln!` prints a
  secret value anywhere on the path (spawn logs say "keyed from local secret store",
  `main.rs:552`, value-free).
- **`.gitignore` covers it.** `secrets.json` (`.gitignore:10`) and `secrets/`
  (`.gitignore:9`) are ignored; `.env`/`*.key`/`*.p12`/`*.keychain` also covered. The file
  lives in `app_config_dir` (outside the repo) anyway (`secrets.rs:27-34`).
- **Reset keeps secrets.** `clear_config` deliberately does not touch secrets
  (`main.rs:269`).

One deferred item is documented in-code: runtime migration between backends is a TODO and
intentionally unimplemented while only `local` ships (`secrets.rs:15-18`).

---

## Needs on-Mac runtime to fully confirm (Rust behaviour)

- Hotkey (re)registration, paste-last accelerator, and the toggle/PTT event tap
  (`tauri_plugin_global_shortcut`, `fnkey::set_enabled`) — logic verified; actual OS
  registration and the Fn/CGEventTap require a Mac and the relevant TCC permissions.
- `launch_at_login` login-item create/remove via `tauri-plugin-autostart`.
- `debug` → sidecar restart picking up/dropping `HEAR_DEBUG`.
- `mute_others` AppleScript `osascript` output-mute/restore.
- 0600 permissions and atomic rename on `secrets.json` (filesystem-level).
- Any F2 fix: whether the non-key overlay panel still injects correctly under
  `ActivationPolicy::Regular` when a Dock icon is shown.

---

## Bottom line

The single most impactful bug is **F1**: the `stt_model` / `correction_model` override
fields — the Settings "Models" pane, the app's headline feature — are **completely dead**.
The value is saved to the config store but is never sent on the WS start frame
(`main.ts:336-348`), never read by the backend (`server.ts:198-219`), never bridged to env
by the Rust host (`inject_keys`, `main.rs:508-518`), and every adapter resolves its model
solely from `process.env.*_MODEL`. **F2** (`dock_icon`) is a second, lower-impact instance
of the same class. No serde/camelCase mismatch exists — that channel is clean. The
secrets/keychain removal is correct: all paths route through the local-file adapter
(default `local`), `secrets.json` is written 0600 and never logged, and `.gitignore` covers
it, with `keyring` present only behind an unreachable hidden flag.
