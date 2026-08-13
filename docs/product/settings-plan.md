# Settings — Implementation Plan

**Owner:** Mayank Banga · Saaslabs
**Date:** 13 Aug 2026
**Scope:** Turn the ~18 placeholder / half-wired controls in the Settings window into a coherent, mostly-working page. Derived from the settings audit (see the chat review of `apps/widget/settings.html` + `settings.ts` + Rust config store).
**Relationship to roadmap:** Waves 1–2 are quick wins that belong in **M4 polish**; Waves 3–5 are **M5 (Quality & polish / daily-driver)** and beyond. Nothing here changes the vendor-agnostic core contract.
**Rev 13 Aug 2026:** added §1.6 — remove the macOS Keychain in favour of local key storage (product decision: the Keychain's repeated password prompts are a bad UX for now; keychain returns later as an opt-in setting).

---

## 0. Guardrails (read before touching code)

- **Rust builds only on the Mac.** Anything under `apps/widget/src-tauri` must be `cargo build` / `npm run widget`-verified on the Mac — it cannot compile in the cloud authoring env. HTML/TS/CSS can be authored anywhere.
- **New config fields must be backward-compatible.** `set_config` deserializes the *whole* merged object into `AppConfig`, so any field added to the struct that's missing from an existing `settings.json` will fail to parse. Add `#[serde(default)]` to **every** new field (and keep the `Default` impl in sync) so old stores still load.
- **Key storage moves off the Keychain (§1.6).** Vendor keys now live in a dedicated, gitignored, `0600` local file — **separate from `settings.json`** and **never logged**. This is a deliberate downgrade from the §14 threat model's "OS-keychain storage"; §14 and the Settings copy must be reconciled to say "stored locally on this device." Keychain returns later as an opt-in `key_storage` setting.
- **Telemetry is opt-in, metadata-only, default OFF** — per `product-plan.md` §14. Never send transcript/audio content.
- **Security gate still applies** to every PR (secret-scan + SAST + dep-audit).
- **Keep `packages/core` and the Rust `vendor_key_name` map in sync** by hand, as today (no shared runtime between the Vite app and `@verbatim/core`).

---

## 1. Config schema changes (one place)

All new fields go on the Rust `AppConfig` struct (`main.rs` ~line 96) **and** the `Default` impl, each marked `#[serde(default)]`, then mirrored in the `AppConfig` type in `settings.ts` (line 9). `set_config`'s shallow-merge needs no changes.

| Field | Type | Default | Drives |
|---|---|---|---|
| `mute_others` | bool | `true` | *(exists)* mute system audio while dictating |
| `launch_at_login` | bool | `false` | autostart plugin |
| `theme` | string | `"system"` | overlay + settings theme (persisted) |
| `format` | bool | `true` | formatting pass on/off |
| `correct` | bool | `true` | self-correction on/off (STT-only mode when false) |
| `debug` | bool | `false` | verbose logging (mirrors `HEAR_DEBUG`) |
| `telemetry` | bool | `false` | opt-in metadata-only analytics |
| `auto_detect_language` | bool | `false` | language auto-detect (Deepgram/OpenAI) |
| `mic_device_id` | string | `""` | preferred input device (`""` = system default) |
| `mute_sounds` | bool | `false` | silence start/stop chimes (once chimes exist) |
| `paste_last_hotkey` | string | `""` | global "paste last transcript" accelerator (`""` = unset) |

Vocabulary and Snippets are **list data**, not scalar config — they get their own `tauri-plugin-store` files (`vocabulary.json`, `snippets.json`), not `AppConfig` fields.

---

## 2. Wave 1 — Quick wins (M4 polish)

Small, expected-of-a-real-app, low risk. Ship these first.

### 1.1 Fix mute-others (bug + finish 4.9)  ·  S
The Rust behaviour already exists (mute on dictation start, restore on stop, ~lines 427–469); only the UI toggle is missing, and `settings.ts` already references a `#muteOthers` element that doesn't exist → **TypeError on every Settings open**.
- **Files:** `settings.html` (add a toggle row in Preferences or Dictation), `settings.ts` (already wired at lines 47 + 430–433 — just needs the element to exist).
- **Acceptance:** toggle reflects `config.mute_others`, persists, and (on Mac) system audio ducks during dictation and restores on stop. No console error on open.
- **Verify:** on-Mac click-through + play music while dictating.

### 1.2 Launch at login  ·  S
- **Add dep:** `tauri-plugin-autostart = "2"` in `Cargo.toml`; register the plugin in `main.rs` setup.
- **Files:** `Cargo.toml`, `main.rs` (init plugin + a `set_launch_at_login` command that calls the plugin's enable/disable and writes `launch_at_login`), `settings.html` (enable the existing disabled toggle), `settings.ts` (wire it).
- **Acceptance:** toggling on registers the login item; survives app restart; toggling off removes it.
- **Verify:** on-Mac — toggle, check System Settings → General → Login Items, reboot/relogin.

### 1.3 Reset settings  ·  S
- **Files:** `main.rs` (`clear_config` command: delete `CONFIG_KEY` from the store / write `AppConfig::default()`, re-apply hotkey, emit `config-changed`; **do not** touch keychain), `settings.html` (enable the disabled Reset button + a confirm step), `settings.ts` (wire; re-fetch config after).
- **Acceptance:** Reset returns all fields to defaults, keeps API keys, and the open form updates live via `config-changed`.
- **Verify:** on-Mac — change several settings, Reset, confirm defaults + keys intact.

### 1.4 Debug mode  ·  S
- **Files:** `main.rs` (persist `debug`; on change, set the process/log level the same way `HEAR_DEBUG` does — thread it into the backend/sidecar log gate), `settings.html`/`settings.ts` (enable toggle).
- **Acceptance:** enabling produces the verbose `[hear]`-style logs without needing the env var; persists.
- **Note:** if logging currently lives only in the dev backend, scope this to the sidecar once 4.8 lands; until then wire it to whatever the widget's log path is.
- **Verify:** on-Mac — toggle, watch logs.

### 1.5 Appearance — persist + apply globally  ·  S–M
Today the L/D/System control themes the **settings window only** via `localStorage`; it's honestly tagged "Not in use" because it doesn't persist to config or reach the overlay/orb.
- **Files:** `settings.ts` `initTheme()` (write `theme` to config via `patchConfig`, keep `localStorage` as a fast-path), `app.ts` (apply `config.theme` to the overlay/orb and react to `config-changed`), `main.rs` (`theme` field).
- **Acceptance:** picking Dark themes both the settings window and the overlay/orb, and persists across restart. Drop the "Not in use" tag.
- **Verify:** on-Mac — set Dark, reopen overlay, restart.

### 1.6 Remove the macOS Keychain — local key storage  ·  S–M  ·  ⚠ security tradeoff
**Why:** the Keychain prompts for the login password repeatedly, which is a frustrating UX. Root cause worth knowing: unsigned / ad-hoc-signed **dev** builds get a *new* code signature on every rebuild, so macOS treats each build as a new app and re-prompts; a **release** build signed with a stable identity prompts once and "Always Allow" sticks. We're choosing to not depend on signing right now and store keys locally instead.

**Approach — keep the command surface identical.** Replace the `keyring`-backed `set_key` / `has_key` / `delete_key` (main.rs ~272–294) with a **file-backed** store: a dedicated `secrets.json` in the app config dir, kept **separate from `settings.json`** (so config reset/export never touches keys, and a future Keychain migration is a clean swap). `settings.ts`'s vendor-key rows call the same three commands, so the UI logic is unchanged — only the copy changes.

**Hardening (required — keys are now plaintext-on-disk):**
- Write `secrets.json` with `0600` perms; store it in the app config dir, **outside the repo**; add its name to `.gitignore` defensively.
- Never log or export key values in any debug path (ties to 1.4's debug toggle — redact).
- Replace the Settings copy "Stored in the macOS Keychain — never written to disk in plaintext" (settings.html ~line 415) with an honest "Stored locally on this device."
- Keep BYOK + the rotate-test-key-before-public gate.

**Docs to reconcile:** `product-plan.md` §14 (threat model → "OS-keychain storage") and any architecture doc mentioning the Keychain must be updated to state the current local-file model, and that Keychain returns as an option.

**Future — pluggable storage, but stage the exposure (decision 13 Aug 2026):**

Split the *mechanism* from the *setting*. Do NOT ship a user-facing storage toggle yet — a live "Keychain vs local" switch is a footgun (a user flips to Keychain before release signing is sorted and walks straight back into the repeated-prompt UX, looking like a bug they enabled), and "where are my keys physically stored" is an implementation detail most users shouldn't have to reason about.

1. **Now — adapter + hidden flag.** Build key storage as an adapter behind the existing `set_key`/`has_key`/`delete_key` command surface, with two backends (`local`, `keychain`). Select the backend via a **hidden** `key_storage` value (a config field with no UI, or a Cargo `keychain` feature) defaulting to `local`. Keep `keyring` in `Cargo.toml`. This keeps the Keychain code in-tree and lets us test the release path by flipping the flag — with no shipped switch.
2. **Later — user-facing toggle (Advanced pane).** Promote it to a real setting only once **both** hold: (a) release builds are signed with a stable identity so the Keychain prompts once and "Always Allow" sticks, and (b) the migrate-and-wipe rule below is implemented. At that point it becomes an asset — default `local` for convenience, opt into `keychain` to harden.

**Migrate-and-wipe rule (hard requirement whenever the backend can change):** switching backends must *move* the key into the new store and then **securely delete the copy in the old store**. Never leave a stale plaintext `secrets.json` key behind after switching to Keychain — otherwise the switch defeats its own purpose. Same in reverse (Keychain → local removes the Keychain item). If migration can't complete, fail the switch and leave the original store intact rather than half-migrating.

**Acceptance:** entering / re-entering / deleting a key **never** prompts for the login password; keys persist across restart; deleting removes them from disk; keys never appear in logs or in git.
**Verify:** on-Mac — add a key, restart the app, delete it, all with zero password prompts; grep logs for the value; confirm the file is gitignored and `0600`.

**Wave 1 exit:** no runtime error on Settings open; launch-at-login, reset, debug, mute-others, and theme all persist and take effect on the Mac; entering an API key no longer triggers any Keychain password prompt.

---

## 3. Wave 2 — Small features (M4 polish → early M5)

### 2.1 Paste last transcript (global hotkey)  ·  S–M
Reuse the existing pattern: there's already a `test_paste` (⌥⇧V) accelerator and a tray `show-last` event, plus `inject_text`. Add a **configurable** accelerator that injects the last **formatted** result.
- **Files:** `main.rs` (store the last formatted transcript in a `static LAST_RESULT: Mutex<Option<String>>`; register `paste_last_hotkey` like the toggle via `parse_accelerator`/`apply_hotkey`; on Pressed, `inject_text(last)`), `settings.html`/`settings.ts` (a second hotkey-capture row, reusing the capture UI already built for the toggle).
- **Acceptance:** after a dictation, pressing the chosen combo pastes the last result into the focused field; refuses gracefully if empty.
- **Verify:** on-Mac — dictate, focus another field, press combo.
- **Dependency:** confirm where the finalized transcript is currently held (backend vs. Rust); may need the backend to hand the final string to Rust (small seam, aligns with 4.8 sidecar).

### 2.2 Self-correction — real toggle, not decoration  ·  S
Currently disabled+checked+informational. Make it a real switch: when off, skip the correction pass (STT-only, "raw" mode).
- **Files:** `packages/core` pipeline (respect a `correct` flag → bypass the correction provider, emit raw as final), `settings.ts`/`settings.html` (enable toggle → `patchConfig({correct})`), `main.rs` (`correct` field), wire the flag into the session start.
- **Acceptance:** off → final output equals the cleaned-but-uncorrected transcript (no self-correction ops); on → today's behaviour. Add a core unit test for the bypass.
- **Verify:** cloud unit test + on-Mac spot check.

### 2.3 Formatting toggle (leave "Alpha")  ·  M
Formatting already runs as the finalize pass in the correction provider; expose an on/off `format` flag.
- **Files:** `packages/core` pipeline/format path (gate the `FORMAT_PROMPT` pass on `format`), `settings.ts`/`settings.html` (enable toggle), `main.rs` (`format` field).
- **Acceptance:** off → punctuation/structure pass is skipped (raw-ish clean text); on → today's formatted output. Core unit test for both branches.
- **Verify:** cloud unit test (offline fixture) + on-Mac.

**Wave 2 exit:** last-paste hotkey works; correction and formatting are independently switchable and covered by core tests.

---

## 4. Wave 3 — M5 features (Quality & polish)

### 3.1 Microphone device picker  ·  M
Mic capture is `getUserMedia` in the webview, so this is a front-end concern with a persisted id.
- **Files:** the capture code in `app.ts` (enumerate via `navigator.mediaDevices.enumerateDevices()`, pass `deviceId` into `getUserMedia` constraints), `settings.ts`/`settings.html` (populate the disabled `<select>` from `enumerateDevices`, persist `mic_device_id`), `main.rs` (`mic_device_id` field).
- **Acceptance:** picker lists real input devices; selection persists and is used for capture; `""` = system default.
- **Note:** device labels require mic permission already granted (otherwise labels are blank — handle that state).
- **Verify:** on-Mac with ≥2 input devices.

### 3.2 Auto-detect language  ·  M
Deepgram/OpenAI support language auto-detect; PyAI Hear is English-only.
- **Files:** `packages/core` STT adapters (Deepgram/OpenAI: pass detect flag; PyAI: ignore/guard), `settings.ts` capability layer (when auto-detect is on, relax the fixed-language guard but keep the PyAI-EN-only warning), `main.rs` (`auto_detect_language`), `settings.html` (enable toggle).
- **Acceptance:** with Deepgram/OpenAI + auto-detect on, spoken language is detected; with PyAI, the toggle is disabled/greyed with the English-only hint.
- **Verify:** cloud mock tests for the adapter flag + on-Mac live spot check.

### 3.3 Anonymous telemetry (opt-in)  ·  M
Default **OFF**. Metadata-only (latencies, counts, error rates — per `product-plan.md` §8/§14). **Never** content.
- **Files:** a new `packages/core` telemetry emitter (no-op unless enabled), `main.rs` (`telemetry` field + gate), `settings.html`/`settings.ts` (enable toggle + a one-line "what we collect" link).
- **Acceptance:** off by default; when on, only metadata leaves; a documented event schema; kill-switch is immediate.
- **Verify:** unit test that the emitter is a no-op when disabled + emits only whitelisted fields when enabled.
- **Blocker:** confirm the telemetry sink/endpoint decision before building the transport.

### 3.4 Vocabulary  ·  L
Custom words/names/spellings biasing correction (and STT where supported).
- **Files:** new `vocabulary.json` store + Rust CRUD commands, `settings.ts`/`settings.html` (replace the empty pane with an add/edit/delete list), `packages/core` correction prompt (inject the term list; Deepgram/PyAI keyword-boost where the API allows).
- **Acceptance:** added terms survive restart and measurably bias output on a fixture; empty state still reads cleanly.
- **Verify:** core unit test (prompt contains terms) + on-Mac.

### 3.5 Snippets  ·  L
Spoken trigger → expanded phrase, applied post-transcript.
- **Files:** new `snippets.json` store + CRUD, a post-process expander in `packages/core` (match trigger → replace), `settings.ts`/`settings.html` (list UI).
- **Acceptance:** "sig block" → the configured signature; expansion is deterministic and unit-tested.
- **Verify:** core unit test + on-Mac.

**Wave 3 exit:** mic picker, auto-detect, opt-in telemetry, vocabulary, and snippets all functional; new core logic unit-tested in the cloud; page has no remaining "Not available yet" empties except intentionally deferred items.

---

## 5. Wave 4 — Native spike: Fn push-to-talk  ·  L

Already deferred in STATUS/M3. Bare-key hold (Fn) needs a native `CGEventTap` + **Input Monitoring** permission — outside `tauri-plugin-global-shortcut`.
- **Files:** a new Rust module (`fnkey.rs`) running a CGEventTap on a background thread, emitting `dictation` `Pressed`/`Released` like the existing toggle path; a Permissions row for Input Monitoring (mirror the AX/mic status pattern); `settings.html`/`settings.ts` (enable the "Push to talk" row + status).
- **Acceptance:** holding Fn dictates and releasing stops, without stealing focus; degrades cleanly if Input Monitoring isn't granted.
- **Verify:** dedicated on-Mac spike (own PR); this is the riskiest item — timebox it.
- **Risk:** Fn is special on macOS (globe/dictation); may need a fallback bare key. Validate early.

---

## 6. Wave 5 — Product surface: Draft mode  ·  L (post-M5)

Speak an instruction → generate text → review → insert. This is a **new mode**, not a setting; treat the toggle as a feature flag for a separate design.
- **Deliverable:** a short design note first (`docs/product/draft-mode.md`) before any code — out of scope for this settings pass beyond keeping the Labs toggle as a disabled placeholder.

---

## 7. Cleanup / relabels (do alongside Wave 1)

- **Preload speech model (Advanced):** **remove.** You use cloud STT — there's no local model to preload. If a "keep the STT socket warm" optimization is ever wanted, that's a different, separately-justified feature.
- **Show widget while inactive (Preferences):** **reconcile or remove.** The draggable orb already shows when idle, which contradicts this toggle. Decide the idle model, then either delete the row or repurpose it as "hide orb when idle."
- **Mute dictation sounds (Preferences):** **keep disabled** until start/stop chimes exist. When sounds are added, wire `mute_sounds` (trivial).
- **Self-correction / Appearance "Not in use" tags:** removed as part of 2.2 / 1.5.
- **General:** once Waves 1–2 land, group everything still unbuilt under a single clearly-labeled **"Planned"** section so the page reads as intentional, not half-disabled.

---

## 8. Sequencing & effort

```
Wave 1 (quick wins, M4)      ─ mute-others fix · launch-at-login · reset · debug · theme
                               · remove Keychain (§1.6, local key store)                        ~3–4 days
Wave 2 (small features)      ─ paste-last hotkey · correction toggle · formatting toggle        ~2–3 days
Wave 3 (M5)                  ─ mic picker · auto-detect · telemetry · vocabulary · snippets      ~1.5–2 wks
Wave 4 (native spike)        ─ Fn push-to-talk (own PR, timeboxed)                               ~3–5 days
Wave 5 (post-M5)             ─ draft mode (design note first)                                    TBD
Cleanup                      ─ relabels + "Planned" grouping (fold into Wave 1)                  ~0.5 day
```

Each wave is independently shippable and demoable. Waves 1–2 can land before M5 formally opens.

## 9. Testing & verification

- **Cloud (authorable now):** unit tests in `packages/core` for every new core branch — correction bypass (2.2), formatting bypass (2.3), auto-detect flag (3.2), telemetry no-op/whitelist (3.3), vocabulary prompt injection (3.4), snippet expansion (3.5). All must stay green in `npm test`.
- **On-Mac (required for Rust/UI):** a click-through checklist per wave — toggle each control, confirm persistence across restart, confirm `config-changed` keeps the form in sync, confirm the overlay still injects while Settings is open. Any `src-tauri` change must `cargo build` / `npm run widget` clean before merge.
- **Backward-compat:** load an old `settings.json` (missing the new fields) and confirm it deserializes via `#[serde(default)]` — add a Rust test or a manual check.

## 10. Risks & open decisions

1. **Telemetry sink undecided** — blocks 3.3 transport; the toggle + no-op emitter can land first.
2. **Last-transcript ownership** (2.1) — depends on whether the final string lives in the backend or Rust; cleanest after the 4.8 sidecar seam.
3. **Fn key semantics** (Wave 4) — macOS treats Fn specially; validate feasibility before committing UI.
4. **Debug logging path** (1.4) — dev backend today vs. sidecar post-4.8; scope accordingly.
5. **Auto-detect vs. capability model** (3.2) — must not break the PyAI-English-only guard.
6. **Local key storage is a security downgrade** (1.6) — API keys move from the Keychain to a plaintext (gitignored, `0600`) file. Acceptable for a pre-release, single-user BYOK tool on the user's own machine, but the `product-plan.md` §14 threat model and the in-app copy must be updated so the docs don't overstate security. Re-add the Keychain as an opt-in `key_storage` setting before any managed/hosted or multi-user posture.
