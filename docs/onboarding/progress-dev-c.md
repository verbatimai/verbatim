# DEV-C progress — Settings surface + overlay seams

Scope: the DEV-C tasks of [`implementation-plan.md`](./implementation-plan.md) §6.
Writable set for this pass (narrower than the plan's ownership table — see Deviations):
`apps/widget/src/settings.ts`, `apps/widget/settings.html`, `apps/widget/src/main.ts`.

**Gate:** `npm run typecheck --workspace @verbatim/widget` — green (`tsc --noEmit`, no output).

## Tasks

| Task | Status | What landed |
|---|---|---|
| **C1** — TS config mirror | done | `setupState?: string;` added to `AppConfig` in `settings.ts`, after `historyLimit?`, optional like every other late-added field. |
| **C2** — `capabilityErrors()` side-fixes | done | New `STT_REGISTERED` / `CORR_REGISTERED` sets (mirroring `providers/registry.ts` and `correction/registry.ts`) + `roleErrors(role, id, registered)`. Unresolvable id ⇒ *"…isn't a provider Verbatim can use — pick another."*; registered id with no `VENDOR_ENV` entry ⇒ **satisfied** (zero-key providers, design-doc §0.12); otherwise the pre-existing `needs <ENV>.` message, unchanged. PyAI-English-only rule untouched. |
| **C3** — `dictation-progress` emits | done | `emit` added to the existing `@tauri-apps/api/event` import; `DictationProgress` type mirrors the §2.3 contract; three emits in `handle()` (`live` / `correction` / `final`), each **after** the branch's existing behaviour, each `.catch(() => {})`. |
| **C4** — not-set-up nudge | done (main.ts half) | `NOT_SET_UP_RE`, `nudgedThisLaunch`, `cfgSetupState`, `BannerActions \| "setup"`, `finishSetupBtn` + `show_onboarding_window` wiring. The `index.html` markup half was **not** written — see Deviations. |
| **C5** — Settings can't hide a broken provider id | done | `selectProvider()` in `settings.ts` replaces the two bare `.value =` assignments in `initProviderControls`; on `selectedIndex === -1` it appends a `disabled` `<option>` labelled `` `${id} (unavailable)` `` and selects it. No `local` option added (O8). `settings.html` needed **no** change (the plan's preferred TS guard). |
| **C6** — docs | **not done** | `README.md`, `docs/product/STATUS.md`, `docs/product/onboarding-plan.md` are outside this pass's writable set. See Deviations. |

## Deviations from the plan, and why

1. **Writable set narrowed to three files.** This pass was instructed to write only
   `settings.ts`, `settings.html`, `main.ts` (plus this progress file). The plan's DEV-C
   column also lists `apps/widget/index.html`, `README.md`, `docs/product/STATUS.md` and
   `docs/product/onboarding-plan.md`. None of those were touched. Consequences:
   - **`apps/widget/index.html` — no `<button id="finishSetup">` in the markup.** Rather
     than leave C4 half-built, `main.ts` creates the button itself and appends it to
     `#bannerActions`, reusing an existing `#finishSetup` if one is ever added to the
     markup, so the two approaches cannot double up. Class (`banner-btn`), label
     (`Finish setup`) and initial `hidden` state match the plan's markup exactly, so
     adding the static button later is a no-op. **No `index.html` change is required for
     C4 to work** — the plan's markup step is now optional, not blocking.
   - **C6 is unstarted.** It is also the one task the plan gates on *every* other task
     completing, so it is naturally last; it needs a pass that can write `README.md`,
     `STATUS.md` and `onboarding-plan.md`.
2. **C3's emits are written out three times rather than through a helper.** A typed
   `emitProgress()` wrapper was the first shape (one event-name literal, one `.catch`),
   but the plan's acceptance check greps for ≥3 occurrences of `dictation-progress`, so
   each branch now emits directly with a `const p: DictationProgress` annotation — which
   keeps the payload type-checked (`emit`'s own payload parameter is `unknown`, so the
   annotation is the only thing holding the contract).
