# Onboarding pipeline — pre-Mac-build review

Reviewer pass over the DEV-A / DEV-B / DEV-C output, run on the Linux authoring VM plus a
container with a real Rust toolchain. Purpose: find what would waste a
`cargo build` + `npm run widget` round trip on the Mac. **No code was changed by this pass** —
this file is the only thing written.

Verdict: **no blockers. 1 major, 5 minor, 2 nits.** Ready for a Mac build attempt.

---

## 1. Gates run, and their verbatim results

### G1 — TypeScript typecheck (re-run, not trusted)

```
$ npm run typecheck --workspace @verbatim/widget

> @verbatim/widget@1.0.0 typecheck
> tsc --noEmit

```
Clean, no output.

### G2 — Resolver truth table (my own driver, not DEV-A's)

Written independently from `implementation-plan.md` §4.2/§4.3/§4.4/§4.5 and executed against
the real module. 88 explicit equality assertions (every row of the resolution table, every
`secondSlot` row, 14 detection cases including boundary lengths 31/32/48/49, 6
`sanitizeCorrection` cases, and the stale-`second` ignore rule for all 5 second values)
plus a 5x5 `first`x`second` sweep asserting invariants 1, 2, 3, 4 and 5 on every resolvable
combination.

```
$ node --experimental-strip-types /tmp/rev-resolver.mts
assertions: 88
resolver OK — all rows of 4.2/4.3/4.4/4.5 match the plan
EXIT=0
```

### G3 — Rust syntax gate (`rustfmt`, real parser)

The 6 Rust files were transferred to the container and **md5-verified byte-identical** to the
repo copies before being parsed (`device_stage_files` is blocked by the bridge on this
session, so the transfer was gzip+base64 with checksum confirmation).

```
verify.rs    OK (parses; already rustfmt-clean)
testkey.rs   OK (parses; already rustfmt-clean)
config.rs    parses OK (cosmetic diff only, 86 lines)
window.rs    OK (parses; already rustfmt-clean)
tray.rs      OK (parses; already rustfmt-clean)
main.rs      OK — 0 diff hunks, parses with all sibling mods resolved
```
`config.rs`'s 86-line diff is entirely trailing-comment column alignment at lines 23 / 115 /
236 — the file's pre-existing house style, which rustfmt would un-align. Not a defect.

**Limit of this gate, stated plainly:** `rustfmt` parses, it does not typecheck or borrow-check,
and it cannot see inside `tauri::generate_handler![...]` (an unexpanded macro token stream).
Types were checked by reading against real crate sources (G6/G7) rather than by compilation.

### G4 — Command contract cross-check (mechanical)

```
registered entries in invoke_handler: 52
duplicate entries: none
```
All five new commands are registered exactly once: `verify::key_verify`,
`testkey::test_key_available`, `testkey::use_test_key`, `window::finish_onboarding`,
`window::show_onboarding_window` (`main.rs:180-184`).

Argument-name mapping, JS call site -> Rust signature, each verified individually:

| JS | Rust | Verdict |
|---|---|---|
| `invoke("key_verify", { vendor, secret })` | `key_verify(vendor: String, secret: String)` | match |
| `invoke("finish_onboarding", { state })` | `finish_onboarding(app: AppHandle, state: String)` | match (`app` resolved by type, not name) |
| `invoke("show_onboarding_window")` | `show_onboarding_window(app: AppHandle)` | match |
| `invoke("test_key_available")` | `test_key_available() -> bool` | match |
| `invoke("use_test_key")` | `use_test_key(app: AppHandle)` | match |
| `invoke("set_key", { vendor, secret })` | `keys::set_key(app, vendor, secret)` | match, signature unchanged |
| `invoke("set_config", { patch })` | `config::set_config(app, patch: Value)` | match, signature unchanged |

Every `invoke()` name in `apps/widget/src/*.ts` resolves to a registered command **except the
two pre-existing `glossary_*` calls** — see finding 7; entry arithmetic proves DEV-B did not
delete them.

Event seams:
- `dictation-progress` — emitted `main.ts:644, 651, 660` (all three phases, unconditional,
  fire-and-forget); listened `onboarding.ts:602`. Payload types are structurally identical
  (`main.ts:86-89` vs `onboarding.ts:62-65`), including the `Op` shape. **Match.**
