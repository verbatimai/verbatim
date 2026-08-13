# Settings — Phase 4 (Cleanup / relabels) Implementation Plan

**Owner:** Mayank Banga · Saaslabs
**Date:** 13 Aug 2026
**Scope:** `settings-plan.md` **§7 "Cleanup / relabels"** — the final housekeeping pass after
Phases 1–3 wired most controls. Pure UI: `apps/widget/settings.html`,
`apps/widget/src/settings.ts`, `apps/widget/src/settings.css`. **No Rust, no `packages/core`.**
This is the lowest-risk phase in the series — it removes two dead rows and relabels stale tags
so the page reads as intentional rather than half-disabled.

**Cloud-testable.** Unlike Phases 1–3 (which authored uncompilable Rust), every edit here is
verifiable in the cloud via `apps/widget` `tsc --noEmit` + static grep. On-Mac is only an
eyeball pass.

---

## 0. Current state (what Phases 1–3 already cleaned)

The relabel audit's most important finding up front: **Phases 1–3 already removed the "Not in
use" / "Cloud only" tags from every control they wired.** Per the progress docs —
- Phase 1 un-gated launch-at-login, debug, reset (tags + `disabled` removed); dropped the
  Appearance tag.
- Phase 2 dropped the Self-correction "Cloud only" tag and the Paste-last "Not in use" tag.
- Phase 3 un-gated mic / auto-detect / telemetry (tags removed) and rebuilt the vocabulary +
  snippets panes.

So there are **no stale tags left on wired controls to remove** — the relabel pass is a
*verification* that this is true, not a big edit. The six remaining tag spans (grep below) are
all on genuinely-unbuilt controls or the two rows we are deleting. This is the clean baseline
Phase 4 finishes.

### Full tag inventory (grep `class="tag` in `settings.html`, live)

| # | Line | Pane | Control | Current tag | Wired? | **Phase-4 action** |
|---|------|------|---------|-------------|--------|--------------------|
| 1 | 193 | Preferences | Show widget while inactive | `tag off` "Not in use" | no (contradicted by orb) | **REMOVE ROW** (assumption — see §2) |
| 2 | 222 | Preferences | Mute dictation sounds | `tag off` "Not in use" | no (no chimes yet) | **KEEP → relabel "Planned"** |
| 3 | 293 | Dictation | Formatting | `tag alpha` "Alpha" | **yes** (Phase 2.3) | **KEEP AS-IS** (honest: wired but alpha-quality) |
| 4 | 349 | Shortcuts | Push to talk | `tag off` "Not in use" | no (Phase 5 / Wave 4) | **KEEP → relabel "Planned"** |
| 5 | 462 | Labs | Draft mode | `tag off` "Not in use" | no (Phase 6 / Wave 5) | **KEEP → relabel "Planned"** |
| 6 | 565 | Advanced | Preload speech model | `tag off` "Not in use" | no (cloud STT — N/A) | **REMOVE ROW** |

**Outcome after Phase 4:** zero "Not in use" tags remain · three "Planned" tags (mute sounds,
push-to-talk, draft mode) · one "Alpha" tag (formatting) · zero "Cloud only" (already gone).

### settings.ts reference check (the Phase-1 bug class)

The Phase-1 mute-others bug was: `settings.ts` did `getElementById("muteOthers")` before the
element existed → `TypeError` on open. To avoid the mirror-image of that (removing an element
that TS still references), I grepped `apps/widget` for `preload|inactive|showWidget|
mute_sounds|muteSounds|draftMode|pushToTalk` and every related token.

**Result: none of the six tagged rows carries an `id`, and `settings.ts` references none of
them.** The only grep hits are the HTML label text itself. Concretely:

- **Preload speech model** (line 570): `<input type="checkbox" disabled checked />` — no `id`.
- **Show widget while inactive** (line 198): `<input type="checkbox" disabled checked />` — no `id`.
- **Mute dictation sounds** (line 227): `<input type="checkbox" disabled />` — no `id`.
- **Push to talk** (line 352): `<span class="kbd-group"><kbd>Fn</kbd></span>` — no control at all.
- **Draft mode** (line 469): `<input type="checkbox" disabled />` — no `id`.

