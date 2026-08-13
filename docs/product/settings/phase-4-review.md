# Settings — Phase 4 (Cleanup / relabels) Review

**Reviewer pass** · Date: 13 Aug 2026 · Verifier: cross-check plan vs. live code before implementation.
**Files reviewed:** `apps/widget/settings.html`, `apps/widget/src/settings.ts`,
`apps/widget/src/settings.css`, `docs/product/settings/phase-4-plan.md`, `settings-plan.md` §7.

---

## Verdict: **GO** (cleared for dev)

The plan is accurate against the live code. Every line reference checks out, the two row
removals are provably safe (no wired `id`, no TS reference — the Phase-1 `TypeError` class cannot
recur), the tag inventory is complete, and the CSS approach is one line and consistent with
existing tag variants. Two minor inaccuracies were found and fixed inline in the plan (details
below). None block implementation.

---

## Line-reference verification (all CONFIRMED against live code)

| Plan claim | Live code | Result |
|---|---|---|
| "Show widget while inactive" set-row = lines 189–200 | `<div class="set-row">` @189 → `</div>` @200 | ✅ exact |
| ↳ tag span @193, disabled checkbox @198 (no `id`) | `<span class="tag off">` @193, `<input type="checkbox" disabled checked />` @198 | ✅ no `id` |
| ↳ sits between Launch-at-login (ends @188) & Show-in-dock (starts @201) | confirmed | ✅ neither is `:first-child` |
| "Preload speech model" set-row = lines 562–572 | `<div class="set-row">` @562 → `</div>` @572 | ✅ exact |
| ↳ tag @565, disabled checkbox @570 (no `id`) | `<span class="tag off">` @565, `<input ... disabled checked />` @570 | ✅ no `id` |
| ↳ Debug mode (573–581) becomes `:first-child`; `.set-row:first-child{border-top:none}` @164 | confirmed @164 | ✅ no border artifact, no CSS edit needed |
| "Mute dictation sounds" tag @222 | `<span class="tag off">` @222 | ✅ |
| "Push to talk" tag @349 (control is `<kbd>Fn</kbd>` @352, no input) | confirmed | ✅ |
| "Draft mode" tag @462 (disabled checkbox @469, no `id`) | confirmed | ✅ |
| "Formatting" tag @293 = `tag alpha` "Alpha", **wired** (`#formatToggle` @300) | confirmed | ✅ keep as-is |
| CSS insert point after `.tag.cloud` @173; header comment @2–3 | confirmed | ✅ |

**Markup validity after removals:** each removed block is a complete, self-contained `<div
class="set-row">…</div>` child of its `.card` wrapper. Deleting either leaves the `.card` and all
sibling rows intact — **no orphaned card wrappers, no dangling tags**. Confirmed.

---

## No-wired-id safety check (the Phase-1 bug class) — CONFIRMED SAFE

- Grep of `settings.ts` for `preload|inactive|showWidget|mute_sounds|muteSounds|draftMode|
  pushToTalk|Preload|Not in use|Cloud only` → **0 matches.**
- Both removed rows' checkboxes have **no `id`** (verified in HTML). There is no
  `getElementById`/`querySelector` in TS pointing at them, so there is nothing to null-guard or
  delete in TS. The mirror-image of the Phase-1 mute-others `TypeError` (removing an element TS
  still references) **cannot occur here.**
- **Bonus confirmation:** the only place TS touches row-level DOM broadly is the sidebar search
  (`settings.ts:467–475`), and it filters `.nav-item` **pane buttons** by label — it never
  indexes `.set-row` elements. Removing/relabeling rows is invisible to it.

---

## Tag inventory completeness — CONFIRMED COMPLETE

Live grep `class="tag` in `settings.html` returns **exactly 6** occurrences — every one is in the
plan's §0 table with a correct action:

| Line | Control | Tag | Plan action | Verdict |
|---|---|---|---|---|
| 193 | Show widget while inactive | `tag off` | REMOVE ROW | ✅ |
| 222 | Mute dictation sounds | `tag off` | relabel → Planned | ✅ |
| 293 | Formatting | `tag alpha` | keep (wired, honestly alpha) | ✅ |
| 349 | Push to talk | `tag off` | relabel → Planned | ✅ |
| 462 | Draft mode | `tag off` | relabel → Planned | ✅ |
| 565 | Preload speech model | `tag off` | REMOVE ROW | ✅ |