- `config-changed` — emitted `config.rs:204` / `:253` with the whole serialized `AppConfig`
  (camelCase), so `onboarding.ts:693`'s `{ theme?: string }` destructure resolves. **Match.**
- The onboarding webview label is in the capability window list
  (`capabilities/default.json:5` = `["main","settings","onboarding"]`), so `core:event:allow-listen`
  and `allow-emit` actually apply to it. `core:event` permissions present at lines 14-15.

### G5 — Microcopy fidelity vs plan §7

47 of 47 user-visible strings from the plan's table matched **verbatim** by literal
`grep -F`, across Screen 1, the "Where to get a key" view, Screen 2, Screen 3, and the
outside-the-window set (tray item, tray show item with two spaces, overlay nudge, internal
watermark). Zero drift. No literal `⌥Space` is rendered anywhere — the only occurrences are
inside the `PRESET_LABELS` glyph table, which is correct.

### G6 — `ureq` API verified against the crate source (closes DEV-B's own open risk R6/M1)

`Cargo.lock` contains two `ureq` majors (2.12.1 and 3.4.0); `verbatim-widget`'s dependency
list resolves to **`ureq 2.12.1`**, so the 2.x API is the right one. Downloaded
`ureq-2.12.1.crate` and confirmed every item `verify.rs` uses:

```
AgentBuilder::new()                     agent.rs:252
AgentBuilder::timeout(Duration) -> Self agent.rs:490
AgentBuilder::build() -> Agent          agent.rs:285
Agent::get(&self, &str) -> Request      agent.rs:188
Request::set(mut self,&str,&str)->Self  request.rs:310   (owned self: the format! temporary is not borrowed past the statement)
Request::call(self) -> Result<Response> request.rs:78
Error::Status(u16, Response)            error.rs:84
```
DEV-B's "**Not verified against the crate source**" caveat is now discharged. `verify.rs` compiles
against this API as written.

### G7 — Tauri macro semantics verified against `tauri-macros 2.6.3` source

- `#[tauri::command(async)]` on a **sync** fn (`verify.rs:89`) is valid: `async` is an accepted
  attribute (`src/command/wrapper.rs:112` lists `rename_all`, `rename`, `root`, `async`) and
  `wrapper.rs:264` maps `ExecutionContext::Async` + `asyncness.is_none()` to `"sync_threadpool"`
  — exactly the off-the-main-thread behaviour the plan's R6 asks for.
- `#[cfg(target_os = "macos")]` **inside** `generate_handler![...]` (`main.rs:185`) is supported:
  `src/command/handler.rs`'s `CommandDef::parse` calls `Attribute::parse_outer` before parsing
  the path, and `filter_unused_commands` keeps them. Pre-existing entry, unaffected by the five
  insertions above it.

### G8 — Release-script gate

```
$ bash -n scripts/assert-no-test-key.sh
  (no output — OK)
```

---

## 2. Findings, most severe first