3. **`cfgSetupState` is refreshed in `connect()` as well as in `applyPrefs()`.** The plan
   named both sites; both are used, because `finish_onboarding` (B4) persists through
   `write_config`, which does **not** broadcast `config-changed`, so `applyPrefs` alone
   could hold a stale `"unseen"` for the rest of the session.

## Behaviour changed in the shipping overlay path (`main.ts`), and why it is safe

- **Three `emit` calls in `handle()`.** Appended after each branch's existing statements,
  fire-and-forget with `.catch(() => {})`, no `await`, no branch condition changed. The
  `live` emit is deliberately **not** gated on `cfgShowTranscript` (the onboarding window
  needs the stream even when the bubble is off); that pref still gates `renderLive` alone,
  so the overlay renders exactly as before.
- **`showBanner()` gained one line** (`finishSetupBtn.hidden = actions !== "setup";`).
  All five action buttons are still explicitly assigned on every call, so no banner can
  inherit a stale button from a previous one (risk R4). `"none" | "mic" | "ax"` callers are
  unaffected: for them the new expression is always `true`.
- **The `"error"` branch can now take a different path** — but only when *all three* of
  these hold: the message matches `NOT_SET_UP_RE`, `cfgSetupState !== "done"`, and the
  nudge has not already fired this launch. In that case it shows a `warn` banner with the
  `setup` action and returns before the `copyErr`/`bannerLog` reveal. Every other error —
  and every *later* not-set-up error in the same launch — reaches the original
  `showBanner("err", friendlyError(...))` path untouched, so no error is ever swallowed.
  `setStatus("err", …)`, `lastErrorFull` and `lastErrorFile` are still set first, so the
  pill badge and the copy-details payload behave as they did.
- **One button node added to `#bannerActions` at module load.** It starts `hidden`, and
  `bannerActions` itself stays hidden unless a banner asks for actions, so nothing is
  visible until a nudge fires.

## Needed from other agents

- **DEV-B:** `show_onboarding_window` (§2.1) must be registered in `main.rs`'s
  `invoke_handler!`, and `setup_state` must exist in `AppConfig` + `impl Default`
  (`setupState` over the wire). Until both land, the nudge button's `invoke` rejects (it
  is `.catch(() => {})`, so it degrades to a no-op) and `cfgSetupState` stays `""` — which
  fails *open*, i.e. the nudge still shows.
- **DEV-A:** nothing. The `dictation-progress` name and payload are the frozen §2.3
  contract; `ops` carries `main.ts`'s `Op` (which also has the optional `reason`).

## Mac-only verification (nothing below can run in this pipeline)

- **M8/M9 regression passes** — the overlay and Settings unchanged apart from the intended fixes.
- **M9 specifically:** a config poisoned with `correctionProvider: "pyai"` must now render
  `pyai (unavailable)` in the select *and* report the "isn't a provider Verbatim can use"
  capability error, instead of a blank field and zero errors.
- **The nudge end to end:** skip onboarding, dictate, confirm the friendly banner replaces
  `Provider 'pyai' needs: PYAI_API_KEY`, that **Finish setup** reopens the window, and that
  it appears **once** per launch.
- **M10:** the `dictation-progress` stream driving the onboarding `.trybox` on a real hotkey hold.

---

## Review round 1

Two items came back from the independent review (`review.md` finding 5, and finding 3 = the
C6 docs task). Both addressed. Gate re-run after every edit; final:

```
> @verbatim/widget@1.0.0 typecheck
> tsc --noEmit

EXIT=0
```

### 1. The nudge no longer suppresses a real error (`review.md` finding 5)

The gate was `cfgSetupState !== "done"`, and nothing ever rewrites `"skipped"` — so an install
that skipped onboarding and *then* got keys through Settings kept losing its **first real error
of every launch**, plus the **Copy details** button and log path, to a nudge that no longer
applied. The reviewer's exact case: valid keys + a stale `correctionProvider: "pyai"` ⇒
`server.ts:309`'s "is invalid — using" matches `NOT_SET_UP_RE` ⇒ the user got "Verbatim isn't
set up yet" and a **Finish setup** button that cannot fix a bad `correctionProvider`.

