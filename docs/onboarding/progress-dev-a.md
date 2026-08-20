# DEV-A progress — the onboarding webview

Scope: tasks **A1–A10** of `implementation-plan.md` §6. Files owned and written:
`apps/widget/onboarding.html`, `apps/widget/src/onboarding.ts`,
`apps/widget/src/onboarding-resolve.ts` *(new)*, `apps/widget/src/onboarding.css`.
Nothing outside that set was touched.

## Task status

| Task | Status | What was actually done |
|---|---|---|
| **A1** Resolver module | done | New `src/onboarding-resolve.ts`, zero imports. `VENDORS`, `detect`, `roleOk`, `resolveFirst`, `secondSlot`, `combo`, `slotError`, `continueBlocked`, `sanitizeCorrection` + types, exactly per §4. Stale-`second` rule implemented once, in a private `usedSecond()` that all three gating functions read. |
| **A2** HTML shell | done | `onboarding.html` reduced to `<main class="onboard" id="root"></main>`; `<head>`, both stylesheets, favicon, title, `<body class="settings-window" data-theme="system">` and the module script tag unchanged. No key field in markup. |
| **A3** Styles | done | `onboarding.css` replaced with the ported prototype rules (lines 85-262 + keyframes). No token declared. Old `.onboard-vendors`/`.onboard-vendor`/`#onboardKey`/`.onboard-error`/`.onboard-actions` rules gone. `.btn` scoped under `.onboard`. |
| **A4** Screen 1 shell + render loop | done | Boot `get_config` once (hotkey/theme/correctionProvider), theme applied and followed on `config-changed`. Both `<input>`s created once by `makeField()` and re-inserted into `data-slot` placeholders each render; masking via `input.type`. Editable vendor chip + 4-button picker, preview collapses once a vendor is detected, `s1help` view with the four `.kr` rows and `window.open`. |
| **A5** Second-role slot | done | Collapsed one-liner for `optional`, always expanded for `required`, absent for `none`; ok-line vs role error under the field; Continue follows `continueBlocked(...) || verify === "checking"`. Chip describes the first key, headline is `combo(...).headline`. |
| **A6** Verify + save + advance | done | Exact 8-step order. Serial `set_key`, STT first, `secretOf` map keyed by vendor; `raw` merges `sanitizeCorrection`; failure leaves the user on Screen 1 with the save-failed copy. |
| **A7** Internal test-key button | done | `test_key_available` at boot; button only when `internal && vendor === null`; click does `use_test_key` then the config half only (no `set_key`), `mode = "raw"`, Screen 2. |
| **A8** Screen 2 permissions | done | `getUserMedia` then immediate `getTracks().stop()`; denial swaps to Open Settings + Re-check. AX read on entry, polled at 1 Hz only while Screen 2 is visible, cleared on Back, on advance and on `beforeunload`; re-render only on change. Amber strip for `raw` only. Continue never disabled. |
| **A9** Screen 3 try-it | done | `PRESET_LABELS`+`describeHotkey` copied from `settings.ts:432-449`; hotkey rendered in headline, pill and tip — no literal glyph anywhere. `listen<DictationProgress>("dictation-progress")` drives `listening`/`correcting`/`done`; `ops` rendered with `<s>` spans. Skip jumps to done. Unsubscribed on leave and `beforeunload`. |
| **A10** Exit paths | done | `Set up later` → `finish_onboarding {state:"skipped"}`, `Done` → `{state:"done"}`, both `.catch(() => {})`. No window-hiding call from JS; the `@tauri-apps/api/window` import is gone. |

## Gates

- `npm run typecheck --workspace @verbatim/widget` — **green** (no output beyond the tsc banner).
- `node --experimental-strip-types /tmp/resolver-check.mts` — **`resolver OK`**, exit 0. Covers every row of §4.3 and §4.4 (all 25 `(first, second)` pairs), the `detect` table, `secondSlot`, `slotError`, `continueBlocked`, `sanitizeCorrection`, and all five §4.5 invariants including the stale-`second` rule.
- `/tmp/ui-check.mts` — **`ui helpers OK`**: `describeHotkey`, `esc`, `opsToHtml`, `firstName`, `article`, `dots`, extracted from the real source and executed.
- Static audits: `grep -c 'id="root"' onboarding.html` = 1 · no key field in the markup · `grep -c '^[[:space:]]*--' onboarding.css` = 0 · `grep -c getCurrentWindow onboarding.ts` = 0 · no `localStorage` · no `"local"` in the resolver · all 16 rendered `data-act` values have a handler and no handler is dead · all 11 invoked commands are in the §2 contract · no `console.*` · no `${...}` containing a key or secret · markup tag-balanced in all four render functions.