| # | Severity | file:line | What is wrong | Concrete failure scenario | Owner |
|---|---|---|---|---|---|
| 1 | **major** | `apps/widget/src/onboarding.ts:488` (with `:227`, `:248`, `:254`) | A 401/403 on the **second** key sets the same single flag (`state.verify = "bad"`) the first key uses. Render then attributes the rejection to the **first** vendor: `vendorName` is `VENDORS[state.vendor].name` (`:248`), and `field1.el.classList.toggle("bad", state.verify === "bad")` (`:227`) reddens field **1**. `field2` only ever reddens for a *role* error (`:228`), never for a rejected key. | Paste a valid Deepgram key. Open the optional cleanup slot, paste an Anthropic key with one wrong character. Click Continue. `key_verify(deepgram)` returns ok; `key_verify(anthropic)` returns 401 -> screen says **"Deepgram rejected this key. Check it and paste again."** with the red border on the Deepgram field. The Deepgram key is fine. The user edits the wrong field; Continue keeps failing with the same wrong message and there is nothing on screen pointing at the Anthropic field. | DEV-A |
| 2 | minor | `scripts/assert-no-test-key.sh:51` | `grep -q "$VERBATIM_PYAI_TEST_KEY_PREFIX"` treats the prefix as a **regex**, not a literal. Should be `grep -qF`. | If the internal PyAI key's leading characters contain a regex metacharacter — e.g. a `+`, which base64-ish keys do carry — the pattern `ab+` requires a repeated `b` and will not match the literal `ab+cd` in `strings` output. The script prints `OK: no test key in …`, exit 0, and a **key-bearing artifact ships**. The gate fails open, which is the one direction a secret gate must not fail. | DEV-B |
| 3 | minor | `docs/product/STATUS.md`, `README.md`, `docs/product/onboarding-plan.md` (unmodified: mtimes 08-13 / 08-14 / 09:18-pre-pipeline) | Plan task **C6 was not done at all** — DEV-C self-reports it as out of its writable set. Plan §10 gates the definition of done on it. | The next session follows the project's own "read `docs/product/STATUS.md` first" convention and finds no mention of onboarding, `setup_state`, the five new commands, or the Mac-verification list — so it re-derives all of it, or worse, assumes the work is not started. `README.md` gains no onboarding section for contributors. | DEV-C |
| 4 | minor | `apps/widget/src/onboarding.ts:496` -> `:529` | `state.verify = "offline"` is assigned and then the flow runs straight into `enterScreen2()` with **no intervening `render()`**, so the plan's designated "Couldn't reach `<Vendor>` — saved anyway" chip (`:258`) is never painted on the advancing path. | A user on a flaky network (or any `pyai` key, which always takes the unreachable branch by design) pastes a key, sees no notice at all, and advances believing the key was confirmed by the vendor. The plan's §2.1 truth table specifically wants this shown so an unverified key is not mistaken for a verified one. Partially mitigated: the chip *does* appear if the user presses Back from Screen 2. | DEV-A |
| 5 | minor | `apps/widget/src/main.ts:683` | The nudge condition is `cfgSetupState !== "done"`, but `setup_state` is only ever written by `finish_onboarding`. A user who chose "Set up later" stays `"skipped"` **forever**, even after fully configuring the app in Settings — so the nudge stays armed for the life of that install. | User clicks "Set up later", then adds keys via Settings, then their config carries a stale `correctionProvider: "pyai"`. First dictation of a session: `NOT_SET_UP_RE` matches server.ts:309's "is invalid — using", so instead of the real error with **Copy details** and the log path (`:689-691`, suppressed by the `return` at `:686`) they get "Verbatim isn't set up yet. Add an API key and it'll start transcribing." plus a **Finish setup** button that reopens a window which cannot fix a bad `correctionProvider`. Self-limiting: once per launch, and the second dictation shows the real error. | DEV-C |
| 6 | minor | `apps/widget/src/onboarding.ts:462` | `sanitizeCorrection(cfg.correctionProvider ?? "")` conflates "**unknown**" with "**invalid**". When the boot `get_config` fails (`:701-703` swallows it, leaving `cfg = {}`), the `?? ""` feeds `""` to the repair, which returns `"openai"` and merges it into the raw patch — writing a value derived from no knowledge of what is stored. | Boot `get_config` fails transiently (window opened before the store is ready). User's stored `correctionProvider` is a valid `"anthropic"`. They run onboarding with a Deepgram key (raw path) -> `correctionProvider` is silently overwritten `anthropic` -> `openai`. Low blast radius (raw mode also writes `correct:false`, so correction is off either way), but it is a silent downgrade of a valid user setting on a path that is supposed to write nothing. Guarding on `typeof cfg.correctionProvider === "string"` is the fix. | DEV-A |
| 7 | minor **(pre-existing — NOT from this pipeline)** | `apps/widget/src-tauri/src/lists.rs:67` and `:72` vs `main.rs:131-187` | `glossary_get` and `glossary_save` are declared `#[tauri::command]` but are **not** in `invoke_handler`, while `settings.ts:977` and `:984` invoke them. | Opening the Settings "Names & Jargon" section rejects with *command glossary_get not found* and the glossary silently fails to load/save. **Explicitly cleared as not DEV-B's regression:** the plan recorded the pre-change list as `main.rs:121-172`; that block yields 47 entries (52 lines minus the two wrapper lines, two comments and one `cfg` attribute), and the current block yields exactly 52 = 47 + the 5 new commands. Nothing was dropped. Flagged only because you will hit it. | pre-existing / none of the three |
| 8 | nit | `apps/widget/src/onboarding.ts:67` | Comment cites "copied from settings.ts:432-449"; `PRESET_LABELS` + `describeHotkey` actually live at `settings.ts:473-490` (432-449 is now auto-detect-language code). The plan's own §5.1 reference was already stale and DEV-A copied it. | No behavioural risk — I diffed the two implementations and the copy is **byte-identical**, and `tray.rs:15-49`'s `hotkey_glyph` matches both (same 5 presets, same `Alt/Control/Shift/Meta|Super|Cmd` glyph map, same `Key`/`Digit` stripping). Only the pointer a future maintainer follows is wrong. | DEV-A |
| 9 | nit | `docs/onboarding/progress-dev-b.md:106` vs `:121-126` | The progress doc contradicts itself: line 106 says "I followed the plan (unconditional `mod`, **no `Cargo.toml` edit** — it is on the do-not-touch list)", lines 121-126 say `Cargo.toml` was lifted off that list and `ureq` moved. | Reading only the first statement, you would go to the Mac expecting an unmodified `Cargo.toml`. The **code is correct** (see divergences below); only the report is inconsistent. | DEV-B |

