# Settings — Phase 2 (Wave 2) Plan Review

**Reviewer pass · 13 Aug 2026 · pre-implementation cross-check against live code.**
Scope: `phase-2-plan.md` items 2.1 (paste-last hotkey), 2.2 (correction toggle),
2.3 (formatting toggle) vs `settings-plan.md` §0/§1/§3, on the Phase-1-landed tree.

---

## Verdict: **APPROVED WITH REQUIRED CHANGES** — dev is **cleared to start**

The plan's architecture is correct on every load-bearing point I was asked to
stress-test: the last-transcript seam is safe, the dual-pipeline requirement is
real and both edit sites are identified, and the `localFormat` bypass is caught.
Line references are accurate to ±1. The required changes are three precision fixes
(one genuine correctness bug in a line-range instruction, two guidance tightenings),
all applied inline to the plan. None block starting; the dev must honour them while
implementing.

---

## Verification summary (what I checked against the code)

| Plan claim | Verified? | Evidence |
|---|---|---|
| `inject_text` is the SOLE caller path for the final text | **YES** | Grep: `invoke("inject_text")` appears once, `main.ts:259`, inside `injectFinal`. `injectFinal` is called once, from the `formatted` handler (`main.ts:294`). |
| ⌥⇧V test-paste won't pollute `LAST_RESULT` | **YES** | `test_paste` calls `axinject::inject(DEMO)` **directly** (`main.rs:825`), bypassing `inject_text` entirely. Partials/live never call `inject_text`. |
| Widget runtime finalize = `server.ts`, not core `Pipeline` | **YES** | Sidecar is spawned via `spawn_backend`→`npm run start --workspace @verbatim/backend` (`main.rs:363–399`). `server.ts:100–150` re-implements finalize. |
| `pipeline.ts` is a parallel path (cli + tests only) | **YES** | `new Pipeline(` sites: `cli.ts:53`, `format.test.ts:25/41/57`, `pyai.integration.test.ts:143`. All pass 3 args → optional 4th `opts={}` is back-compat. |
| `server.ts` `localFormat` fallback must also be bypassed | **YES — critical, correctly flagged** | Two `localFormat` calls: catch-fallback `server.ts:140` and no-`format` else `server.ts:143`. Gating the whole 134–144 block and setting `finalText = cleanText` is the right fix. |
| WS `start` already carries provider/lang; add `correct`/`format` | **YES** | Parsed `server.ts:167–169`; scope vars at `94–95`; start frame sent `main.ts:328–334`; `cfg` is `any` (`main.ts:320`) so no widget TS change. |
| Config container is back-compat for new fields | **YES** | `AppConfig` has `#[serde(rename_all="camelCase", default)]` (`main.rs:96`) → missing fields fall back to `Default` impl. Old `settings.json` still loads. |
| `format.test.ts` harness fits the proposed cases | **YES (with one fixture caveat, below)** | `FixtureSTT` + `MockCorrection`, driven by `pipeline.run()`, asserted via `onCorrection`/`onFormatted`. Pure core — no Tauri runtime. |
| Core `AppSettings` should NOT carry `correct`/`format` | **YES — sound** | `settings.ts:19–26` + `resolveProviders` (45–51) are strictly provider-selection + language. |
| No secret / `.env` read added | **YES** | None of the touched paths read `.env` or log key values; paste-last text is a transcript held in a Rust `Mutex`, never persisted/logged. |

All UI line refs (`settings.ts` 285–333 / 447–456 / 479–496; `settings.html`
291–302 Formatting, 313–346 Toggle, 354–364 Paste-last, 435–449 Self-correction)
are accurate.

---

## Corrections required before dev

### 1. (Correctness) `pipeline.ts` — replace **240–248**, not 238–248 — APPLIED
The plan's 2.2 rewrite snippet references `language` and does **not** re-declare it,
and relies on the surrounding `try {`/`catch`. Instructing "Replace lines 238–248"
deletes both `try {` (line 238) and `const language = sttConfig?.language;` (line 239),
which breaks the catch guard and leaves `language` undefined. Fixed inline to
**"Replace 240–248, keep 238–239, keep the catch at 249–252."** This is the only
change that would have produced broken code if followed literally.

### 2. (Ordering) 2.1 startup registration must go **after line 892** — APPLIED
`apply_paste_last_hotkey` calls `app.global_shortcut()`, which requires the
global-shortcut plugin to be **built** first (`main.rs:812–889`, built at 889).
The plan's "~799–892" range spans code *before* the plugin exists. Tightened inline
to "after line 892" (after `register(test_paste)?`), where `register` for paste-last
is safe.

### 3. (Test authoring) 2.3 format-test needs a custom STT fixture — APPLIED
`format.test.ts:8` is a **direct** `new MockCorrection().format("…")` call, not a
reusable STT fixture. Driving `format:false` *through the pipeline* requires a
hand-built `new FixtureSTT(events, 10)` whose `acc.final()` yields the enumeration
string (mirror the u1/u2 events at `format.test.ts:34–39`). Reworded inline so the
dev doesn't hunt for a fixture that doesn't exist.

