# First-Run Onboarding — Design & Implementation Plan

**Prototype:** [`onboarding-prototype.html`](./onboarding-prototype.html) — open in a browser. Interactive; header toggles switch **Public/Internal build**, **Local runtime absent/available**, and light/dark. Every state below has a frame.
**Owner:** Mayank Banga · Saaslabs · **Drafted:** 18 Aug 2026 · **Revised:** 18 Aug 2026 (second-role key + local-model path)
**Status:** **O1–O7 implemented 18 Aug 2026** (authored, typecheck-green, `cargo build` pending — see §12). **O8 remains open**, blocked on §9 #5. Build plan: [`../onboarding/implementation-plan.md`](../onboarding/implementation-plan.md) · independent review: [`../onboarding/review.md`](../onboarding/review.md).
**Touches:** `apps/widget` (onboarding webview + Rust host), `packages/core` (new zero-key provider ids, O8 only), `docs/`.
**Related:** `../architecture/desktop-app-windows.md` (window/panel model) · `settings-plan.md` (the Settings surface this hands off to) · `../architecture/vendor-apis.md` (per-vendor auth) · `platform/p3-plan.md` (the on-device inference precedent) · `roadmap.md` (M6 public release).

**Goal:** turn first run into a **≤2-minute, 1-paste setup that always ends in a working install** — and stop it from ever ending in a config that can't dictate. Optimised for an **external open-source user**. Three sources of capability are first-class: **a cloud key**, **a second key for whichever role the first one doesn't cover**, and **fully-local models (no key at all)**. Internal Saaslabs builds additionally get a one-click PyAI test key that is **absent from public builds by construction**.

---

## 0. Ground truth from the code (read this first)

Symbol names are authoritative; line numbers are as-read on 18 Aug 2026 against the live repo.

1. **The onboarding window already exists and is correctly wired.** `tauri.conf.json` declares a third window (`label: "onboarding"`, `url: onboarding.html`, 440×480, `center`, `focus: true`, `visible: false`); `vite.config.ts` has the `onboarding` rollup input; `capabilities/default.json` lists `"onboarding"` in `windows` so `invoke` works from it. `main.rs`'s `setup()` opens it when `keys::any_vendor_key_saved(app.handle())` is false, and `window::register_onboarding_close_handler` mirrors the Settings handler. **None of that needs rebuilding** — this plan changes the *content*, the *resolver*, and the *exit path*.

2. **The role model is asymmetric, and onboarding currently ignores that.**
   - `providers/registry.ts` — STT: `pyai`, `deepgram`, `openai` (+ `fixture`).
   - `correction/registry.ts` — correction: `openai`, `anthropic` (+ `mock`). **PyAI was removed as a correction vendor** (`correction/pyai.ts` deleted in `f484096`, 14 Aug) — *after* onboarding landed (`a1fec2d`, 14 Aug).
   - `onboarding.ts`'s `VENDOR_CAPABILITIES` still claims `pyai: { stt: true, correction: true }`, so the default, "Recommended" pick writes `correctionProvider: "pyai"` — an id no registry can resolve.

3. **An STT-only key is a legitimate, working configuration.** In `server.ts` (finalize, ~174-217): `doCorrect === false` ⇒ `cleanText = raw`; `doFormatEff === false` ⇒ `finalText = cleanText` with **no LLM call, no `localFormat`, and no error frame**. So `{ correct: false, format: false }` is a clean "raw dictation" mode. This is what makes a **one-key setup** honest rather than broken.

4. **A bad `correctionProvider` degrades loudly, then fails anyway.** `server.ts:307-312` catches an unresolvable id, sends `Correction '<id>' is invalid — using <DEFAULT_CORR>` and falls back to `DEFAULT_CORR` (`server.ts:68` = `process.env.CORRECTION_PROVIDER ?? "openai"`). With no OpenAI key saved, the cleanup call then fails on its own. The missing-key assert at `server.ts:314-317` covers **STT only**.

5. **Settings cannot show the broken state.** `settings.html:314-317` offers only `openai`/`anthropic` in `#correctionProvider`, so `settings.ts:303`'s `correctionProviderEl.value = config.correctionProvider` with `"pyai"` yields `selectedIndex === -1` (blank field). `capabilityErrors()` (`settings.ts:155-162`) only asks `hasKey[correctionProvider]` — the PyAI key *is* saved — so it reports **zero errors** on an unusable config.

6. **The activation policy leaks.** `window::open_onboarding_window` sets `ActivationPolicy::Regular` for keyboard focus (`window.rs:162`). The only reverts are the two close handlers (`window.rs:147`, `:182`), `configure_non_activating_panel` at startup (`:59`), and `config.rs:199`/`:246`. Both onboarding buttons exit via `getCurrentWindow().hide()`, which **never emits `CloseRequested`** — so the app stays `Regular` (Dock icon, can become frontmost) for the rest of the first-run session despite `dock_icon: false`.

7. **Everything the permissions step needs already exists.** `system.rs`: `open_mic_settings`, `open_accessibility_settings`, `ax_trusted`, `input_monitoring_trusted`, `open_input_monitoring_settings`, `request_input_monitoring`. `axinject.rs:285` `is_trusted()` wraps **`AXIsProcessTrusted()` only** — there is no prompt-with-options variant, so AX is *status + deep link + poll*, never a modal we can raise.

