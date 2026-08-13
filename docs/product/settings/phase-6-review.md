# Settings — Phase 6 (Wave 5 · Draft mode) — Reviewer Cross-Check

**Reviewer pass over:** `docs/product/settings/phase-6-plan.md`
**Against:** live code in `/home/claude/verbatim` · scope `settings-plan.md` §6
**Date:** 13 Aug 2026
**Role:** feasibility cross-check BEFORE the design note (`docs/product/draft-mode.md`) is written. No implementation.

---

## Verdict: GO for the design-note author.

Every feasibility claim in the plan is **confirmed against real code**, and every line citation I spot-checked
is accurate. The plan's scope call ("design + park, build nothing") is **correct and I agree with it** — I
pushed on the build-nothing recommendation (§ below) and it holds. One decision was missing from §4; I added
it inline (`§4.9`, generation-failure fallback). The design note can proceed.

---

## Feasibility claims — confirmed with real line cites

### 1. Non-generative invariant (the load-bearing claim) — CONFIRMED
`packages/core/src/correction/prompt.ts` — **both** LLM passes are contractually non-generative, so draft
mode's "generate new text" is a genuinely new capability, not a tweak:

- **`SYSTEM_PROMPT` (correction), line 13:** *"DO NOT add or change punctuation, capitalization, spacing, or
  wording. DO NOT rephrase, reorder, or 'improve' grammar … If the transcript has no disfluencies, return an
  EMPTY edits array."* (plan cites `prompt.ts:6-17` ✓)
- **`FORMAT_PROMPT`, line 26:** *"Do NOT add new information, opinions, or content the speaker didn't say, and
  do not change meaning. Preserve the speaker's words."* (plan cites `prompt.ts:21-27` ✓)

Draft mode inverts exactly this. The plan's framing — "different prompt, different adapter method, different
privacy story; you cannot toggle it on over the existing path" — is accurate.

### 2. Adapter transport reuse — CONFIRMED
`packages/core/src/correction/pyai.ts:20-43` — `private async messages(body, label)` POSTs to
`${PYAI_BASE}/messages` (default base `https://api.pyai.com/v1`), Anthropic-Messages-style, with
retry/backoff on transient 5xx/429. Both public methods funnel through it: `correct()` (45-65) and
`format()` (67-82). A new `DRAFT_PROMPT` would ride `messages()` verbatim via a third method. The plan's
claim that transport is reusable but prompt/method are new is correct.

Corroborating: `CorrectionProvider` (`types.ts:44-58`) exposes only `correct` + optional `format` — neither
fits a generative call, confirming a **new method** is required (plan §3.1 ✓). All three vendor adapters share
`prompt.ts` and are registered in `registry.ts:11-18` (`pyai`/`openai`/`anthropic`/`mock` all present ✓), so
"one method + one prompt propagates the same way" holds.

### 3. Auto-inject / no-review — CONFIRMED
`apps/widget/src/main.ts:289-295` — on the `formatted` message the webview sets `finalText = m.text` and
immediately calls `void injectFinal(m.text)` (line 294). `injectFinal` (255-277) invokes the Rust
`inject_text` command with **no review/confirm step**. So "review, then insert" is a genuinely new UI state
that must intercept before line 294. Confirmed.

The `mode`/behaviour-flag start frame the plan proposes to extend (`main.ts:336-348`: `mode`, `correct`,
`format`, `autoDetect`, `vocabulary`, `snippets`, `telemetry`) is real ✓, as is the trigger seam
(`listen("dictation", …)` start/stop at `main.ts:552-555`, `beginDictation()` at 116-122 ✓).

### 4. Labs "Draft mode" row is an inert placeholder — CONFIRMED, no edit needed
`apps/widget/settings.html:456-467` — the row's checkbox is `<input type="checkbox" disabled />` with **no
`id`**, inside `<label class="switch disabled">`, tagged `Planned`. Nothing wires it (grep for `draft` in
`apps/widget/src/settings.ts` → no matches). This is the intended end state. The plan's "leave as-is /
confirm, don't change" is correct. **No edit applied.**

### 5. Config store is backward-compat-safe — CONFIRMED (mechanically), shape still gated
`apps/widget/src-tauri/src/main.rs:110-133` — `AppConfig` is `#[serde(rename_all = "camelCase", default)]`
with an explicit `impl Default` (135-160). Any new field deserializes cleanly from an old `settings.json`
(missing → default) — the exact mechanism that carried `correct`/`format`/`telemetry`/`fn_push_to_talk`. The
`paste_last_hotkey: String` precedent the plan cites for a "separate hotkey" world is real (`main.rs:127`,
default `""`, applied via `apply_paste_last_hotkey`). So adding a draft flag is mechanically free but its
**shape** (bool vs `String` hotkey) is genuinely decision-gated by §4.1. Confirmed.

**Citation accuracy note:** I checked ~15 of the plan's line cites (prompt.ts, pyai.ts, types.ts, pipeline.ts,
main.ts, settings.html, main.rs, registry.ts) — **all accurate.** No citation fixes were required. This is a
well-grounded plan.