Now the persisted flag is only a cheap pre-filter; the decision is made from live state:

- New `noSpeechSource()` reads `get_config`, checks `sttProvider` against a local
  `STT_REGISTERED` mirror of `providers/registry.ts`, and asks `has_key` for that vendor. The
  nudge shows **only** when that returns true.
- **Correction-only failures therefore stop nudging at all.** With speech configured,
  dictation genuinely works, so "isn't set up yet" is false and the real error is the useful
  one — which also covers the reviewer's scenario directly.
- **Fails toward the raw error:** any rejected `invoke` returns `false`, i.e. the nudge is
  suppressed and the original error banner shows. The nudge is only ever substituted on a
  positive determination, never on a guess.
- The `"err"` banner body moved into `showBackendError(message)` because the decision is now
  asynchronous and both paths need it. Byte-for-byte the same statements in the same order.
- **New behaviour to note:** on this one branch the banner is painted after one IPC round
  trip instead of synchronously. Only the not-set-up-shaped branch pays it, the success path
  is untouched, and an error is terminal for a session, so nothing can overwrite the banner in
  between. `nudgedThisLaunch` is still checked inside the callback, so two errors arriving
  together cannot produce two nudges.

### 2. C6 — docs (`review.md` finding 3)

Written this round; the writable set was extended to cover them.

- **`README.md`** — Quick start's *macOS desktop widget* section now describes the real first
  run (the self-opening window, the three screens, a per-key "what you get" table, wrong-role
  refusal, and that **Set up later** is remembered with **Finish setup…** / the overlay button
  as the ways back). Configuration's *API keys* bullet corrected: keys go to a `0600`
  `secrets.json` in the app config dir (`secrets.rs:9` — `key_storage` defaults to `"local"`),
  with the keychain as the non-default branch; the old text claimed the keychain outright. The
  Providers table's **PyAI correction ✅ is now —** (`correction/registry.ts` registers only
  `openai`/`anthropic`; `.env.example:8` already said so) and `CORRECTION_PROVIDER`'s values
  lost `pyai`. Badges, TOC and section order untouched.
- **`docs/product/STATUS.md`** — `_Last updated_` refreshed, one bullet added to *Where things
  stand*, and a new dated **§First-run onboarding** section: what landed (per file), the
  `Cargo.toml` divergence, **the entire Rust half listed as authored-but-uncompiled** with the
  likeliest residual failures, the five known open defects, and the 12-item Mac-verify list.
  *Immediate next steps* gained a "before anything else: `cargo build`" line, and *Known open
  items* gained the pre-existing `glossary_get`/`glossary_save` handler-registration bug the
  review surfaced. No milestone history rewritten.
- **`docs/product/onboarding-plan.md`** — header status is no longer "planning only"; the phase
  table marks O1–O6 ✅, O7 ◐ (docs done, exit demo not run), O0/O8 ⬜; both "fix while in the
  neighbourhood" items marked done; the exit criteria carry an explicit "none of these have
  been run"; and a new **§12** records the seven things the build proved wrong about the design
  (566 px window, the `Cargo.toml` placement, PyAI never verifying, Screen 3's fallback
  becoming the implementation, the `setup_state`-alone nudge, `any_vendor_key_saved` left
  alone, and the trust-line/keychain mismatch) plus the five unfixed defects.

### Accuracy notes

- **New finding, nobody's fix yet:** Screen 1's trust line says keys are *"stored in your
  macOS keychain"*, but the default secret backend is `key_storage: "local"` — a `0600`
  `secrets.json` (`secrets.rs:3-9`). The copy is DEV-A's file and the default is DEV-B's, so it
  is recorded in STATUS.md and §12 rather than changed here.
- **Claims deliberately softened:** "the AX row updates itself when you flip the toggle" became
  "the window keeps polling so the row updates as soon as macOS reports the grant" (design-doc
  §9 #2 — whether `AXIsProcessTrusted()` flips for a running process is still an open Mac
  probe). Every "landed" in these docs is qualified as authored / typecheck-green /
  `cargo build` pending, and the O7 exit demo is marked not-run rather than done.