So the two row removals are safe precisely **because nothing in TS points at them** — there is
no `getElementById` to also delete or null-guard. This is called out per-item below anyway, per
the guardrail.

---

## 1. Item — Remove "Preload speech model" (Advanced pane)

**Goal:** delete the row entirely. Cloud STT has no local model to preload, so the control is
meaningless (and misleading — it implies an on-device model).

**Exact edit — `settings.html`:** delete the whole first `set-row` of the Advanced card,
**lines 562–572**:

```html
<div class="set-row">
  <div class="meta">
    <h3>
      Preload speech model <span class="tag off">Not in use</span>
    </h3>
    <p>Load the model at startup for faster first transcription.</p>
  </div>
  <label class="switch disabled"
    ><input type="checkbox" disabled checked /><span></span
  ></label>
</div>
```

After removal, **Debug mode** (currently lines 573–581) becomes the card's `:first-child`. The
CSS already handles this — `.set-row:first-child { border-top: none; }` (settings.css line 164)
— so no top-border artifact. No CSS edit needed.

**settings.ts refs to remove/guard:** **none.** The removed checkbox has no `id`; grep confirms
no `getElementById`/`querySelector` targets it. Nothing to change in TS.

---

## 2. Item — Reconcile "Show widget while inactive" (Preferences)

**Goal:** resolve the contradiction — the draggable orb already shows when idle, which is the
exact behaviour this toggle claims to gate. Two things can't both own "is the orb visible when
idle."

**DEFAULT DECISION (reversible — flagged for reviewer in Open Questions): REMOVE THE ROW.**
The orb-shows-when-idle model supersedes this toggle. We do **not** build new behaviour (no
"hide orb when idle" repurpose) in this phase — that would be a feature, not cleanup. If Mayank
wants the repurpose later, it's a separate small item (settings-plan §7 explicitly lists
"repurpose as 'hide orb when idle'" as the alternative).

**Exact edit — `settings.html`:** delete the whole `set-row`, **lines 189–200**:

```html
<div class="set-row">
  <div class="meta">
    <h3>
      Show widget while inactive
      <span class="tag off">Not in use</span>
    </h3>
    <p>Keep the overlay visible on screen when not recording.</p>
  </div>
  <label class="switch disabled"
    ><input type="checkbox" disabled checked /><span></span
  ></label>
</div>
```

This row sits between **Launch at login** (ends line 188) and **Show app in dock** (starts line
201); both are independent and unaffected. Neither is `:first-child`, so no border change.

**settings.ts refs to remove/guard:** **none.** The removed checkbox has no `id`; grep confirms
no TS reference. Safe.

---

## 3. Item — "Mute dictation sounds" (Preferences) → keep, relabel "Planned"

**Goal:** keep the control disabled (there are no start/stop chimes yet — nothing to mute) but
relabel it from the honest-but-negative "Not in use" to the intentional-roadmap "Planned"
treatment. Do **not** wire `mute_sounds`.

**Exact edit — `settings.html` line 222–223:** change the tag only. The row and its `disabled`
switch stay exactly as-is.

```html
<!-- before -->
Mute dictation sounds <span class="tag off">Not in use</span>
<!-- after -->
Mute dictation sounds <span class="tag planned">Planned</span>
```

**settings.ts refs:** none (no `id`; still inert). No change.

---

## 4. Item — Relabel pass (audit all remaining tags)

**Goal:** every tag on the page is honest. Per §0's inventory, after the two removals and the
mute-sounds relabel, the remaining tags to touch are the two other genuinely-unbuilt controls:

- **Push to talk** (line 349) — `tag off` "Not in use" → `tag planned` "Planned". Belongs to
  Phase 5 / Wave 4 (native `CGEventTap`). Row + `<kbd>Fn</kbd>` display unchanged.
- **Draft mode** (line 462) — `tag off` "Not in use" → `tag planned` "Planned". Belongs to
  Phase 6 / Wave 5. Row + disabled switch unchanged.

**Leave honest:**
- **Formatting** (line 293) — `tag alpha` "Alpha" stays. It IS wired (Phase 2.3) but is
  legitimately alpha-quality; the tag is honest and settings-plan §2.3 explicitly said to keep
  it.