---

## Build-nothing recommendation — I AGREE (pushed back, it holds)

The plan recommends building **no code**, not even the "optional" inert `draft_mode: bool` (§5.4). I tested
that against the temptation to ship a visible momentum marker, and I agree it should stay unbuilt:

1. **Shape is decision-gated (§4.1).** `bool` vs `draft_mode_hotkey: String` are different worlds. Committing
   `bool` now risks a rename/migration once the trigger decision lands. A field that costs a future migration
   is not "free."
2. **Un-verifiable in cloud.** It's Rust in `src-tauri` — per project convention it can only be
   `cargo build`-verified on the Mac, so authoring it here ships an unverified diff for zero behaviour.
3. **Buys nothing.** Read by nothing until behaviour exists; the `Planned` toggle already communicates intent.

The disciplined output — design note + parked decision list + honest "almost nothing is safe to build" — is
the right call and matches §6 scope ("design note first, before any code; feature out of scope beyond the
disabled placeholder"). Building any behaviour would be **off-plan**, not just premature.

The pipeline finalize seam (`pipeline.ts:262-293`, `correct→format→emitFormatted`, flags read at 270-271) is
confirmed as the clean branch point for a future `draft` path — so the plan is right that the seam *exists* and
right that adding the branch now would ship an untestable, contract-guessing stub.

---

## Decisions list — complete after one addition

The plan's §4 covers the five decisions in scope (trigger §4.1, insert-vs-review §4.2, model/adapter §4.3,
privacy/consent §4.6, context scope §4.7) plus prompt design §4.4, trust/labeling §4.5, streaming/history §4.8.
That is complete and correctly PARKED.

**One decision was missing — added inline as §4.9 (Failure behaviour):**
Dictation's finalize path has a deterministic offline fallback — on error it emits the raw/cleaned transcript
(`pipeline.ts:287-289` → `emitFormatted(raw)`, plus `localFormat`). **Draft mode has no safe equivalent:** the
accumulated audio is an *instruction*, so falling back to the raw transcript would inject the literal
instruction ("draft a reply saying no") — worse than nothing. On a `generate()` failure/timeout, does draft
mode surface an error and inject nothing (safe default), offer retry/regenerate, or fall back to inserting the
cleaned instruction with a warning? This gates the pipeline draft branch's catch path and the review UI's error
state. This is a **safety-relevant** decision distinct from privacy (§4.6) and UX (§4.2), so it deserved its own
entry. Recommendation to consider: never auto-inject an un-generated result (error + retry).

Two smaller items already handled adequately and **not** raised to §4 status: **naming** ("Draft mode" vs
"Compose"/"Ask") is parked in §8; **instruction pre-cleaning** (does the spoken instruction itself get
disfluency-corrected before feeding `generate()`?) is implicitly covered by §4.4 prompt design and can be a
sub-point there rather than a separate decision.

---

## Go / no-go for the design-note author

**GO.** Write `docs/product/draft-mode.md` per the plan's §6 outline. It MUST include:

1. **The non-generative-invariant contrast** (§6.2) — cite `prompt.ts` SYSTEM_PROMPT (line 13) and FORMAT_PROMPT
   (line 26) verbatim so the reader sees draft mode inverts a load-bearing contract, and the auto-inject flow it
   intercepts (`main.ts:289-295`).
2. **Real architecture seams** (§6.4) — a proposed `generate()` on `CorrectionProvider` reusing
   `PyAiCorrection.messages()` (`pyai.ts:20-43`); a `DRAFT_PROMPT` sibling in `prompt.ts`; a `mode:"draft"` /
   `draft` flag on the `start` frame (`main.ts:336-348`); a parallel `finalizeOnce` branch
   (`pipeline.ts:262-293`); the injection intercept at `main.ts:289-295`. Draw the option boundaries so §4
   decisions map to concrete code sites.
3. **The full decision list §4 lifted verbatim — now including §4.9 (failure fallback).** This is the heart of
   the note.
4. **Privacy & trust** (§6.6) — generative-output labeling (§4.5), no logging/telemetry of instructions or
   outputs (`telemetry` metadata-only, `main.rs:130`), BYOK-vs-PyAI routing.
5. **Phased build-after-decisions plan** (§6.7) — mark P1 (`generate()`+`DRAFT_PROMPT`, eval fixtures) and P2
   (pipeline branch) as **cloud-testable**; P3 widget UX + P4 config/Labs + P5 context-aware as **on-Mac only**.

The note captures decisions rather than making them, so it is 100% decision-independent and safe to author now.

---

## Edits applied

- `docs/product/settings/phase-6-plan.md` — added **§4.9 Failure behaviour** to the PARKED decision list
  (the one missing decision; safety-relevant, no safe local fallback). No other changes; all existing line
  citations verified accurate and left intact. The §6.5 outline ("lift §4 verbatim") auto-picks up §4.9.