---

## 3. Verified correct — what I actually checked and cleared

**Contract integrity (plan §2)**
- All 5 new commands registered exactly once; 52 entries, zero duplicates.
- All 7 argument-name mappings correct. Every name is a single lowercase word, so the
  camelCase/snake_case hazard the plan warns about does not arise anywhere.
- `AppHandle` is injected by type in all four commands that take it — no name collision with
  the `state: String` parameter of `finish_onboarding` (Tauri resolves `tauri::State<T>` by
  type, and `state` is not a reserved payload key).
- `dictation-progress` and `config-changed` seams match in name *and* payload shape.
- `onboarding` present in the capability window list, with `core:event` listen/emit granted.
- Every other `invoke()` in the widget resolves, apart from pre-existing `glossary_*`.

**Rust that cannot compile here (plan §2.1, §8 R6)**
- All 6 files parse under `rustfmt --edition 2021`.
- `&AppHandle` vs `AppHandle` correct at every new call site: `secret_set(&app, …)`,
  `restart_backend(&app)`, `write_config(&app, &cfg)`, `refresh_menu(&app)`,
  `read_config(&app)`, `any_vendor_key_saved(app.handle())`, `watermark_title(app.handle())`
  — each checked against the callee's real signature.
- `TEST_KEY.ok_or("no test key in this build")?` converts `&str` -> `String` via
  `impl From<&str> for String`; the `?` is sound in a `Result<(), String>` body.
- `#[cfg]` gating leaves **nothing undefined on any target**: `desired_activation_policy` is
  macOS-only and every one of its 6 call sites sits inside a macOS-gated statement or fn
  (`window.rs:59, 147, 197, 224`; `config.rs:201, 248`). `refresh_menu` has both a
  `#[cfg(desktop)]` and a `#[cfg(not(desktop))]` definition, so `window.rs:202`'s
  unconditional call resolves on every target.
- `mod` declarations match files 1:1 — `verify.rs` and `testkey.rs` both exist and both are
  declared unconditionally (`main.rs:45, 48`).
- No macOS-only API is reached from a non-gated module. `verify.rs` and `testkey.rs` are
  fully portable.
- `ureq` is **not** target-gated any more (`Cargo.toml:30`, top-level `[dependencies]`), which
  is what makes the unconditional `mod verify;` resolve on non-macOS. `Cargo.lock` needs no
  regeneration: it already records `ureq 2.12.1` for `verbatim-widget` and moving a dependency
  between tables at the same version requirement does not change resolution.
- `tray.rs`'s `Vec<&dyn IsMenuItem<Wry>>` + `finish_i.as_ref()` push relies on an unsize
  coercion at an argument position, which is a coercion site — sound. `MenuItem::with_id`'s
  shared text/accelerator generic is handled correctly by `show_label.as_str()` +
  `None::<&str>`.