### 4. (Non-blocking, precision) §0 off-by-one
§0 cites `correction.correct` at `server.ts:123`; it is actually line **122**
(`cleanText` norm is 123). Cosmetic — left as-is. The `finalize` (100–150) and
`{type:"formatted"}` (146) refs are exact.

---

## Answers to the planner's open questions

**Q1 — implicit vs explicit last-transcript seam.** Keep the **implicit** seam
(record inside `inject_text`). It is verifiably correct today: `inject_text` has
exactly one caller (`injectFinal`, itself fired only by the `formatted` handler),
and the only other injection path (⌥⇧V) bypasses `inject_text`. So `LAST_RESULT`
captures the finalized formatted transcript and nothing else. Ship the implicit seam
**with** the inline guard comment the plan already specifies. The explicit
`remember_last_transcript` command is unnecessary now; revisit only if a second
`inject_text` caller is ever introduced.

**Q2 — collision policy.** Add the **soft UI guard** (reject a paste-last combo equal
to `config.hotkey`, and also equal to the reserved ⌥⇧V `test_paste`). Grounded reason:
the handler tests `test_paste → paste-last → toggle` in order, so a paste-last equal
to the toggle silently **shadows** the toggle; and `apply_paste_last_hotkey`'s
`register()` on a duplicate accelerator errors → early-return leaves
`CURRENT_PASTE_LAST = None` → a silent no-op the user reads as a bug. Don't rely on
the OS register-error alone.

**Q3 — capture-UI refactor scope.** The `makeHotkeyCapture` factory is safe: the
toggle capture (`settings.ts:279–333`) is self-contained (module `recording` flag +
`onCaptureKeydown` + onclick/clear/presets). One nuance to parameterize: the toggle's
Clear resets to `"alt-space"`, while paste-last's Clear sets `""` — the factory must
take the clear behaviour (`allowEmptyClear`) as an option. Either the factory or an
additive duplicate is acceptable; slight preference for the factory since 2.1 already
depends on it.

**Q4 — `correct:false` UX.** Live transcript still streams (live messages are
independent of the correction pass). Two on-Mac things to confirm, not blockers: (a)
with no `correction` message emitted, `finalOut` is set only by the later `formatted`
message (`main.ts:287` guards on a `correction` message), so the output box shows the
TYPING spinner between stop and `formatted` — verify it clears; (b) copy is a
decision — neutralize the "Cloud only" tag (an "STT-only" hint when off is reasonable),
not required for the switch to function.

**Q5 — core `AppSettings` boundary.** Confirmed **sound**. `AppSettings` +
`resolveProviders` are provider-selection + language only; `correct`/`format` are
pipeline *behaviour*. Model them as `PipelineOptions` (core) + widget `AppConfig`
(persisted) + WS `start` (runtime). Do **not** thread them through
`AppSettings`/`resolveProviders`/`DEFAULT_SETTINGS`.

**Q6 — backend defaulting.** `msg.correct !== false` / `msg.format !== false`
(undefined → true) is the correct back-compat rule. It matches the existing pattern
(`msg.sttProvider ?? DEFAULT`, `server.ts:167`; language guard, 169) and keeps
older/demo clients (which send `undefined`) on today's on/on behaviour. Endorsed.

---

## Cloud-runnable labelling check

Nothing is mislabeled. The core vitest cases (2.2/2.3) are genuinely cloud-runnable —
pure `FixtureSTT` + `MockCorrection`, no Tauri. `tsc --noEmit` for
`apps/widget`/`apps/backend` and the HTML `id=` grep checks are cloud-runnable. All
Rust items are correctly marked on-Mac only. The single caveat is correction #3: the
2.3 test is runnable **only if** the custom fixture is authored (it is not "reuse the
existing test").

---

## Go / No-Go: **GO for dev**

MUST-follow before/while implementing:
- **pipeline.ts:** replace **240–248** only; keep `try {` (238), `const language` (239),
  and the `catch` (249–252). Keep bypass semantics identical between core and
  `server.ts` (skip the call, `cleaned/cleanText = raw`, emit no `correction`/
  `onCorrection`).
- **server.ts:** the `format:false` path must bypass **both** `correction.format`
  **and** the `localFormat` fallback (whole 134–144 block) → `finalText = cleanText`.
- **2.1 Rust:** place the startup `apply_paste_last_hotkey` **after line 892**; handle
  `""` (unset → unregister only); fire on `Released`; add the `clear_config` unregister
  line. Add the soft UI collision guard (vs `config.hotkey` and ⌥⇧V).
- **Config:** add `correct: true`, `format: true`, `paste_last_hotkey: String::new()`
  to the `AppConfig` struct **and** `Default` impl (single edit), mirror all three in
  `settings.ts` `AppConfig`. Rust is **cargo-build-verified on the Mac** — cloud
  typecheck/tests are necessary but not sufficient.
- **Tests:** build the custom `FixtureSTT` events for the 2.3 format test; keep
  `npm test` green (77 → 77+new).