8. **A no-key, no-mic demo path exists.** `server.ts` maps `mode:"demo"` to `fixture` STT + `mock` correction (`:263-269`, `:331`) and `connect("demo")` is still live in `main.ts:650` — the widget redesign only dropped the button. Free material for the inline preview.

9. **Key verification needs no new dependency.** `src-tauri/Cargo.toml` already carries `ureq = "2"` (rustls TLS, added for the wake-word model download). The backend is WS-only on `:8787` with no HTTP route, so verification belongs in Rust, not the sidecar.

10. **`set_key` already restarts the sidecar** (`keys.rs`, `set_key` → `crate::backend::restart_backend`), so a key saved during onboarding is picked up from the sidecar env without a relaunch. `set_config` does **not** restart (only `debug` flips do) — correct, since provider ids travel on the per-session `start` frame.

11. **On-device inference is already in this build — reuse it.** P3's wake word ships `ort = "2.0.0-rc.13"` (feature `download-binaries`), `cpal`, and `wake.rs::ensure_models`, which **downloads model assets over `ureq` into a writable app-data dir on first enable** and runs three ONNX sessions locally (`p3-plan.md`, `platform/STATUS.md`). The local-model path in §5 is a second instance of a pattern this repo has already shipped and verified on the Mac — not a new capability class.

12. **Zero-key providers are already a supported shape — in the core, but not in the UI.** `fixture.stt.ts` declares `requiredKeys: string[] = []`, and both `assertKeys` / `assertCorrectionKeys` filter on `requiredKeys`, so an empty list passes. `server.ts:314-317` guards with `stt.requiredKeys[0] ? … : undefined`, so the backend needs no change to run a keyless provider. **But `settings.ts`'s `capabilityErrors()` asks `hasKey[config.sttProvider]` directly** — for a keyless id that is `undefined` ⇒ falsy ⇒ it would report *"STT 'local' needs undefined."* This is the single sharpest integration hazard in §5.

---

## 1. Design goals, as constraints

| Constraint | Target |
|---|---|
| Wall clock — external user, key in hand | **≤ 90s** |
| Wall clock — internal build, test key | **≤ 20s** |
| Wall clock — local models | **≤ 90s of user time**; the download runs after, in the background |
| Required actions | **1 paste + 2 permission clicks** |
| Screens | **3**, each independently skippable |
| Blocking steps | **0** — every screen can be passed |
| End state | **always** a working config, or an explicitly labelled degraded one |

Rules the implementation must obey (each maps to a defect in the current flow):