**`AppConfig` migration safety (plan §3)**
- `setup_state` is in **both** places: struct `config.rs:54`, `Default` `config.rs:95`
  (`"unseen".into()`).
- A v1.0.0 `settings.json` with no `setupState` key deserializes cleanly: the container-level
  `#[serde(rename_all = "camelCase", default)]` at `config.rs:17` fills the field from
  `Default`. `read_config` additionally `.unwrap_or_default()`s a failed parse
  (`config.rs:109-112`), so there is no path on which an old config file breaks the app.
- The launch gate reads exactly as specified (`main.rs:125-128`), so an existing keyed install
  is never prompted and an existing keyless install is prompted once more.
- TS mirror present: `settings.ts:59` `setupState?: string;`, optional like its neighbours.

**The activation-policy fix — the reason this task exists (plan §8 R1)**
- **`getCurrentWindow` appears 0 times in `onboarding.ts`, and `.hide()` 0 times.** The plan's
  own acceptance grep passes.
- I traced **every** exit from the window. There are exactly three, and all three revert the
  policy:
  1. `data-act="later"` -> `finish("skipped")` (`onboarding.ts:679`)
  2. `data-act="done"` -> `finish("done")` (`:680`)
  3. red X -> `register_onboarding_close_handler` (`window.rs:214-229`)
  `finish()` (`:649-653`) does nothing but stop the two timers/subscriptions and
  `invoke("finish_onboarding")`. Screens 2 and 3 have no other exit (Screen 2's foot is
  Back/Continue, Screen 3's is Skip-the-test/Done).
- Both Rust paths revert to `desired_activation_policy(cfg.dock_icon)`, **not** a hardcoded
  `Accessory` — so a user who wants the Dock icon keeps it. `finish_onboarding` hides and
  reverts **before** the config write (`window.rs:191-200`), so a failed write cannot leave a
  stuck window with a Dock icon.
- Leak hygiene on the JS side: `stopAxPoll()` and `stopTryListen()` fire on both exits, on
  `back`, on `enterScreen3`, and on `beforeunload` (`:686`) — necessary because this window is
  hidden, never destroyed.

**Resolver invariants (design doc §2.2, plan §4.5)** — all executed, not just read:
1. No input produces an unresolvable provider id. `sttProvider` is always in
   `{pyai,deepgram,openai}` and `correctionProvider` always in `{openai,anthropic}` across all
   25 combinations. No branch can emit `local`/`fixture`/`mock`, and `pyai` can never land in
   the correction slot.
2. `correct`/`format` are never left on without a correction capability, and in `raw` mode both
   are written as explicit `false` (never omitted) — verified as a separate assertion.
3. `raw` mode names no correction vendor; the `sanitizeCorrection` exception behaves as
   specified (`openai`/`anthropic` -> `undefined`; anything else -> `"openai"`).
4. Role validation blocks the wrong key in **either** slot, including the deliberate choice to
   block on a wrong-role key in the *optional* slot.
5. `needStt` writes an empty patch and reports both vendors as `null`.
- The stale-`second` rule is genuinely airtight, which was my main suspicion going in:
  `usedSecond()` neutralises it in the resolver **and** both UI paths that can orphan a second
  key call `clearSecond()` — the field-1 input handler (`:191`) and the vendor-override picker
  (`:665`). So `state.v2` can never be non-null at Continue time while the slot is unused, and
  the second `key_verify` at `:487` cannot be reached with a stale key.
- Save ordering is correct: STT key first, cleanup key second, serially awaited, second
  `set_key` skipped when one vendor covers both roles (`:506-517`) — so the sidecar's last
  restart holds both keys and there is no double-restart race (plan §8 R3).
- `set_config` is written **last** (`:518`), so a key that failed to save can never leave a
  provider id pointing at it.

**Secret hygiene** — clean in both languages:
- Rust: no `println!`/`eprintln!`/`dbg!`/`panic!`/`unwrap()`/`expect()` anywhere in `verify.rs`
  or `testkey.rs`. The secret reaches exactly three expressions, all outbound headers
  (`verify.rs:50, 57, 60`). The only `Err` string is `format!("unknown vendor: {vendor}")` — a
  vendor id, not a secret. The transport-error arm **drops** the `ureq` error rather than
  formatting it (`:82`), which matters because a ureq error can echo request headers.
- TS: `state.key`/`state.key2` never reach `innerHTML`, a template literal, `console.*`, or a
  thrown message. The only render-time reference is a truthiness test (`:265`). The two inputs
  are long-lived nodes re-inserted per render (`:230-233`), and masking is `input.type`
  (`:225-226`) rather than substituted characters — so no secret ever round-trips through an
  HTML string. `use_test_key` keeps the key entirely in Rust; the webview never receives it.
- `capabilities/default.json` grants no clipboard/fs/shell permission that could exfiltrate one.

**Regressions in the shipping path** — read with "what previously worked could this break?":
- `showBanner()` gained exactly one line (`main.ts:370`) and `BannerActions` gained one variant
  (`:361`). All five action buttons are still explicitly assigned on **every** call, so no
  banner can inherit a stale button. For the pre-existing `"none"|"mic"|"ax"` callers the new
  expression is always `true` (hidden), i.e. a no-op.
- `finishSetupBtn` is built at module scope and appended to `#bannerActions`, which **does**
  exist in `index.html:24` — so the missing `index.html` half of C4 is genuinely optional, not
  a latent `null` deref. It also reuses a static `#finishSetup` if one is ever added, so the
  two approaches cannot double up.
- The three `emit`s are appended after each branch's existing statements, unawaited and
  `.catch`-swallowed; the `live` emit is deliberately outside the `cfgShowTranscript` guard, so
  `renderLive` gating is unchanged and the overlay renders exactly as before.
- `NOT_SET_UP_RE` (`main.ts:413`) was checked against the **actual** producer strings and
  matches all of them: `server.ts:318` ("Live mode needs …API_KEY"), `server.ts:309`
  ("is invalid — using", em dash identical on both sides), `providers/registry.ts:21` and
  `correction/registry.ts:22` ("Unknown STT/correction provider"),
  `registry.ts:32`/`:40` ("needs: …API_KEY").
- `cfgSetupState` is refreshed in **both** `applyPrefs` and `connect()` (`main.ts:61`, `:719`) —
  necessary and correct, because `finish_onboarding` persists via `write_config`, which does not
  broadcast `config-changed`.
- Settings dropdown hydration: `selectProvider()` (`settings.ts:329-340`) is idempotent (it
  drops the stale `[data-unavailable]` option first), and setting `sel.value` to a `disabled`
  option is legal programmatically, so a poisoned id now renders as `"pyai (unavailable)"`
  instead of a silently blank select. An empty id is treated as "unset", not "unavailable".
- Capability-error wording: the pre-existing `needs <ENV>.` message is **unchanged**
  (`settings.ts:174`); only the previously-silent unresolvable-id case gained a message. The
  PyAI-English-only rule is untouched.

**Build plumbing**
- `vite.config.ts:21` already carries the `onboarding` rollup input — no page was added, and the
  build will emit `onboarding.html`.
- `tauri.conf.json:46-60` declares the `onboarding` window, `visible: false`, title
  `"Welcome to Verbatim"` — which is what `testkey.rs:46`'s watermark overwrites for internal
  builds only, so the public title stays exact.
- `onboarding.css` redefines **no** `--*` design token (correct — it inherits `settings.css`'s),
  and `.btn`/`.btn.primary` are scoped under `.onboard` (`:146-153`) so nothing in Settings can
  shift. `onboarding.css` is loaded only by `onboarding.html`, by nothing else.
- `apps/backend/src/server.ts` and `apps/widget/index.html` were **not modified** (mtimes
  08-14), contradicting the task brief's changed-file list. There is no backend risk in this
  pipeline.

---

## 4. Plan divergences, judged

| Divergence | Verdict |
|---|---|
| `Cargo.toml` edited (off the do-not-touch list) to move `ureq` from the macOS target table to top-level `[dependencies]` | **Improvement, and necessary.** `mod verify;` is unconditional, so a target-gated `ureq` genuinely would fail to resolve on a non-macOS target. Verified: `ureq = "2"` at `Cargo.toml:30`, absent from the macOS table; `Cargo.lock` unaffected. |
| C4's `index.html` markup half not written; button built in `main.ts` instead | **Wash.** Verified `#bannerActions` exists, class/label/initial-hidden match the plan's markup, and a future static button is a no-op. |
| C3 emits written out three times instead of via a helper | **Wash.** Done to satisfy the plan's own >=3-occurrence acceptance grep; the `const p: DictationProgress` annotation is what actually holds the contract, since `emit`'s payload parameter is `unknown`. |
| `article()`/`firstName()` produce "Paste **an** OpenAI key" where the plan's table literally says "Paste a `<first name>` key" | **Improvement.** Grammar fix, verified to yield "Paste an OpenAI key" / "Paste a PyAI key". |
| C6 (docs) not done | **Defect** — finding 3. |
| `settings.ts:171` adds a new unresolvable-id message not in the §7 table | **Improvement.** It is a Settings-window string outside the onboarding microcopy table, and it replaces a state that previously reported *zero* errors for a genuinely broken config. |

---

## 5. Mac-only — cannot be verified from here, in priority order

1. **`cargo build` itself.** Nothing in this environment typechecks or borrow-checks Rust; the
   Tauri crate cannot be built in the container (macOS-only deps: `tauri-nspanel`,
   `keyring/apple-native`, `core-graphics`, `ort`, `cpal`). G3/G6/G7 reduce this to a type-level
   risk, not a syntax or API one, but they do not eliminate it. Likeliest residual spots, in
   order: `tray.rs:80-86` (the `&dyn IsMenuItem` vec + `Menu::with_items` slice),
   `tray.rs:99` (`app.tray_by_id("main-tray")`'s `TrayIconId: PartialEq<&str>` bound), and
   `tray.rs:61` (`MenuItem::with_id`'s shared text/accelerator generic).
2. **The Dock-icon leak is actually gone.** The code path is provably correct (§3 above) but
   `ActivationPolicy` is a real AppKit call: launch with `dockIcon: false`, complete onboarding
   via *each* of the three exits, and confirm no Dock icon survives, then repeat with
   `dockIcon: true` and confirm the icon is *kept*.
3. **`key_verify` against live vendors.** The 401-vs-unreachable split, and the 2s timeout
   actually firing. No network calls were made from here. Also unverified: that `pyai` has no
   cheap authenticated GET (design doc §9 #1 is still open, so it permanently takes the
   "saved anyway" branch).
4. **`setup_state` round trip on a real `settings.json`** — including the migration case: launch
   a build with a pre-existing v1.0.0 config that lacks `setupState` and confirm it parses and
   the onboarding gate behaves. Reasoned through, not executed.
5. **`use_test_key` / `test_key_available`.** `option_env!` is resolved at compile time, so both
   the key-present and key-absent builds need a Mac. Also: `scripts/assert-no-test-key.sh`
   needs a real `.app` and `strings` (Xcode CLT) — and note finding 2 before trusting it.
6. **Tray menu rebuild.** That `refresh_menu` actually swaps the live menu and that
   "Finish setup…" disappears at `setup_state == "done"`. Plan §8 R9 already accepts the
   degradation if `set_menu` fails.
7. **Screen 2's permission probes.** `getUserMedia` prompting once, `ax_trusted` flipping while
   the user is in System Settings, and the 1 Hz poll not fighting the user for focus. The
   `alwaysOnTop: true` on the onboarding window is presumably deliberate (Screen 2 promises the
   page updates itself while you flip the toggle) but should be eyeballed against System
   Settings sitting on top of it.
8. **Screen 3's live try-it box** end to end — the `dictation-progress` events actually crossing
   the window boundary and the strike-through reveal rendering.
9. **Visual fidelity vs `onboarding-prototype.html`.** No rendering was done. Note that
   `onboarding.css` defines several generic unscoped classes (`.head`, `.field`, `.foot`,
   `.link`, `.chip`, `.note`, `.pill`, `.stat`, `.info`) which cascade *on top of*
   `settings.css` (loaded first in `onboarding.html`) — harmless for Settings, but any property
   `settings.css` sets and `onboarding.css` does not will still apply inside the onboarding
   window. Worth one look at the 440x566 window for inherited padding/font surprises.