## Deviations from the plan, and why

1. **Three additions to the state object** (§ A4 lists `{screen, key, vendor, pick, reveal, verify, help, mode, key2, v2, second, mic, ax, tryState}`):
   - `micDenied` — A8 requires the mic button to swap to `open_mic_settings` after a refusal, which `mic: false` alone cannot distinguish from "not asked yet".
   - `tryHtml` — A9 requires Screen 3 to render the transcript/`cleanText`/final text; `tryState` carries no text.
   - `"saveFailed"` added to the `verify` union rather than a separate field, so A6's save-failure copy renders in the same meta row as every other Screen 1 verdict.
2. **`firstName()` fixes a prototype bug.** The prototype's `okList.split(" or ")[0]` yields `"PyAI, Deepgram"` for the required list, so the placeholder read *"Paste a PyAI, Deepgram key"*. Splitting on `,| or ` gives `"PyAI"` / `"OpenAI"`, which is what §7's `Paste a <first name in okList> key` means.
3. **Article agreement:** the placeholder renders *"Paste an OpenAI key"* rather than *"a OpenAI"*. One-word grammar fix to the §7 string.
4. **The `live` phase also renders `active`**, dimmed behind the committed transcript (`.live .dim` exists for exactly this in the prototype's CSS). §A9 says "render `transcript`"; showing the in-flight words matches the overlay's own bubble and makes the box visibly live.
5. **Screen 2's amber strip says "in Settings" as plain text, not a link.** The prototype's `<a onclick="return false">` was inert, and opening the Settings window mid-onboarding is not in DEV-A's §2 command list.
6. **A skipped test renders no `.trybox`.** The prototype's `done` state always had canned text; after "Skip the test" there is no transcript, and an "Inserted" box would claim a dictation that never happened. Headline, tips and Done still render.
7. **Focus and caret are restored explicitly in `render()`.** Keeping the input nodes alive removes the prototype's `value="${...}"` interpolation, but WebKit blurs a focused element when it is moved in the DOM, so the active field and its caret offset are captured before the rebuild and reapplied after.
8. **Typing does not force `reveal`.** The prototype set `L.reveal = true` on input only because it substituted bullet characters into `value`; with a real `type="password"` field there is nothing to work around, so a pasted secret stays masked until the eye is clicked.
9. **`clearSecond()` on a first-key change that closes the slot.** The resolver already ignores a stale `second`, so Continue cannot be phantom-jammed — but an invisible secret should not linger in a detached node. Only fires once a vendor is actually detected: mid-typing the slot is merely hidden, and wiping the cleanup key on every keystroke would be hostile.
10. **`VENDOR_ORDER` added to the resolver's exports** (not in §4.1's list) so the picker and the "where to get a key" list cannot drift apart. Still import-free.
11. **Prototype inline styles became classes** — `.chip.dashed`, `.kg.spaced`, `.discLink em`, `.rows`, `.watch`, `.note`/`.note.warn`, `.kr .getkey`, `.preview > .ico`. Production markup carries no `style=` attributes. The `<svg class="mark"><use href="#logo"/></svg>` sprite reference became `<img src="/verbatim-logo.svg">`, since this window has no inline SVG sprite.

## Things the plan got wrong or under-specified

- **§A10's `grep -c getCurrentWindow` = 0 is trap-sensitive to comments.** A comment *explaining* why the window must not hide itself trips the audit. Same class of trap in §A2 (`grep -c '<input'` matched a comment) and §A3 (`grep '^[[:space:]]*--'` matched a wrapped comment line starting with `--warn`). All three comments were reworded; worth knowing before anyone re-runs the audits and thinks they found a defect.
- **§4.3's `needStt` row does not say what `sttVendor`/`corrVendor` should be.** Implemented as `null` for both: the mode writes nothing, Continue is blocked, and a non-null `corrVendor` would let a caller that skipped the guard half-configure an install that cannot transcribe.
- **A9 does not say what Screen 3 shows after "Skip the test".** See deviation 6.
- **Nothing outside DEV-A's four files needed changing.** No cross-ownership edit was required or made.

## Needs a macOS runtime (adds to §9)

