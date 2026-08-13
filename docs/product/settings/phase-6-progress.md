# Settings — Phase 6 (Wave 5 · Draft mode) — Progress

**Owner:** Mayank Banga · Saaslabs
**Date:** 13 Aug 2026
**Phase:** 6 (Wave 5 — Product surface: Draft mode)
**Status:** COMPLETE as a **DESIGN deliverable**. Implementation blocked on Mayank's parked decisions.

---

## Summary

Draft mode is **decision-blocked, not code-blocked** (per `phase-6-plan.md` and the binding
`phase-6-review.md`). The disciplined output of this phase is a **design note + a parked decision list**, and
**no feature code**. That is exactly what shipped:

- **Design note delivered:** `docs/product/draft-mode.md` — concept, the non-generative-invariant contrast
  (grounded in `prompt.ts` `SYSTEM_PROMPT` line ~13 / `FORMAT_PROMPT` line ~26), UX flows considered
  (trigger, insert-vs-review, streaming, context scope), architecture options reusing real seams
  (`PyAiCorrection.messages()`, a proposed `generate()` + `DRAFT_PROMPT`, `mode:"draft"` start frame,
  `finalizeOnce` branch, the `main.ts:289-295` injection intercept, serde-default config), the full parked
  decision list (§5.1–§5.9, including the review-added §5.9 generation-failure fallback), a privacy/trust
  section, and a phased build proposal (P1–P5) for after decisions land.
- **No feature code shipped — by design.** No `DRAFT_PROMPT`, no `generate()`, no pipeline `draft` branch, no
  widget review UI, no trigger wiring.
- **No `draft_mode` config field added** — its *shape* is gated by decision §5.1 (bool vs
  `draft_mode_hotkey: String`), and Rust in `src-tauri` is not cloud-verifiable. Per plan §5.4 and the
  reviewer's agreement, it stays unbuilt.
- **Labs "Draft mode" row unchanged.** `apps/widget/settings.html:456-467` remains a disabled `Planned`
  placeholder wired to nothing — the intended end state. Confirmed, not edited.

---

## Files changed (exactly two docs — no code)

1. `docs/product/draft-mode.md` — **new** design note (the phase deliverable).
2. `docs/product/settings/phase-6-progress.md` — **new** (this file).

No TypeScript, no Rust, no HTML, no feature code touched. The Labs placeholder row was not edited.

---

## Parked decision list (pointer)

The full parked decision list lives in **`docs/product/draft-mode.md` §5**. Summary of what needs Mayank's
call before any build:

1. **§5.1 Trigger** — dedicated hotkey vs a mode of ⌥Space vs webview toggle. *(gates config shape + Rust)*
2. **§5.2 Insert vs review** — review-first vs insert+undo vs configurable. *(gates widget UX + inject intercept)*
3. **§5.3 Model / adapter** — reuse `gpt-5.6-sol` correction provider vs a separate/stronger generation model.
4. **§5.4 `DRAFT_PROMPT` design** — tone/length, meta-instructions, vocabulary, non-English, anti-hallucination.
5. **§5.5 Trust/labeling** — make it obvious the output is model-authored, not a transcript.
6. **§5.6 Privacy/consent** — generative-consent question; instructions/outputs **never logged or telemetered** (hard rule).
7. **§5.7 Context scope** — instruction-only (recommended v1) vs read the focused field.
8. **§5.8 Streaming/history** — one-shot no-history default for v1.
9. **§5.9 Generation-failure fallback** — no safe offline fallback (raw = the instruction). Recommend error + retry, never auto-inject an un-generated result.

---

## Testing / baseline

- **Cloud baseline unchanged: 106/106 passing** (16 test files) via `npm test`. No regressions — this proves
  no code shipped.
- **No TS or Rust changed**, so `typecheck` is a formality this phase; the baseline confirms the untouched
  code is still green.
- No on-Mac tests apply — no Rust/Tauri UI changes were made.

---

## Completion

Phase 6 is **complete as a DESIGN deliverable**. The design note captures decisions rather than making them,
so it is 100% decision-independent and safe to have authored now. Implementation (P1–P5 in `draft-mode.md`
§7) is **blocked on Mayank's decisions (§5.1–§5.9)** and should not begin until those land.
