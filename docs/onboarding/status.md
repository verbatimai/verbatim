# First-Run Onboarding — Pipeline Status

**Updated:** 18 Aug 2026 · **Phase:** implementation complete, **never compiled, never run**. Next action is a `cargo build` on the Mac — see [`test-plan.md`](./test-plan.md).

## The one-line state

O1–O7 of the design doc are implemented and every gate this environment can run is green. The Rust half has **never seen a compiler** and nothing has been exercised on macOS, so treat the feature as *authored*, not *working*, until the test plan passes.

## Documents in this folder

| File | What it is |
|---|---|
| [`implementation-plan.md`](./implementation-plan.md) | The architect's plan: command contract, resolver spec, config delta, 24 tasks across 3 owners, microcopy table, risk register. Self-reviewed and revised before any code was written. |
| [`review.md`](./review.md) | Independent adversarial audit of the finished diff. Re-ran every gate itself rather than trusting the devs. |
| [`progress-dev-a.md`](./progress-dev-a.md) | Onboarding webview — tasks, deviations, the tests it added. |
| [`progress-dev-b.md`](./progress-dev-b.md) | Rust host — includes a per-function **self-review with type citations**, which is what makes uncompiled Rust reviewable. |
| [`progress-dev-c.md`](./progress-dev-c.md) | Settings + overlay seams — including what changed in the shipping `main.ts` path and why it's safe. |
| [`test-plan.md`](./test-plan.md) | **Start here on the Mac.** Build steps, how to force a true first run, a 16-row scenario matrix, and the regression sweep. |
| [`../product/onboarding-plan.md`](../product/onboarding-plan.md) | Design of record. |
| [`../product/onboarding-prototype.html`](../product/onboarding-prototype.html) | Interactive visual spec the implementation was ported from. |

## How it was built

| Stage | Agent | Result |
|---|---|---|
| Plan | Architect | 24 tasks, 3 exclusive file partitions, command contract fixed up front so devs could work in parallel without talking. Self-review caught 11 defects in its own plan — including that DEV-A's only executable gate was broken. |
| Build | DEV-A · DEV-B · DEV-C, concurrent | 10 / 8 / 6 tasks. Zero file collisions (exclusive ownership held). |
| Audit | Reviewer | 0 blockers · 1 major · 5 minor · 2 nits. Verified the contract (52 handler entries, all arg mappings), the resolver (88 assertions), Rust parse, and 47/47 microcopy strings. |
| Round 1 | DEV-A · DEV-C · orchestrator | All 6 findings closed. DEV-A pinned the major with a test that fails against the pre-fix code. |

DEV-B was terminated mid-round by an interrupt and could not be resumed; its remaining finding (the fail-open secret gate) was completed by the orchestrator.

## Gates — what was actually run

| Gate | Result | Notes |
|---|---|---|
| `npm run typecheck` (web + widget) | **green**, no output | authoritative for all TS |
| Resolver truth table | **green**, 88 assertions + 5 invariant sweeps | written by the reviewer, not the author |
| `fieldStatus` regression test | **green**, 12 assertions | fails 4 against the pre-fix code — the major finding cannot silently return |
| `rustfmt --edition 2021 --check` | **all 6 `.rs` files parse** | syntax gate only; `config.rs`'s 3 diffs proven pre-existing |
| `invoke_handler!` audit | 52 entries, 0 duplicates, 5 new commands registered | arg-name mapping checked per command |
| Secret-absence gate | **green**, and its self-test proves it can fail | the old `grep -q` form errors on a regex-hostile prefix and passes a poisoned build; now `-qF` |
| Microcopy | 47/47 verbatim vs the plan | no voice drift across three agents |
| `cargo build` | **NOT RUN — impossible here** | no Rust toolchain on the device VM, and the crate is macOS-only |
| `npm test` (core) | **green — 30 files, 276 tests** | Was red on master (2 failed files). Run natively in a Linux container on a staged copy, since `vitest` can't start against the darwin `node_modules` on the mount. Verified the two previously-broken files individually as well. |
| `npm run typecheck` (root, all 4 workspaces) | **green** | Was red on master with 3 errors in `packages/core` test files. |
| Any macOS runtime behaviour | **NOT RUN** | the whole of `test-plan.md` §5 |

## What changed

**New:** `apps/widget/src/onboarding-resolve.ts` · `src-tauri/src/verify.rs` · `src-tauri/src/testkey.rs` · `scripts/assert-no-test-key.sh`
**Rewritten:** `apps/widget/src/onboarding.ts` · `onboarding.html` · `src/onboarding.css`
**Edited:** `src-tauri/src/{main,config,window,tray}.rs` · `src-tauri/{tauri.conf.json,Cargo.toml,capabilities/default.json}` · `apps/widget/src/{settings.ts,main.ts}` · `README.md` · `docs/product/{STATUS.md,onboarding-plan.md}`
**Untouched:** `packages/core` (0 files) · `apps/backend` · `keys.rs` · `secrets.rs` · `axinject.rs` · the overlay panel setup · the hotkey machinery

Nothing was committed. `git diff` is the whole record and `git checkout -- <file>` is the undo.

## Open

1. **`cargo build` has never run.** Three known-risk sites, each with a written fallback — `test-plan.md` §2.
2. **Design-doc §9 probes are still open** (O0 was never run): PyAI key prefix + verify endpoint, whether AX flips live, whether injection into our own window works. Scenario 7b answers the second; Screen 3 was built so the third doesn't matter.
3. **O8 (local models)** — designed, deliberately not implemented, gated on §9 #5 (where local inference runs).
4. **Pre-existing bugs found in passing — none fixed, all recorded:**
   - `glossary_get`/`glossary_save` are defined but never registered in `invoke_handler!` (`progress-dev-b.md`).
   - **`packages/core`'s test suite and the root typecheck were both red on master** from `f484096` — the same
     commit that caused the onboarding defect. **Both fixed 18 Aug and verified green** (30 files / 276 tests):
     a dangling `correction/pyai` import that had been silently skipping 7 PyAI STT tests since 14 Aug, and a
     genuinely missing glossary block in `prompt.ts` whose absence made `userMessage()` **throw** on a
     `GlossaryEntry`. Details and the reasoning in `test-plan.md` §1a. This is the only `packages/core` change.
   - **Glossary feature is half-wired:** nothing sends entries yet, and `glossary_get`/`glossary_save` are still
     unregistered in `invoke_handler!`. The prompt layer is ready; the wiring is separate work.
5. **Copy vs reality:** the trust line said "macOS keychain" but the default secret backend is a `0600 secrets.json` (`secrets.rs:9`); corrected to "Stored locally on this Mac". Worth a second look if you'd rather make the keychain the default.