- Screen 1 at the fixed 566 px window with the worst case on screen (Anthropic first + required slot + role error + trust line + footer) — the pane clips and the footer is `margin-top:auto`, but only the Mac can confirm nothing is cut (**M3**, **R13**).
- The mic prompt appearing *in this window* from `getUserMedia`, and the denied path (Open Settings + Re-check), since macOS never re-prompts (**M3**).
- Whether the AX row flips live without a relaunch (**M12** / design-doc §9 #2). If a relaunch turns out to be required, the delta is one button plus one line of copy in `onboarding.ts`, which DEV-A owns.
- Screen 3 end-to-end with a real hotkey hold: needs DEV-C's `dictation-progress` emits to be live (**M10**).
- Focus/caret retention across re-renders in WKWebView specifically (the restore is written for it, unverifiable here).

## Review round 1

Three findings from `review.md`, all in `apps/widget/src/onboarding.ts`. All three accepted — no disagreement. Nothing outside DEV-A's files was touched.

### 1 · MAJOR — a rejected second key blamed the first vendor

**Was:** a 401 on the second key set the same `state.verify = "bad"` the first key uses, so `render()` reddened field 1 and the meta row read *"Deepgram rejected this key"* when the Anthropic cleanup key was the one refused. A valid speech key plus a typo'd cleanup key sent the user off editing the good key.

**Changed:** the two verdicts are now separate — a new `Verify2 = "idle" | "bad"` and `state.verify2` — and, more importantly, attribution moved out of the four render sites into one pure function:

`fieldStatus({verify, verify2, vendor, v2}) -> {bad1, bad2, msg1, msg2}`

`render()` takes both red borders from it, and `screen1()` takes both the meta row's message and the second slot's tail from it. Four sites reading one shared flag was the root cause, so the fix is one place that decides, not four places that agree. On a second-key rejection `verify` is reset to `"idle"` (the first key *was* accepted) and `verify2` becomes `"bad"`. A role mismatch still outranks a rejection in the second slot — the two cannot both be true for one paste, since a role error blocks before any `key_verify` runs. `verify2` is reset everywhere `verify` is: both input handlers, the vendor picker, and `clearSecond()`.

**Pinned by:** 12 new assertions in the UI suite driving the real extracted `fieldStatus`. The decisive ones: with a second-key rejection, `bad1 === false`, `msg1 === null`, `bad2 === true`, `msg2` names Anthropic, and `msg2` must not contain `"Deepgram"`. Plus first-key rejection, role-error precedence, a clean state, a stale second key, and `"checking"` flagging nothing. Verified the test actually catches the regression: re-running it against the pre-fix assignment (`verify: "bad"` for a second-key 401) fails 4 assertions with exactly the reported symptom.

### 2 · MINOR — the "saved anyway" chip never painted

**Was:** the offline outcome was set and then the code advanced to Screen 2 in the same tick, so the spec'd chip was only reachable via Back.

**Changed:** when a vendor was unreachable, Screen 1 is re-rendered **after** the keys and the patch are written, then held for `CHIP_BEAT_MS` (1200 ms) before advancing. Painting after the save means "saved anyway" is true when the user reads it.

**Chose the pause over carrying it into Screen 2** deliberately: PyAI has no probe yet (design-doc §9 #1) and therefore *always* returns `reachable: false`, so a Screen 2 strip would put a permanent "couldn't reach" warning on the default provider's happy path — noise, not information. §7 also places this string on Screen 1. Worth a look during the Mac pass: PyAI setups now always spend 1.2 s on that chip.

### 3 · MINOR — a failed boot `get_config` could downgrade a valid config

**Was:** `sanitizeCorrection(cfg.correctionProvider ?? "")` treated *absent* like *invalid*, so if `get_config` failed or returned a partial object, `""` sanitised to `"openai"` and a stored `anthropic` would be overwritten on any `raw` setup.

**Changed:** a module-level `cfgRead` records whether `get_config` actually returned. The repair only runs on a value that was really read (`cfgRead && current` truthy); with no config read, `correctionProvider` is left out of the patch entirely. "Absent" and "invalid" are now different cases.

### Gates after the fixes

- `npm run typecheck --workspace @verbatim/widget` — green, exit 0.
- `node --experimental-strip-types /tmp/resolver-check.mts` — `resolver OK`.
- `node --experimental-strip-types /tmp/ui-check.mts` — `ui helpers OK` (now 12 assertions heavier; the suite is generated from the real source by `/tmp/gen-ui-check.py`, which was fixed to extract a function whose *parameter* is an object type).
- Re-ran the audits: `getCurrentWindow` 0 · no `localStorage` · no `console.*` · all `data-act`s handled with no dead cases · all commands on-contract · no secret in a template literal · markup tag-balanced in all four screens.