**No stale tags on wired controls exist** (Phases 1–3 already stripped them — verified by grep:
zero "Cloud only" strings, and launch/debug/reset/mic/auto-detect/telemetry/self-correct rows
carry no tag). So the relabel pass adds nothing beyond the three "Not in use" → "Planned"
swaps (mute sounds §3, push-to-talk, draft mode).

**settings.ts refs:** none for any of these (no `id`s). No TS change.

---

## 5. Item — "Planned" grouping treatment (lightest approach)

**Goal:** make the still-unbuilt controls read as an intentional roadmap, not broken UI, with
the **lightest** CSS/markup change. Do not over-engineer (no new section, no reflow, no
JS-driven grouping).

**Decision: a single new tag variant `.tag.planned` + reuse the existing per-row `<p>`
descriptions as the "short note."** No extra markup, no per-row hint paragraphs — the three
Planned rows already have descriptive `<p>` copy, so a distinct badge is all that's needed to
signal "on the roadmap." This is markup-zero (only the tag class/text changes on existing spans)
and CSS-one-line.

**Exact edit — `settings.css`:** add one rule beside the existing tag variants (after line 173,
next to `.tag.off` / `.tag.alpha` / `.tag.cloud`):

```css
.tag.planned { color: var(--accent2); background: color-mix(in srgb, var(--accent2) 14%, transparent); }
```

`--accent2` (cyan, defined light+dark) reads as "coming soon / roadmap" and is visually
distinct from the muted-grey `.tag.off` ("broken/unavailable") — which is the whole point:
Planned should look deliberate, not disabled. (Reviewer alternative: if a cyan badge feels too
loud, drop this rule and let `.tag.planned` fall back to unstyled, or alias it to `.tag.off`'s
neutral look by copying that rule's body — the markup doesn't change either way.)

**Also update the stale CSS header comment** (settings.css lines 2–3):

```css
/* before */
Real controls (...) are wired to Tauri in settings.ts; reference-only rows are tagged "Not in use". */
/* after */
Real controls (...) are wired to Tauri in settings.ts; not-yet-built rows are tagged "Planned". */
```

**Why not a dedicated "Planned" section?** The unbuilt controls live in three different panes
(Preferences, Shortcuts, Labs) that group by *function*, not by build status. Yanking them into
one "Planned" section would break that mental model and require moving DOM across panes — far
heavier than a badge. The badge keeps each control where it functionally belongs while still
reading as intentional. (Noted as an open question in case the reviewer prefers a section.)

---

## 6. Summary of edits

| File | Edit | Lines (current) |
|------|------|-----------------|
| `settings.html` | Delete "Preload speech model" set-row (§1) | 562–572 |
| `settings.html` | Delete "Show widget while inactive" set-row (§2) | 189–200 |
| `settings.html` | "Mute dictation sounds": `tag off`"Not in use" → `tag planned`"Planned" (§3) | 222–223 |
| `settings.html` | "Push to talk": `tag off`"Not in use" → `tag planned`"Planned" (§4) | 349 |
| `settings.html` | "Draft mode": `tag off`"Not in use" → `tag planned`"Planned" (§4) | 462 |
| `settings.css`  | Add `.tag.planned` rule (§5) | after 173 |
| `settings.css`  | Update header comment "Not in use" → "Planned" (§5) | 2–3 |
| `settings.ts`   | **No change** — none of the touched rows are referenced | — |

`.tag.off` becomes unused after this phase (no element uses it). Leave the CSS rule in place —
it's 1 line, harmless, and likely reused for a future genuinely-unavailable control. (Optional:
delete it; noted as a minor open question.)

---

## 7. Test checklist

### Cloud-runnable (author here, must be green before handoff)