- **Never ask for two keys when one will do** — but always *offer* the second when it would unlock the product's differentiator.
- **Never re-open on launch after the user says "later."** (Today it re-opens forever — the main irritant.)
- **Never claim success and then fail at first dictation.** (Today's PyAI path does exactly this.)
- **Never make the user hunt for a "check again" button** — poll and self-advance.
- **Never show a choice the user can't evaluate.** "PyAI / Deepgram / OpenAI / Anthropic" is a vendor quiz; "paste a key" is not.
- **Never silently discard something the user typed.** A key pasted into the wrong role is a stop-and-explain, not a shrug.

---

## 2. Sources, roles, and the resolver

Verbatim needs **two roles filled** — speech-to-text and correction — and they are not symmetric: **STT is required, correction is optional.** The window therefore stops asking the user to pick a vendor and instead resolves whatever they give it.

### 2.1 Three sources

| Source | How it's chosen | Fills |
|---|---|---|
| **A cloud key** | Paste; vendor auto-detected (§2.3) | Whichever role(s) that vendor serves |
| **A second cloud key** | Inline slot for the role the first key doesn't cover (§2.4) | The remaining role |
| **Local models** | "Run it all on this Mac" card, rendered only when the runtime is present (§5) | **Both** roles, with no key at all |

### 2.2 The resolver

Single source of truth, implemented once and reused by the second-key path and by Settings.

| Input | Config patch written | Mode | What the user is told |
|---|---|---|---|
| **OpenAI** | `sttProvider: "openai"`, `correctionProvider: "openai"`, `correct: true`, `format: true` | `full` | "Fully set up." |
| **PyAI** (incl. test key) | `sttProvider: "pyai"`, `correct: false`, `format: false` | `raw` | "PyAI covers speech-to-text. Self-correction stays off until you add a cleanup key." |
| **Deepgram** | `sttProvider: "deepgram"`, `correct: false`, `format: false` | `raw` | same, with Deepgram named |
| **Anthropic** | *nothing yet* | `needStt` | "Anthropic does the cleanup. Verbatim also needs speech-to-text." → the speech slot appears **required** and gates Continue |
| **PyAI/Deepgram + a cleanup key** | `sttProvider: <first>`, `correctionProvider: <second>`, `correct: true`, `format: true` | `full` | "Fully set up — speech and cleanup both covered." |
| **Anthropic + a speech key** | `sttProvider: <second>`, `correctionProvider: "anthropic"`, `correct: true`, `format: true` | `full` | "Fully set up." |
| **Local** | `sttProvider: "local"`, `correctionProvider: "local"`, `correct: true`, `format: true` | `local` | "Everything runs on this Mac. Nothing you say leaves the machine." |

Three invariants:

- **Never write a provider id that its registry can't resolve.** `raw` mode deliberately leaves `correctionProvider` at its default (`"openai"`), which is valid-but-keyless — that path is silent (§0.3), whereas an invalid id banners (§0.4).
- **Never leave `correct`/`format` on without a correction capability** (a key *or* a local model). That combination is exactly today's failure.
- **Never enable a role the source can't serve.** Role capability is checked before anything is saved, in both slots.

### 2.3 Vendor detection

| Pattern | Vendor |
|---|---|
| `^sk-ant-` | Anthropic |
| `^sk-` | OpenAI |
| `^[0-9a-f]{32,48}$` | Deepgram |
| else, length ≥ 8 | PyAI |

Detection is a **hint**, surfaced as an editable chip ("Detected: OpenAI ▾"). Verification (§4) is the actual gate. PyAI's real key shape is an open item (§9) — until confirmed it is the catch-all, which is also the safest default given PyAI is the house STT vendor.

### 2.4 The second-role key — inline, and only when it's useful

The slot is **the same control in both directions**; only its requirement level changes.

| First key covers | Slot | Label | Continue |
|---|---|---|---|
| Speech only (PyAI, Deepgram) | **Collapsed** one-liner: `+ Add a cleanup key for self-correction — optional` | *optional · OpenAI or Anthropic* | Enabled; skipping is free |
| Cleanup only (Anthropic) | **Expanded, always shown** | *required · PyAI, Deepgram or OpenAI* | **Disabled** until satisfied |
| Both (OpenAI) | Not shown | — | Enabled |

Design decisions inside the slot:

- **Role-aware validation, not just key-shape validation.** A Deepgram key pasted into the cleanup slot reports *"Deepgram can't do cleanup. Use OpenAI or Anthropic"* and **blocks Continue** — because silently dropping what the user just typed is worse than stopping them. The same key in the speech slot is accepted, since Deepgram *is* an STT vendor.
- **The first key's chip keeps describing the first key** ("speech-to-text only"), while the headline reflects the *combined* result ("Fully set up — speech and cleanup both covered"). Two different facts; two different places.
- **The preview yields the space.** Once a first key is detected, the animated preview and its caption are dropped from the layout — they have done their job, and the room goes to the second slot. This is what keeps a two-key setup inside one 566px window.
- **Both keys are stored through the existing `set_key`**, so each one restarts the sidecar with the new env (§0.10). Sequence them; don't fire two restarts in parallel.

---

## 3. The three screens

Full visual spec, every state, all three sources: [`onboarding-prototype.html`](./onboarding-prototype.html). Window grows from **440×480 to 440×566** — Connect is the tallest screen.

### Screen 1 — Connect (≈40s; ≈5s internal; ≈45s local)

- **Inline animated preview** at the top (`mode:"demo"`, §0.8): `send it by ~~8 pm no no make it~~ 9 pm tomorrow`, looping. Teaches "visible correction" in ~4s and costs **zero clicks**. Collapses once a key lands (§2.4).
- **One key field**, autofocused, `Enter` submits, masked with a reveal toggle, editable detected-vendor chip.
- **The second-role slot** per §2.4.
- **"Run it all on this Mac"** card — only when the local runtime is present (§5).
- **"I don't have a key yet"** replaces the view (not an accordion — it overflowed the window) with four rows: vendor, one-line role, direct link; OpenAI flagged **1 key = all**.
- **Internal builds only:** "Use the Saaslabs test key" (§7), sub-labelled *"PyAI speech-to-text · shared quota · adds no cleanup key."*
- **BYOK trust line:** "Stored in your macOS keychain. Sent only to the vendor you picked — never to us."
- **"Set up later"** — a quiet text link, and it means *later* (§6).

### Screen 2 — Permissions (≈30s)

- **Microphone** — prompted **in this window** via `getUserMedia`, tracks stopped immediately. TCC is per-bundle, so this is the same grant the overlay needs. Denied ⇒ `open_mic_settings` + re-check.
- **Accessibility** — `ax_trusted` **polled every 1s while the screen is visible**; the row flips itself when the user returns from System Settings. Button calls `open_accessibility_settings`.
- Copy states the cost of skipping honestly: *"Without it, your text is copied to the clipboard instead."*
- `Continue` is **never disabled**; it relabels to `Continue anyway` while a row is unmet.
- **The disclosure strip adapts to the mode:** amber *"Self-correction is off"* for `raw`; green *"Fully local — nothing you say leaves this Mac"* plus a slim download-progress row for `local`; nothing for `full`.
- Out of scope: Input Monitoring — it gates only Fn push-to-talk (`fnkey.rs`), which is opt-in in Settings.

### Screen 3 — Try it (≈20s)

- "Hold **⌥Space** and say something" — **hotkey label read from `config.hotkey`**, never hardcoded (today's `tray.rs:12` hardcodes it).
- A real focused field in the window receives the dictation: live transcript → strike-through reveal → inserted text. One successful use of the hotkey before the window closes — the moment that converts setup into a habit, and a full end-to-end self-test (mic → STT → correction → injection).
- **Local, still downloading:** the screen says exactly that — *"Waiting on the local model — 71%"* with the progress bar and *"You can finish here and try it when the download lands."* Never a mysterious failure.
- Fallback if injection into our own window proves unreliable (§9): render the result in-window without injection; the hotkey lesson survives.
- Skippable. Nothing here gates a working install.

---

## 4. Key verification

One authenticated GET in Rust via `ureq` (§0.9), 2s timeout, on `Continue`. Skipped entirely for keyless sources.

| Vendor | Probe | Header |
|---|---|---|
| OpenAI | `GET https://api.openai.com/v1/models` | `Authorization: Bearer <key>` |
| Anthropic | `GET https://api.anthropic.com/v1/models` | `x-api-key`, `anthropic-version` |
| Deepgram | `GET https://api.deepgram.com/v1/auth/token` | `Authorization: Token <key>` |
| PyAI | cheapest authenticated GET — **open item (§9)** | per `../architecture/vendor-apis.md` |

Verdicts: `200` ⇒ valid · `401`/`403` ⇒ **reject in-window** ("OpenAI rejected this key") · timeout/DNS/offline ⇒ **save anyway**, chip reads "couldn't reach <vendor> — saved anyway". A network failure must never look like a bad key.

New command: `key_verify(vendor, secret) -> Result<VerifyOutcome, String>` where `VerifyOutcome = { ok: bool, reachable: bool }`. The secret is passed in and **never logged**; on success the existing `set_key` stores it. Both slots use the same command.

---

## 5. Local models — the key-free path

**Decision:** local covers **both roles**, so it is a genuine no-key install rather than half a setup. **It is designed now and rendered only when available** — the layout treats "source" as key-or-local from day one, but the card appears only when a capability check says the runtime and catalog are present. Today's builds therefore show **no dead end and no "coming soon" promise**, and nothing needs re-laying-out when local ships.

### 5.1 The capability gate

`local_runtime_available() -> bool` — true only when the inference runtime is linked **and** the model catalog is reachable. Same structural discipline as the test key (§7): the UI asks a command, and a build without the capability answers `false`. No config flag, no user-visible toggle for a thing that can't work.

### 5.2 The model store — reuse P3's machinery

`wake.rs::ensure_models` is the precedent (§0.11): resolve an app-data dir, download assets over `ureq`, verify, cache, and never ship weights in the bundle. The local path adds a second catalog with the same shape.

| Role | Prototype default | Size | Alternative |
|---|---|---|---|
| Speech | Whisper small (English) | 466 MB | Whisper medium (multilingual), 1.5 GB |
| Cleanup | Qwen2.5 1.5B Instruct | 940 MB | Llama 3.2 3B Instruct, 1.9 GB |

Sizes and names in the prototype are **placeholders pending the stack decision (§9)** — but the *shape* of the screen (per-role picker, per-model size, total, disk requirement, download-once note) is the deliverable.

### 5.3 Download UX — moved off the critical path, not hidden

- The total is shown **before** anything downloads. Sizes are the honest cost of this option and the user gets to see it.
- `Download & continue` starts the fetch and **immediately advances** to permissions. Setup finishes while bytes land.
- Progress appears in three places: the local sub-screen, a slim row on Screen 2, and Screen 3's waiting state. Also worth a menu-bar affordance after onboarding closes.
- **Dictation is gated on model presence, with a named reason** — never a generic error. If the user also entered a key, prefer the key until local is ready, then switch.
- Resumable / re-runnable: a half-finished download must not brick the source. Falling back to "use a key instead" is always one click.

### 5.4 What must change outside the widget

| Where | Change | Why |
|---|---|---|
| `packages/core/src/providers/registry.ts` | add `local` STT adapter, `requiredKeys: []` | so `getSTTProvider("local")` resolves |
| `packages/core/src/correction/registry.ts` | add `local` correction adapter, `requiredKeys: []` | so `getCorrectionProvider("local")` resolves — **and the §0.4 fallback never fires** |
| `apps/widget/src/settings.ts` | `capabilityErrors()` must treat **zero-key providers** as satisfied, and stop indexing `VENDOR_ENV` blindly | else it reports *"STT 'local' needs undefined"* (§0.12) |
| `apps/widget/settings.html` | `local` option in both provider selects; a Models section (installed, size, delete, re-download) | so the choice is reversible after onboarding |
| `apps/widget/src-tauri/src/backend.rs` env injection | pass the model dir, not a key | the sidecar needs to find weights |
| `server.ts` | no change for the key check (§0.12) | `requiredKeys[0] ? … : undefined` already handles it |

### 5.5 The privacy claim is the point — so it has to be true

"Nothing you say leaves this Mac" is the strongest sentence in the product, and it must hold literally: no vendor call, and **no network at dictation time**. Telemetry stays off by default and content-free regardless (`telemetry.ts`), and the local path must not quietly re-enable a cloud correction fallback when a local generation fails. Fail visibly, or fall back to **raw** — never to a vendor the user didn't choose.

---

## 6. Re-entry: the anti-nag state machine

Add **one** field to `AppConfig` (`config.rs`). Per the file's own warning, the container-level `#[serde(rename_all = "camelCase", default)]` covers migration **provided the `Default` impl gains a matching entry**.

| Field (Rust / TS) | Type | Default |
|---|---|---|
| `setup_state` / `setupState` | `String` — `"unseen" \| "skipped" \| "done"` | `"unseen"` |

| State | Auto-opens at launch? | How the user gets back in |
|---|---|---|
| `"unseen"` **and** `!any_vendor_key_saved` | Yes | — |
| `"skipped"` | **Never** | Tray → **"Finish setup…"**; a dismissible chip in the app window; and the first dictation attempt swaps the raw `Provider 'pyai' needs PYAI_API_KEY` banner for *"Verbatim isn't set up yet"* + **Finish setup** |
| `"done"` | Never | Tray item hidden |

`any_vendor_key_saved` (`keys.rs`) stays as the self-healing guard on `"unseen"` — **and must learn about local models**, or a fully-local user with no keys gets onboarding on every launch. Rename the concept to "is any source configured": any vendor key **or** a complete local model set.

**Exit path — and the activation-policy fix.** Both buttons stop calling `getCurrentWindow().hide()` directly and instead invoke a new `finish_onboarding(state)` command that (a) writes `setup_state`, (b) hides the window, and (c) reverts the activation policy via `window::desired_activation_policy(read_config(app).dock_icon)` — closing the leak in §0.6.

---

## 7. The PyAI test key — build-time, internal builds only

Compile-time, so absence in public builds is **structural rather than a flag someone can flip**:

```rust
// apps/widget/src-tauri/src/testkey.rs
const TEST_KEY: Option<&str> = option_env!("VERBATIM_PYAI_TEST_KEY");

#[tauri::command]
pub fn test_key_available() -> bool { TEST_KEY.is_some() }

#[tauri::command]
pub fn use_test_key(app: tauri::AppHandle) -> Result<(), String> {
    let k = TEST_KEY.ok_or("no test key in this build")?;
    crate::secrets::secret_set(&app, "PYAI_API_KEY", k)?;   // renderer never sees the string
    crate::backend::restart_backend(&app);
    Ok(())                                                   // caller then applies the `raw` resolver patch
}
```

The public release job simply doesn't hold the secret ⇒ `option_env!` is `None` ⇒ `test_key_available()` is `false` ⇒ the button cannot render.

**Guardrails, in priority order:**

1. **A dedicated, quota-capped, rotatable key** — never a personal or production key. The key pasted during early development **must be rotated first** (already an open security item in `STATUS.md`); the new one becomes the test key.
2. **Never in `.env`, git, or CI logs.** It exists only as an env var on the internal build command.
3. **Release CI asserts absence:** build public artifacts in a secret-less job, plus a hard gate — `strings Verbatim.app/Contents/MacOS/verbatim-widget | grep -q '<prefix>' && exit 1`.
4. **Watermark internal builds** (window title / About) so a leaked `.app` is identifiable.
5. **Threat model, stated plainly:** anyone holding the internal `.app` can recover the key with `strings`. Acceptable **only** for a low-quota key that can be rotated on ten minutes' notice. If that ever stops being acceptable, a runtime-minted short-lived token is the answer — and this design is forward-compatible with it, because the UI contract is only `test_key_available()` / `use_test_key()`.

**Honest wrinkle:** the test key is PyAI, and PyAI is STT-only, so one click yields **raw dictation without self-correction** — the sub-label says so, and the optional cleanup slot (§2.4) is right there for anyone who wants the full effect.

---

## 8. Implementation phases

Cloud-verifiable = `npm run typecheck`, `npm test`, static review. **Mac-verify** = `cargo build` + `npm run widget` (Rust cannot be compiled in a cloud session).

✅ = implemented 18 Aug 2026 (code authored + typecheck/static gates green; **no phase below has been compiled or run on a Mac** — see §12). ⬜ = not started.

| Phase | Scope | Files | Verify |
|---|---|---|---|
| ⬜ **O0 — Decisions & probes** | Close the probes in §9 before building on them. | `experiments/scripts/probe_hear_caps.py` (extend) | Mac only (network + AX) |
| ✅ **O1 — Resolver + Screen 1 + second-role slot** | Detection, editable chip, resolver, **inline second-key slot with role-aware validation**, helper view, trust line, `Enter`/autofocus/reveal, inline demo preview. Delete `VENDOR_CAPABILITIES`. | `apps/widget/onboarding.html`, `src/onboarding.ts`, `src/onboarding.css` | typecheck; unit-test the resolver + detector + role gate; Mac click-through |
| ✅ **O2 — Key verification** | `key_verify` via `ureq`; per-vendor probes; offline ⇒ save-anyway; used by both slots. | `src-tauri/src/keys.rs` (or new `verify.rs`), `main.rs` handler list | **Mac-verify** + one live 401 per vendor |
| ✅ **O3 — Screen 2** | Mic prompt in-window; AX poll loop; mode-aware disclosure strip; `Continue anyway`. | `onboarding.*` (reuses `system.rs` commands as-is) | typecheck; **Mac-verify** the AX flip (§9) |
| ✅ **O4 — Screen 3** | Hotkey label from config; live try-it field; strike-through reveal; skip path. | `onboarding.*`, small seam in `src/main.ts` | **Mac-verify** injection into our own window (§9) |
| ✅ **O5 — `setup_state` + anti-nag** | Config field + `Default`; `finish_onboarding` (writes state, hides, **reverts activation policy**); tray "Finish setup…"; not-set-up banner replacing the raw provider error. | `src-tauri/src/config.rs`, `window.rs`, `tray.rs`, `main.rs`, `src/main.ts` | **Mac-verify**: Dock icon does not persist; skip ⇒ no re-open next launch |
| ✅ **O6 — Test key** | `testkey.rs`, two commands, internal-only button, absence gate, internal watermark. **Correction:** the absence gate shipped as `scripts/assert-no-test-key.sh`, a **release-checklist step, not a CI job** — `.github/workflows/ci.yml` has no macOS runner, so there is nothing to run `strings` on a `.app` in CI today. | `src-tauri/src/testkey.rs`, `main.rs`, `onboarding.ts`, `scripts/assert-no-test-key.sh` | **Mac-verify** both variants; CI gate must fail a deliberately-poisoned build |
| ◐ **O7 — Docs ✅ / exit demo ⬜** | README Quick start / Configuration rewritten around first run; `STATUS.md` refreshed (it predates onboarding and still reads M4/M5-in-progress at v1.0.0); this plan marked done. | `README.md`, `docs/product/STATUS.md`, this file | Exit demo below |
| ⬜ **O8 — Local path** *(gated on the §9 stack decision; ships dark until then)* | `local_runtime_available()`; model catalog + `ensure_local_models` mirroring `wake.rs`; the local sub-screen + progress surfaces; `local` adapters in both core registries; the `capabilityErrors` zero-key fix; Settings Models section + switch-back; `any_vendor_key_saved` → "any source configured". | `packages/core/src/providers/*`, `correction/*`, `src-tauri/src/` (new `localmodels.rs`), `settings.*`, `onboarding.*` | core adapters unit-testable in cloud; **everything else Mac-verify** |

**Also fix while in the neighbourhood (small, and they mask this feature's bugs):** — ✅ **both done**, 18 Aug 2026.

- ✅ `settings.ts` `capabilityErrors()` now asserts the configured provider id is **registered** (§0.5) *and* treats a zero-key provider as satisfied (§0.12) — one `roleErrors()` helper, both fixes, existing message wording preserved. Settings additionally renders an unresolvable id as a selected, disabled `<id> (unavailable)` option instead of a blank field. **Note:** the zero-key half was listed under O8 in the table above; it landed early, which is what makes O8 possible without touching Settings again.
- ✅ `tray.rs` reads `config.hotkey` through a private `hotkey_glyph` mirroring `settings.ts`'s `describeHotkey`; no literal `⌥Space` is rendered anywhere in the app.

### Exit criteria (the O7 demo, on the Mac; 11–12 land with O8)

**None of these have been run.** The pipeline that implemented O1–O7 had no macOS runtime and no Rust compiler; criteria 1–10 are the Mac session's checklist, unchanged. Criterion 2 should be run for the **second** key as well as the first — see §12's open defects.

1. Fresh profile (`clear_config` + delete keys) ⇒ onboarding opens automatically.
2. Paste a **wrong** OpenAI key ⇒ rejected **in the window**, no advance.
3. Paste a good key ⇒ verified, advanced; mic prompt raised **in-window**; AX row flips **without a manual re-check** after toggling in System Settings.
4. Screen 3: one ⌥Space hold produces corrected text in the field.
5. Done ⇒ window hides, **no Dock icon appears**, and `settings.json` shows `setupState: "done"` with a resolvable provider pair.
6. **PyAI-only** key ⇒ finishes, dictation works raw, amber strip shown, **no error banner** on first dictation.
7. **PyAI + Anthropic** via the optional slot ⇒ `settings.json` shows `stt=pyai · correction=anthropic`, `correct`/`format` on, and the first dictation shows a real correction diff.
8. **Anthropic first** ⇒ Continue stays disabled until a speech key is added; a Deepgram key in the *cleanup* slot is refused with a role message, and the same key in the *speech* slot is accepted.
9. **Set up later** ⇒ relaunch shows **no** onboarding; tray shows "Finish setup…"; first ⌥Space shows the friendly not-set-up banner.
10. Internal build: test-key button one-click ⇒ same as (6). Public build: button absent; CI absence gate green.
11. **Local:** card absent on a build without the runtime; present with it. Choosing local completes setup **while models download**, Screen 3 names what it's waiting for, and dictation works with **Wi-Fi off** once the download lands.
12. **Local:** Settings shows no capability errors with `stt=local · correction=local` and zero keys saved, and switching back to a cloud key (and back again) works without a relaunch.

---

## 9. Open items

| # | Item | Why it blocks | Where |
|---|---|---|---|
| 1 | **PyAI key prefix + cheapest authenticated GET** | §2.3 detection and §4 verification both guess today. Cloud sessions can't reach `api.pyai.com` (proxy 403). | Mac probe; record in `../research/pyai-api-findings.md` |
| 2 | **Does `AXIsProcessTrusted()` flip live for a running app, or is a relaunch required?** | If relaunch: Screen 2 needs a "Relaunch Verbatim" button instead of a self-flipping row. | Mac; `axinject.rs:285` |
| 3 | **Can dictation inject into the onboarding window's own field while Verbatim is frontmost?** | Decides Screen 3's primary design vs the fallback. `a64deaa` fixed a hang in this situation, so it's plausible but unproven. | Mac; `axinject.rs` routing |
| 4 | **Product call: is OpenAI presented as the single-key option for external users?** | It is the only *cloud* key that fills both roles. Keeping "PyAI — Recommended" front-and-centre sends a stranger down the STT-only path by default. Proposal: the *detected* vendor leads, the helper view flags OpenAI as "1 key = all", and PyAI stays the default STT + stress-test target in config. | Owner |
| 5 | **Where does local inference run — Rust host or Node sidecar?** The biggest fork in §5. The sidecar keeps `packages/core`'s provider abstraction intact (a `local` adapter talking to a native addon or a loopback server); the Rust host reuses the already-shipped `ort`/`cpal` machinery (§0.11) but puts a provider outside `core`, against the repo's own rule. | Decides O8's file list entirely | Owner + a Mac spike |
| 6 | **Which local stack?** Speech (whisper.cpp / Parakeet / MLX) and cleanup (a small instruct model, quantised). Determines sizes, first-token latency, and whether Intel Macs are supported at all. | §5.2's catalog is placeholder until this lands | Owner + spike |
| 7 | **Model licensing for an MIT repo.** Weights are downloaded, never bundled — but the licence still has to be surfaced and compatible. Whisper (MIT) and Qwen2.5 (Apache-2.0) are clean; Llama's community licence carries conditions. | A licence footgun in a public v1.0 | Owner |
| 8 | **Disk + hardware disclosure.** The prototype asserts "Apple silicon · ~2.2 GB free disk". Both numbers need confirming, and the copy must not promise Intel support we don't have. | §5.2's requirements row | Spike |

---

## 10. Defects this retires

Each row was verified against the live code on 18 Aug 2026. **Status as of the O1–O7 build:** every row's fix is now **written**, and rows 1, 2, 3, 8, 9, 10 and 11 are also *verifiable without a Mac* (they are resolver, Settings, or docs behaviour — the resolver truth table and the typecheck cover them). Rows 4 (Dock icon), 5 (permissions), 6 ("you're set" moment) and 7 (key verification) depend on macOS APIs and are **retired in code, unverified** — see §12.

| # | Defect today | Retired by |
|---|---|---|
| 1 | PyAI (the default, "Recommended") writes `correctionProvider: "pyai"`, which no registry resolves | §2.2 resolver (O1) |
| 2 | Three of four vendor buttons finish onboarding in a config that cannot dictate | §2.2 resolver + §2.4 slot (O1) |
| 3 | Settings then shows a blank correction dropdown and **zero** capability errors | O1 + the `capabilityErrors` registry/zero-key fix (O7/O8 side-fix) |
| 4 | Dock icon leaks on for the rest of the first-run session (`hide()` never fires `CloseRequested`) | `finish_onboarding` (O5) |
| 5 | No permissions step — mic and AX are discovered via a mid-dictation banner | Screen 2 (O3) |
| 6 | No "you're set — press ⌥Space" moment; the window just vanishes | Screen 3 (O4) |
| 7 | Any non-empty string is accepted as a key; failure surfaces minutes later | `key_verify` (O2) |
| 8 | `Enter` doesn't submit, no autofocus, no reveal, no key links, vendor buttons aren't a radiogroup, real errors swallowed into one generic string | O1 |
| 9 | Skipping re-prompts on **every** launch | `setup_state` + tray/banner (O5) |
| 10 | No way to reach the product's differentiator with a PyAI/Deepgram key without finding Settings | §2.4 optional cleanup slot (O1) |
| 11 | Onboarding is undocumented — README mentions it only inside the repo-layout tree | O7 |

---

## 11. Out of scope

- Windows onboarding (M6) — this is macOS-first, though nothing here is macOS-only except the permissions screen.
- Runtime-minted test tokens (§7 guardrail 5) — designed for, not built.
- Meetings / command-mode / wake-word onboarding — separate surfaces, separate gates.
- A settings *import* path (bring an existing `.env`) — worth considering for developers, deliberately not in the 2-minute path.
- Local **TTS** and local wake-word model management — P3 already owns its own model store; unifying the two catalogs is a follow-up, not a prerequisite.

---

## 12. What the implementation changed about this plan (18 Aug 2026)

O1–O7 were built by three parallel agents against [`../onboarding/implementation-plan.md`](../onboarding/implementation-plan.md), then reviewed independently ([`../onboarding/review.md`](../onboarding/review.md)). Per-agent detail: [`progress-dev-a.md`](../onboarding/progress-dev-a.md) (webview), [`progress-dev-b.md`](../onboarding/progress-dev-b.md) (Rust host), [`progress-dev-c.md`](../onboarding/progress-dev-c.md) (Settings + overlay seams).

**What was verified, and what that is worth.** `npm run typecheck --workspace @verbatim/widget` green; the resolver executed against an independently-written truth table (88 assertions over every row of the resolution/detection/slot tables plus the five invariants); all six `.rs` files parse under a real `rustfmt`; the `ureq` 2.12.1 and `tauri-macros` 2.6.3 APIs the new Rust uses were read against the actual crate sources; the command contract cross-checked mechanically (52 handler entries, no duplicates, every JS `invoke` name resolved); 47/47 microcopy strings matched verbatim. **What none of that covers:** nothing was compiled, borrow-checked, rendered, or run. Every claim of *working* in this document is still pending the Mac.

### Corrections the build forced on this design

| § | This document said | What is actually true |
|---|---|---|
| §3 / §0.1 | The onboarding window is 440×480. | Fixed at 440×**566** for all three screens. Screen 1 with a required second slot plus an error line does not fit 480, and the window is `resizable: false`, so a runtime `setSize` would be a per-macOS-version gamble. |
| §4 | "Key verification needs no new dependency" (`ureq` is already in `Cargo.toml`). | True of the dependency, false of its *placement*: `ureq` sat in the macOS-only target table, and `mod verify;` is unconditional, so `Cargo.toml` had to be edited to move `ureq = "2"` to top-level `[dependencies]`. The build plan's do-not-touch list was wrong on this one file. |
| §4 / §9 #1 | Per-vendor probes verify the pasted key. | Three vendors do. **`pyai` never verifies** — no cheap authenticated GET is known (§9 #1 is still open), so `key_verify("pyai")` returns `{ok: true, reachable: false}` and takes the "saved anyway" path by construction. |
| §3 (Screen 3) / §9 #3 | Screen 3 shows the dictation landing in a real field, with the in-window box as a fallback. | The fallback **is** the implementation. The overlay broadcasts a `dictation-progress` event (`live` / `correction` / `final`) and the try-it box renders from it, so the screen works whether or not AX injection can reach our own window. Whether it *also* injects is now a bonus to observe on the Mac, not a dependency. |
| §6 | On a first dictation the overlay swaps the raw provider error for *"Verbatim isn't set up yet"* whenever `setup_state` is `"skipped"`. | The flag alone is not enough: nothing ever rewrites `"skipped"`, so a user who skipped and *then* configured keys in Settings would keep losing their first real error of every launch — including its **Copy details** and log path — to a nudge that no longer applies. The overlay now also confirms, from `get_config` + `has_key`, that no speech source exists; if one does, the real error wins. Also shown at most once per launch. |
| §6 | `any_vendor_key_saved` "must learn about local models". | Untouched, deliberately. It only matters once a keyless local source exists, so it is O8 work; nothing in O1–O7 writes a keyless provider id. |
| §7 (trust line) | *"Stored in your macOS keychain. Sent only to the vendor you picked — never to us."* | The second sentence is accurate. The first is **not accurate for a default build**: `key_storage` defaults to `"local"`, a `0600` `secrets.json` in the app config dir (`secrets.rs:9`); the keychain is the non-default branch. Either the copy or the default has to change before public release. Unfixed. |
| §0.6 (Dock icon) | Fixed by routing both exits through `finish_onboarding`. | Implemented exactly as specified, and no JS in `onboarding.ts` hides the window any more. But `ActivationPolicy` is a real AppKit call — this is code-provable, **not verified**. |

### Known defects in the new code, not yet fixed

Full detail, with reproduction, in [`../onboarding/review.md`](../onboarding/review.md) §2.

1. **major** — a 401/403 on the **second** key is reported against the **first** vendor, and reddens the first field. A good speech key plus a mistyped cleanup key sends the user to edit the wrong field, with nothing on screen pointing at the real one.
2. `scripts/assert-no-test-key.sh` greps the key prefix as a **regex** instead of a literal (`grep -q`, needs `-qF`). A metacharacter in the prefix makes the secret gate fail **open** — the one direction it must not fail.
3. The *"Couldn't reach `<Vendor>` — saved anyway"* chip is never painted on the advancing path, so an unverified key can look verified. This is the `pyai` path **always**, by (1) above.
4. `sanitizeCorrection(cfg.correctionProvider ?? "")` conflates "unknown" with "invalid": if the boot `get_config` fails, a valid stored `anthropic` can be silently downgraded to `openai`.
5. The trust-line/keychain mismatch in the table above.

### Still open, unchanged

§9's items 1–8 all stand. #1 (PyAI key prefix + probe), #2 (does `AXIsProcessTrusted()` flip live), #3 (injection into our own window) are Mac probes that O1–O7 was written to survive either answer of. #4 (is OpenAI the headline single-key option) is answered *in behaviour* — the detected vendor leads, and the helper view flags OpenAI as "1 key = all" — but not as a positioning decision. #5–#8 gate **O8**, which is why O8 is untouched: no `local` provider id, no local card, no dead end in the UI.
