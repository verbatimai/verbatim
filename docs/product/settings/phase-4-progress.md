# Settings — Phase 4 (Cleanup / relabels) Progress

**Owner:** Mayank Banga · Saaslabs
**Date:** 13 Aug 2026
**Status:** Implemented (cloud-verified). On-Mac eyeball pass pending.

## Summary

Executed the reviewed Phase-4 plan (§7 "Cleanup / relabels"): removed two dead
`set-row` blocks, relabeled three stale "Not in use" tags to a new "Planned"
treatment, and added one theme-safe `.tag.planned` CSS rule. UI-only — no
`settings.ts`, no Rust, no `packages/core`. All cloud gates green.

## Files changed

| File | Edit |
|------|------|
| `apps/widget/settings.html` | Deleted "Preload speech model" set-row (Advanced) |
| `apps/widget/settings.html` | Deleted "Show widget while inactive" set-row (Preferences) |
| `apps/widget/settings.html` | "Mute dictation sounds" `tag off`→`tag planned`, text →"Planned" |
| `apps/widget/settings.html` | "Push to talk" `tag off`→`tag planned`, text →"Planned" |
| `apps/widget/settings.html` | "Draft mode" `tag off`→`tag planned`, text →"Planned" |
| `apps/widget/src/settings.css` | Added `.tag.planned` rule (accent2, 14% color-mix) after `.tag.cloud` |
| `apps/widget/src/settings.css` | Header comment (lines 2–3): "Not in use" → "Planned" |
| `apps/widget/src/settings.ts` | **No change** (untouched — none of the rows are referenced) |

## Tag inventory — before / after

| Control | Pane | Before | After |
|---------|------|--------|-------|
| Show widget while inactive | Preferences | `tag off` "Not in use" | **ROW REMOVED** |
| Preload speech model | Advanced | `tag off` "Not in use" | **ROW REMOVED** |
| Mute dictation sounds | Preferences | `tag off` "Not in use" | `tag planned` "Planned" |
| Push to talk | Shortcuts | `tag off` "Not in use" | `tag planned` "Planned" |
| Draft mode | Labs | `tag off` "Not in use" | `tag planned` "Planned" |
| Formatting | Dictation | `tag alpha` "Alpha" | `tag alpha` "Alpha" (kept as-is) |

**Outcome:** 0 "Not in use" · 0 "Cloud only" · 3 "Planned" · 1 "Alpha".
`.tag.off` / `.tag.cloud` CSS rules left in place (unused, harmless, likely reused).

## Test results — Cloud (executed)

- `cd apps/widget && npx tsc --noEmit` → **exit 0** (regression guard: HTML/CSS edits forced no TS change, nothing dangling).
- Grep on `settings.html`:
  - `Preload speech model` → **0**
  - `Show widget while inactive` → **0**
  - `Not in use` → **0**
  - `Cloud only` → **0**
  - `class="tag off"` → **0**
  - `class="tag planned"` → **3**
  - `class="tag alpha"` → **1**
- Grep on `src/settings.ts` for `preload|showWidget|inactive` → **0** (no orphaned TS reference).
- Grep on `src/settings.css` for `.tag.planned` → **1 rule present.**
- `--accent2` defined in all three theme scopes (`:root` @18, `body[data-theme="dark"]` @41, `prefers-color-scheme: dark` @52) → light + dark both resolve.
- HTML `<div>`/`</div>` balance: **78 / 78** (no dangling wrappers after deletions).

## On-Mac checklist (UNCHECKED)

- [ ] Open Settings → **no console error** on load.
- [ ] **Advanced** pane: "Preload speech model" row is gone; Debug mode is now the first row with a clean top edge (no stray border).
- [ ] **Preferences** pane: "Show widget while inactive" row is gone; Launch-at-login → Show-in-dock → Mute-others read as a continuous list. "Mute dictation sounds" shows a **Planned** badge, still disabled.
- [ ] **Shortcuts** pane: "Push to talk" shows **Planned**.
- [ ] **Labs** pane: "Draft mode" shows **Planned**, stays disabled.
- [ ] **Dictation** pane: "Formatting" still shows **Alpha**.
- [ ] The three **Planned** badges render (cyan accent2), read as "coming soon" not "broken", in both light and dark themes.

## Deviations

None. Implemented exactly as reviewed (all 7 MUST-follow bullets honored; deletions matched by full block content, not line number).

## Parked assumption

**"Show widget while inactive" was REMOVED** (plan §2 default / Open Question 1) on the
assumption the always-visible draggable orb is the intended idle model, making the toggle
redundant. This is a product decision, not mechanical, and is trivially reversible (re-add
the 12-line row). **Mayank can override** — if the orb's idle visibility should be
user-controllable, the alternative is repurposing the row as "Hide orb when idle," which
requires new overlay behaviour and is out of Phase-4 cleanup scope.