- [ ] `cd apps/widget && npx tsc --noEmit` → **exit 0.** (settings.ts is untouched, so this is
      a regression guard — proves the HTML/CSS edits didn't force a TS change and nothing dangles.)
- [ ] Grep `settings.html` for `Preload speech model` → **0 matches** (row gone).
- [ ] Grep `settings.html` for `Show widget while inactive` → **0 matches** (row gone).
- [ ] Grep `settings.html` for `Not in use` → **0 matches** (all relabeled/removed).
- [ ] Grep `settings.html` for `class="tag planned"` → **exactly 3** (mute sounds, push-to-talk,
      draft mode).
- [ ] Grep `settings.html` for `class="tag alpha"` → **exactly 1** (Formatting).
- [ ] Grep `settings.html` for `Cloud only` → **0 matches** (confirms no regression from Phase 2).
- [ ] Grep `apps/widget` for `preload|showWidget|inactive` in `.ts` files → **0 matches**
      (confirms no orphaned TS reference to a removed row).
- [ ] Grep `settings.css` for `.tag.planned` → **1 rule present.**

### On-Mac (eyeball — no build gate; pure HTML/CSS, but verify in the running app)

- [ ] Open Settings → **no console error** on load (regression guard for the removals).
- [ ] **Advanced** pane: "Preload speech model" row is gone; Debug mode is now the first row
      with a clean top edge (no stray border). Debug / telemetry / reset still work.
- [ ] **Preferences** pane: "Show widget while inactive" row is gone; Launch-at-login → Show-in-dock
      → Mute-others read as a continuous list. "Mute dictation sounds" now shows a **Planned**
      badge and remains disabled.
- [ ] **Shortcuts** pane: "Push to talk" shows **Planned**; the ⌥Space toggle + paste-last
      capture still work.
- [ ] **Labs** pane: "Draft mode" shows **Planned** and stays disabled; Self-correction toggle works.
- [ ] **Dictation** pane: "Formatting" still shows **Alpha**; toggle works.
- [ ] The Planned badge is visually distinct from a disabled/greyed control and reads as
      "coming soon," not "broken." Check in both light and dark themes.
- [ ] Sidebar search still filters the nav/panes correctly (search "labs", "advanced"). NOTE:
      the `navSearch` handler filters `.nav-item` buttons by pane label only — it does **not**
      index individual `set-row` labels — so removing/relabeling rows cannot affect it (a bonus
      safety confirmation, not a risk). Do not expect "mute"/"draft"/"push" to match anything.

---

## 8. Risks

1. **Very low overall.** No Rust, no core, no config schema, no TS logic — only HTML row
   deletions, tag text/class swaps, and one CSS rule. `tsc` is a full gate here (unlike Phases
   1–3 where it only covered the TS half).
2. **Orphaned-reference risk: mitigated.** The one real hazard (removing an element TS
   references — the Phase-1 bug class) does not apply: grep confirms neither removed row has an
   `id` or any `settings.ts` reference. The `tsc` + grep gates re-verify this.
3. **`.tag.off` becomes dead CSS.** Cosmetic only; left in place intentionally (see §6).
4. **"Show widget while inactive" removal is a product decision, not a mechanical one** — see
   Open Questions. It's trivially reversible (re-add the 12-line row), but if Mayank wants the
   idle-orb model to be *user-toggleable*, the right move is the "hide orb when idle" repurpose,
   which is out of scope here and would need real overlay behaviour.
5. **Line numbers will drift** as edits are applied top-to-bottom. Apply the two deletions by
   matching the quoted blocks (§1, §2), not by absolute line number, or apply bottom-up
   (Advanced §1 first, then Preferences §2) to keep earlier offsets stable.

---

## Open questions for reviewer

1. **"Show widget while inactive" — REMOVE (assumed default) vs. REPURPOSE.** This plan **removes
   the row** on the assumption that the always-visible draggable orb is the intended idle model,
   making the toggle redundant. **If instead the orb's idle visibility should be user-controllable**,
   we should keep the row and repurpose it as "Hide orb when idle" — but that requires new overlay
   behaviour (out of Phase-4 cleanup scope) and would move to a feature phase. **Confirm: remove, or
   hold the row for a future repurpose?** (Everything else in this plan is independent of this call.)
2. **Planned badge style.** Plan uses a cyan `.tag.planned` (distinct from grey `.tag.off`) so
   Planned reads as roadmap, not broken. OK, or prefer the neutral grey look (alias to `.tag.off`)?
3. **Planned *grouping* — badge vs. section.** Plan keeps each unbuilt control in its functional
   pane with a Planned badge (lightest, no DOM moves). Reviewer prefers this, or an actual grouped
   "Planned" section (heavier — controls span three panes)?
4. **Delete dead `.tag.off` rule?** After this phase nothing uses `.tag.off`. Leave it (1 line,
   likely reused) or delete for tidiness?
</content>
</invoke>
