# First-Run Onboarding — Test Plan (run this on the Mac)

**Why this file exists:** the implementation pipeline ran from a Linux VM with the repo mounted. It could typecheck TS, execute the resolver, and parse the Rust — it could **not** run `cargo`, `vitest`, or anything needing a macOS runtime. So every behavioural claim about this feature is **unverified until you run the steps below**. Nothing here has been tested on macOS.

Companion docs: `implementation-plan.md` (what was built) · `review.md` (independent audit, 1 major + 5 minor found, all addressed) · `progress-dev-{a,b,c}.md` (per-agent detail, incl. DEV-B's self-review of uncompiled Rust) · `../product/onboarding-plan.md` (design of record).

---

## 0. Before anything

```bash
cd ~/Claude/shuuuu/verbatim
rm -f .git/index.lock          # stray lock from a cloud-session `git status`
git status --short             # expect: modified widget TS/Rust + new docs/onboarding/*
git diff --stat
```

Read the diff before building. Nothing was committed — the tree is your only record, and `git checkout -- <file>` is your undo.

## 1. Static gates (seconds, no build)

```bash
npm run typecheck --workspace @verbatim/widget  # OUR gate; expect no output
npm run typecheck                              # whole repo — see the warning below
npm test                                        # core; see the warning below
sh scripts/assert-no-test-key.sh --self-test    # expect: OK(self-test)
```

> **Both of these were red before this work, for reasons unrelated to onboarding. They are now fixed
> and verified green** — see §1a. `packages/core` is the only place that changed for this.

**Expected results:** `npm run typecheck` → clean across all four workspaces. `npm test` → **30 files,
276 tests, 0 failures.** The self-test → `OK(self-test)`. If `npm test` reports 266 tests you are on the
pre-fix tree.

### 1a. What was wrong with those two gates (fixed 18 Aug 2026)

Both failures traced to `f484096` — the same commit that caused the onboarding bug by removing PyAI as a
correction vendor without updating anything downstream.

| Was failing | Root cause | Fix |
|---|---|---|
| `src/providers/pyai.integration.test.ts` — whole suite failed to **load** | It imported `../correction/pyai`, deleted in `f484096`. Because the file never loaded, its **7 PyAiSTT tests had been silently skipped since 14 Aug** — the suite looked "28 passed" while a chunk of PyAI STT coverage wasn't running at all. | Removed the dangling import, the three `PyAiCorrection` describes, and their `mockMessagesServer` helper. All PyAiSTT coverage kept, including the full-Pipeline test (it uses `MockCorrection`, not the deleted adapter). 370 → 245 lines. |
| `src/correction/prompt.test.ts` — *"appends glossary block when entries provided"*, `TypeError: t.trim is not a function` at `prompt.ts:81` | **Not a stale test — a missing feature.** The glossary half of `vocabulary/` (types, `learn.ts`, eval harness, and the glossary line already in `SYSTEM_PROMPT`) landed, but `vocabularyNote()` still assumed `string[]` and called `t.trim()` on whatever it got. Passing a `GlossaryEntry` **threw from inside `userMessage()`** — a crash on the correction path, not a type-only problem. | Implemented the block: `vocabularyNote` now accepts `string \| GlossaryEntry`, renders "Known terms" for strings and a `User glossary` block with aliases for entries. The string path is **byte-identical** (locked by a new test), so no live prompt changes. |

Also added: 3 regression tests in `prompt.test.ts` covering byte-identity of the string path, mixed
string+entry input with no empty bullets, and entry-only input not throwing.

**Still not wired (deliberately out of scope):** nothing sends glossary entries yet. The widget and backend
still send `string[]`, and the Rust `glossary_get`/`glossary_save` commands exist but are **not registered**
in `invoke_handler!`. The prompt layer is now ready for the feature; the wiring is a separate piece of work.

## 2. The first real compile

This is the step that has never happened. All of DEV-B's Rust is authored-but-uncompiled.

```bash
cd apps/widget/src-tauri
cargo build 2>&1 | tail -40
```

If it fails, the three likeliest sites are known and each has a fallback written up in `progress-dev-b.md`:

| Symptom | Where | Fallback |
|---|---|---|
| macro/async complaint on `key_verify` | `verify.rs`, `#[tauri::command(async)]` on a sync fn | drop `(async)`, keep the fn sync |
| unknown method / wrong error variant | `verify.rs`, `ureq` 2.x `AgentBuilder`/`set`/`Error::Status` | confirmed against `ureq 2.12.1`; check `Cargo.lock` if it disagrees |
| tray menu type error | `tray.rs`, `tray_by_id("main-tray")` → `set_menu`, `Vec<&dyn IsMenuItem<Wry>>` | rebuild the menu the way `tray::setup` already does |

## 3. Run it

```bash
cd ~/Claude/shuuuu/verbatim
npm run widget        # Tauri owns the backend; ⌥Space toggles dictation
```

## 4. Force a true first run

State lives **outside the repo**, in the app config dir for `co.saaslabs.verbatim.widget`:

```
~/Library/Application Support/co.saaslabs.verbatim.widget/
  settings.json    # config, incl. the new setupState
  secrets.json     # API keys, chmod 0600 — the DEFAULT backend
```

```bash
mkdir -p /tmp/verbatim-backup
mv ~/Library/Application\ Support/co.saaslabs.verbatim.widget/settings.json \
   ~/Library/Application\ Support/co.saaslabs.verbatim.widget/secrets.json \
   /tmp/verbatim-backup/ 2>/dev/null
```

Keep that backup — §6 restores it to prove you didn't break your working install. If you ever switched the hidden `key_storage` to `keychain`, also clear `security delete-generic-password -s co.saaslabs.verbatim`.

Relaunch. **Onboarding must open by itself.**

## 5. Scenario matrix

Each row maps to an exit criterion in `../product/onboarding-plan.md` §8.

| # | Do this | Expect | Proves |
|---|---|---|---|
| 1 | Launch with no `settings.json`/`secrets.json` | Onboarding opens unprompted, key field focused, preview animating | the gate + the window |
| 2 | Paste `sk-proj-notarealkey`, press Enter | Rejected **in the window**: "OpenAI rejected this key", field 1 red, no advance | `key_verify` really calls out |
| 3 | Paste a valid OpenAI key | Verifies (~1s), advances. `settings.json`: `sttProvider`+`correctionProvider` = `openai`, `correct`/`format` true | the one-key happy path |
| 4 | Fresh run, PyAI key only | Finishes. Screen 2 shows the **amber** "Self-correction is off". First dictation inserts raw text with **no error banner** | the raw-mode resolver — the bug that started all this |
| 5 | Fresh run, PyAI key, then expand **Add a cleanup key** and paste Anthropic | `stt=pyai · correction=anthropic`, `correct`/`format` true; first dictation shows a real strike-through diff | the optional second slot |
| 6 | Fresh run, **Anthropic first** | Continue **disabled**; a Deepgram key in the *cleanup* slot is refused naming the role; the same key in the *speech* slot is accepted | role-aware validation |
| 6b | In row 6, paste a **bad** Anthropic key as the second key | The error names **Anthropic** and reddens the **second** field — not the first | the one major review finding |
| 7 | Screen 2: click Allow | macOS mic prompt appears **from this window**; deny it once and confirm the deep-link path works | permissions moved off the dictation path |
| 7b | Screen 2: click Open Settings, toggle Accessibility, come back **without clicking anything** | The row flips to Granted on its own within ~1s | the poll loop (open item: may need a relaunch instead — if so, that's answer #2 in design-doc §9) |
| 8 | Screen 3: hold ⌥Space and speak | Transcript streams into the box, correction reveals, text lands | end-to-end self-test |
| 9 | Click Done | Window hides, **no Dock icon appears**, `settings.json` has `setupState: "done"` | the activation-policy leak fix |
| 10 | Fresh run → **Set up later** → relaunch | **No** onboarding; tray shows "Finish setup…"; first ⌥Space shows the friendly nudge with a working **Finish setup** button | the anti-nag machine |
| 10b | Configure properly, then trigger a real backend error (e.g. revoke the key) | You get the **raw** error with **Copy details** — not the setup nudge | DEV-C's nudge-suppression fix |
| 11 | Hand-edit `settings.json` → `"correctionProvider": "pyai"`, open Settings | "isn't a provider Verbatim can use"; the dropdown shows `pyai (unavailable)` selected | `capabilityErrors()` can no longer give a broken config a clean bill of health |
| 12 | `VERBATIM_PYAI_TEST_KEY=<key> npm run widget` | The internal test-key button appears; **without** the env var it is absent | the compile-time gate |
| 12b | On a release build: `VERBATIM_PYAI_TEST_KEY_PREFIX=<prefix> sh scripts/assert-no-test-key.sh /path/Verbatim.app` | OK for a public build; FAIL for one built with the key | the absence gate |

## 6. Regression sweep — restore your real profile first

```bash
mv /tmp/verbatim-backup/*.json ~/Library/Application\ Support/co.saaslabs.verbatim.widget/
```

Then confirm nothing that already worked broke:

- Overlay orb: ⌥Space dictation into a third-party app, injection lands, widget never steals focus, password fields still refused.
- Settings: hotkey capture, vocabulary, snippets, history, theme, provider dropdowns hydrate correctly.
- Tray: Show / Show Last Result / Settings / Quit — and **"Finish setup…" must NOT appear** on a configured profile.
- Open **and close** Settings: the app must not quit, and must not leave a Dock icon behind.

## 7. Where to look when something breaks

- Backend/provider errors, full text: `logs/errors.log` (path printed at startup; override with `PYAI_LOG_FILE`).
- Widget JS: the `tauri dev` window's web inspector.
- Rust `println!`/`eprintln!`: the terminal running `npm run widget`.
- The onboarding window is a real webview — right-click → Inspect Element works there too.

## 8. Known-unverifiable / open

- Whether `AXIsProcessTrusted()` flips live for a running app or needs a relaunch (design doc §9 #2) — row 7b answers it. If a relaunch is needed, the fix is one button in `onboarding.ts`.
- Whether dictation can inject into the onboarding window's own field while Verbatim is frontmost (§9 #3). Screen 3 was deliberately built to render from the event stream instead, so this is a bonus, not a dependency.
- PyAI key prefix + a cheap authenticated endpoint (§9 #1) — until then PyAI keys are the detection catch-all and always report "saved anyway" rather than verified.
- Local models (O8) — designed, deliberately not implemented; gated on §9 #5.