**Phases 1–3 stale-tag strip verified.** Grep confirms **zero "Cloud only"** strings remain, and
the wired controls listed in the review scope carry **no tag**: `muteOthers` (@216),
`launchAtLogin` (@186), `debugMode` (@579), Appearance/`themeSeg` (@174), `resetBtn` (@604),
`selfCorrect` (@457), `formatToggle` (@300 — keeps its honest `alpha` tag), `micDevice` (@287),
`autoDetect` (@278), `telemetry` (@591), vocabulary (`vocabInput`/`vocabAdd`), snippets
(`snipTrigger`/`snipAdd`). **No stale "Not in use" tag remains on any wired control** → the plan's
removal list needs no additions. Outcome after Phase 4 holds: 0 "Not in use", 3 "Planned"
(mute-sounds / push-to-talk / draft-mode), 1 "Alpha" (formatting), 0 "Cloud only".

---

## "Planned" CSS approach — CONFIRMED CSS-light & consistent

- One rule, `.tag.planned`, added beside `.tag.off`/`.tag.alpha`/`.tag.cloud` (settings.css
  after @173). No new section, no DOM moves, no JS. Correct — lightest viable change.
- `--accent2` (cyan) is defined in **all three theme scopes** (`:root` @18, `body[data-theme="dark"]`
  @41, and the `prefers-color-scheme: dark` system block @52), so light + dark both resolve. ✅
- The existing `.tag.alpha`/`.tag.cloud` rules use `color-mix(... 14% ...)`; the plan originally
  proposed **16%**. **Fixed inline to 14%** for exact consistency with the established tag
  convention (see corrections).

---

## Cloud-test approach — CONFIRMED VALID

`tsc --noEmit` + static grep is the right gate for this phase: `settings.ts` is untouched, so
`tsc` is a pure regression guard (proves the HTML/CSS edits forced no TS change / left nothing
dangling), and the grep assertions (`Preload speech model`→0, `Show widget while inactive`→0,
`Not in use`→0, `class="tag planned"`→3, `class="tag alpha"`→1, `Cloud only`→0, `.ts` refs to
removed rows→0) are all mechanically checkable and match the current file state. The "Show widget
while inactive" removal is correctly flagged as a **reversible product assumption** (§2 default
DECISION + Open Question 1 + Risk 4) — reviewer concurs it is the right default and trivially
re-addable.

---

## Numbered corrections (applied inline to `phase-4-plan.md`)

1. **[applied] `.tag.planned` opacity 16% → 14%.** §5's proposed rule used a `16%` color-mix,
   inconsistent with the existing `.tag.alpha`/`.tag.cloud` (both `14%`). Aligned to **14%** so the
   Planned badge matches the house tag convention. (Cosmetic; the accent2 hue still makes it
   distinct from grey `.tag.off`.)
2. **[applied] Test checklist — sidebar-search item corrected.** The on-Mac item "Sidebar search
   still matches these rows by label (search 'mute', 'draft', 'push')" is based on a misconception:
   `navSearch` (`settings.ts:467–475`) filters `.nav-item` **pane buttons** by label, not
   individual `set-row` labels — searching "mute"/"draft"/"push" matches nothing regardless of this
   phase. Rewrote the item to test pane filtering and to note (as a bonus) that row edits can't
   affect search. No code impact.

**No missed tags, no orphaned markup, no un-guarded TS reference were found.**

---

## Go / No-Go: **GO** — MUST-follow bullets for the dev

1. **Apply the two deletions by matching the quoted `set-row` blocks, not absolute line numbers**
   (or delete bottom-up: Advanced §1 @562–572 first, then Preferences §2 @189–200), since earlier
   deletions shift later offsets. The plan's Risk 5 already says this — honor it.
2. **Delete each `set-row` in full** (`<div class="set-row">` … its closing `</div>`) — 189→200 and
   562→572 inclusive. Do not leave the `.meta`/`.h3`/`<label>` fragments.
3. **Touch nothing in `settings.ts`.** It has no reference to any removed/relabeled row; the only
   TS gate is `tsc --noEmit` staying green as a regression check.
4. **Relabels are class+text only:** `tag off` "Not in use" → `tag planned` "Planned" on the three
   rows (@222 mute-sounds, @349 push-to-talk, @462 draft-mode). Leave each row's disabled control /
   `<kbd>` and `<p>` copy untouched.
5. **Add exactly one CSS rule** (`.tag.planned`, 14% mix) after settings.css:173, and update the
   header comment (lines 2–3) "Not in use" → "Planned". Leave the now-unused `.tag.off` (and the
   already-unused `.tag.cloud`) rules in place — harmless, likely reused.
6. **Confirm the "Show widget while inactive" removal with Mayank** (Open Question 1) before or at
   merge — it is a product decision (remove vs. repurpose as "hide orb when idle"), not mechanical.
   Everything else in the phase is independent of that call and can proceed regardless.
7. **Green all cloud grep assertions + `tsc --noEmit` before handoff;** on-Mac is an eyeball pass
   only (no build gate — pure HTML/CSS).
