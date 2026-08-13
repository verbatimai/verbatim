# Settings — Phase 6 (Wave 5 · Product surface: Draft mode) Scope + Design Plan

**Owner:** Mayank Banga · Saaslabs
**Date:** 13 Aug 2026
**Scope:** `settings-plan.md` **§6 "Wave 5 — Product surface: Draft mode"**.
Speak an instruction → generate text → review → insert. This is a **new product surface**, not a
setting. Per §6 the deliverable is a **design note first** (`docs/product/draft-mode.md`); the feature
is *"out of scope for this settings pass beyond keeping the Labs toggle as a disabled placeholder."*

**⚠ This phase is DECISION-BLOCKED, not code-blocked.** Draft mode's core behaviour (trigger,
insert-vs-review, which model, prompt, privacy posture) each needs a **product decision from Mayank**.
Per his directive — *"do whatever is feasible and possible; if it needs my decision, hold that part
and do what is feasible"* — the disciplined output of this phase is: **(1)** the design note, **(2)** an
honest assessment that almost nothing is safe to *build* yet, and **(3)** a specific, parked decision
list that is the real value handed back. This plan deliberately does **not** schedule
decision-dependent behaviour as "to build now."

---

## 0. Goal

Produce two artifacts and nothing that pre-commits a product decision:

1. **`docs/product/draft-mode.md`** — the design note (concept, UX flows considered, architecture
   options that reuse the existing pipeline/adapters, the decision list, and a *phased* build proposal
   for AFTER the decisions land). Outline in §6 below.
2. **This plan** — the scope call, the feasibility assessment grounded in the live code, the
   decisions-needed list (§4, PARKED), and the minimal decision-independent build (§5).

Non-goal: shipping any draft-mode *behaviour*. The Labs toggle stays a disabled "Planned" placeholder.

---

## 1. Scope decision

**Concrete Phase 6 deliverable = the design note + a code-grounded feasibility read + the parked
decision list.** No feature behaviour ships.

Why this is the right call (not sandbagging):

- §6 itself scopes Wave 5 to *"a short design note first … before any code"* and *"out of scope for
  this settings pass beyond keeping the Labs toggle as a disabled placeholder."* Building the feature
  would be off-plan.
- Draft mode inverts a **load-bearing invariant** of the current pipeline. Both LLM passes today are
  explicitly **non-generative**: the correction system prompt says *"DO NOT rephrase, reorder, or
  'improve' … return an EMPTY edits array"* (`packages/core/src/correction/prompt.ts:6-17`) and the
  format prompt says *"Do NOT add new information, opinions, or content the speaker didn't say …
  Preserve the speaker's words"* (`prompt.ts:21-27`). Draft mode's entire job is the **opposite** —
  generate new text from an instruction. That is a different prompt, a different adapter method, and a
  different privacy story. You cannot "toggle it on" over the existing path.
- The current final-text flow **auto-injects** with no review step: on `formatted`, the webview calls
  `void injectFinal(m.text)` immediately (`apps/widget/src/main.ts:294`). Draft mode's "review, then
  insert" requires a *new* UI state that intercepts before injection. That UI's shape depends on the
  insert-vs-review decision (§4.2).

So the honest scope is: **design + park**. §5 lists the *only* code that is both safe and useful to
touch now, and it is minimal.

---

## 2. What already exists (the placeholder is correct today)

- **Labs pane, Draft mode row** — `apps/widget/settings.html:456-467`:
  ```html
  <h3>Draft mode <span class="tag planned">Planned</span></h3>
  <p>Hold to speak an instruction; review the generated text, then insert it.</p>
  <label class="switch disabled"><input type="checkbox" disabled /><span></span></label>
  ```
  The checkbox is **`disabled`, has no `id`, and is not wired in `settings.ts`** (grep for `draft` in
  `apps/widget/src/settings.ts` → no matches). This is exactly the intended end state for this pass:
  it reads as an intentional "Planned", not a half-built control. **No change is required here.**
- The copy ("Hold to speak an instruction; review the generated text, then insert it") already implies
  two of the parked decisions — a **hold** trigger and a **review-before-insert** step. Treat that copy
  as a *proposal*, not a committed decision (see §4.1, §4.2).

---

## 3. Feasibility assessment (grounded in the live code)

The good news: the architecture is well-shaped to *host* draft mode later with little new plumbing.
The blocker is product decisions, not missing seams. Concrete findings:

### 3.1 The adapter layer can be reused — but draft mode needs a NEW method, not `correct`/`format`

`CorrectionProvider` (`packages/core/src/correction/types.ts:44-58`) exposes exactly two methods:
`correct(rawSegment, ctx)` (diff cleanup) and optional `format(text, language, vocabulary)`
(whole-text polish). **Neither fits draft mode**, because both are contractually non-generative (see
§1). Draft mode wants an *instruction → freshly generated text* call.

What IS reusable is the **transport**, not the prompt. In the default adapter, both public methods
funnel through one private HTTP helper:
`PyAiCorrection.messages(body, label)` → `POST {PYAI_BASE}/messages`, Anthropic-Messages-style,
`model gpt-5.6-sol`, with retry/backoff on 5xx/429 (`packages/core/src/correction/pyai.ts:20-43`,
`45-65`, `67-82`). A draft-mode generate call would be a **third method** on the provider (e.g.
`generate(instruction, ctx): Promise<{ text: string }>`) that reuses `messages()` verbatim but sends a
**new generative system prompt** (a `DRAFT_PROMPT` sibling to `SYSTEM_PROMPT`/`FORMAT_PROMPT` in
`prompt.ts`). Every vendor adapter (`pyai.ts`, `openai.ts`, `anthropic.ts`) already shares `prompt.ts`
and is registered in `correction/registry.ts:11-18`, so adding one method + one prompt propagates the
same way the existing passes do. **But** the method's *signature* (does it take focused-field context?
does it stream?) is decision-dependent (§4.7, §4.8) — so authoring it now would bake in a guess.

### 3.2 The pipeline finalize path is where a draft branch would live — but it assumes correct→format

`Pipeline.startStreaming` → `finalizeOnce()` (`packages/core/src/pipeline.ts:262-293`) hard-codes the
sequence: `correct()` (if `opts.correct`) → `format()` (if `opts.format`) → `emitFormatted()`. Draft
mode would need a *parallel* finalize branch: take the accumulated transcript as an **instruction**
(not content to clean) and call `generate()` instead. The toggle plumbing already demonstrates the
pattern — `PipelineOptions.correct`/`format` are read at `pipeline.ts:270-271` and threaded from the
WS `start` frame — so a future `draft?: boolean` (or a `mode` discriminator) would slot in the same
way. This is a clean seam, but adding it now would ship an unused, untestable-in-isolation branch whose
exact contract depends on §4.

### 3.3 The widget flow has a clean trigger seam and a clean injection seam — both need a decision

- **Trigger.** Dictation is driven by two events the webview listens for:
  `listen("dictation", …)` with payloads `"start"` / `"stop"` (`apps/widget/src/main.ts:552-555`),
  emitted from Rust's global-shortcut handler. `beginDictation()` (`main.ts:116-122`) →
  `startLive()` → `connect("live")`. A draft trigger is either (a) a **new payload / event** from a
  **separate hotkey** (Rust config + accelerator, like `paste_last_hotkey` at `main.rs:127`), or
  (b) a **mode of the existing hotkey** (e.g. a modifier, or a webview toggle). This is decision §4.1.
- **Mode on the wire.** `connect()` already sends a `mode` field (`"demo" | "live"`) plus a bag of
  behaviour flags on the `start` frame (`main.ts:336-348`: `correct`, `format`, `autoDetect`,
  `vocabulary`, `snippets`, `telemetry`). A `mode: "draft"` (or `draftMode: true`) would ride the same
  frame with zero new transport — *once we know it exists*.
- **Insert vs review.** Today `formatted` → `finalText = m.text` → **auto-inject**
  (`main.ts:289-295`, calling `injectFinal` → Rust `inject_text` at `main.ts:255-277`). Draft mode's
  "review then insert" means intercepting here to render the generated text in a **review state** with
  an explicit Insert/Discard/Redo action, only *then* calling `injectFinal`. The card already has a
  final-output box (`finalOut`) and a Copy button, so a review UI is a modest extension — but its exact
  shape is decision §4.2.

### 3.4 Config store is backward-compat-safe for a future flag — but the flag's SHAPE is undecided

`AppConfig` (`apps/widget/src-tauri/src/main.rs:110-160`) is
`#[serde(rename_all = "camelCase", default)]` with an explicit `impl Default`, so **any** new field
deserializes cleanly from an old `settings.json` (missing field → default) — the same mechanism that
carried `correct`/`format`/`telemetry`/`fn_push_to_talk`. Adding a draft flag is *mechanically* free.
The catch: whether it's a `draft_mode: bool` (a "mode of the existing hotkey" world) or a
`draft_mode_hotkey: String` (a "separate hotkey" world, like `paste_last_hotkey`) is **decided by §4.1**.
Committing the wrong shape now creates a migration later. So even this "free" field is decision-tainted.

**Bottom line:** every seam draft mode needs already exists and is clean (adapter transport, prompt
module, pipeline flags, `mode` on the start frame, the injection intercept point, serde-default config).
None of it is *missing*. All of it is *shaped by a decision that hasn't been made.* Hence: design + park.

---

## 4. Decisions needed from Mayank — **PARKED** (this list is the deliverable)

Nothing below should be built until decided. Ordered roughly by how much downstream code each gates.

### 4.1 Trigger — separate hotkey, or a mode of the existing one? *(gates config shape + Rust)*
Options: (a) a **dedicated global hotkey** (new `draft_mode_hotkey` config like `paste_last_hotkey`,
own accelerator registration in `main.rs`, emits a new `dictation`-style event); (b) a **modifier on
⌥Space** (e.g. ⌥⇧Space) branching in the existing handler; (c) a **webview mode toggle** (a button in
the card that switches the next session to draft). Decision fixes the config field shape (§3.4) and
whether Rust work is even in scope. *Recommendation to consider: (a) a separate hotkey — cleanest
mental model ("dictate" vs "draft"), reuses the `paste_last_hotkey` pattern, no overloading of ⌥Space.*

### 4.2 Insert directly, or open a review UI first? *(gates the widget UX + the auto-inject intercept)*
Today's flow auto-injects (`main.ts:294`). Draft-generated text is *new content*, so blind injection is
riskier than dictation. Options: (a) **review-first** (render generated text, explicit Insert / Redo /
Discard, then inject) — matches the current Labs copy; (b) **insert + undo** (inject immediately, offer
a one-key undo/regenerate); (c) **configurable**. *The Labs row copy already promises review; (a) is
the safe default, but confirm.*

### 4.3 Which model / adapter generates the text? *(gates the adapter method + provider selection)*
Options: (a) **reuse the selected correction provider** and its model (`gpt-5.6-sol` default via
`PYAI_MODEL`, `pyai.ts:46`) — cheapest, one transport; (b) a **separate "generation" provider/model
selection** in config (generation may want a stronger/larger model than cleanup). Decision fixes whether
`generate()` is a new method on `CorrectionProvider` or a new provider role entirely. *Note: draft is a
harder task than disfluency removal; a bigger model may be justified — but reuse is the fast path for a
first cut.*

### 4.4 Prompt design for instruction → text. *(gates `DRAFT_PROMPT`)*
Open questions: default tone/length? Does it honour meta-instructions in the utterance ("in three
bullet points", "formal", "reply saying no politely")? Does it obey `vocabulary` (§3.4 known-terms) and
the non-English `languageNote` (`prompt.ts:41-43`)? How does it avoid over-generating / hallucinating
detail the user didn't give? This is genuine prompt-engineering work and should be its own iteration
with eval fixtures (mirroring `prompt.test.ts` / `format.test.ts`).

### 4.5 How does draft mode differ from self-correction/formatting — and is that boundary clear to users?
Both existing passes are contractually *word-preserving* (§1). Draft is *generative*. Confirm the
product framing: draft is **not** "aggressive formatting" — it invents wording. The UI must make it
obvious the output is *authored by the model from your instruction*, not a transcript of what you said,
so users don't ship model prose thinking it's their own words. This is a **trust/labeling** decision.

### 4.6 Privacy posture — it sends a free-form instruction to an LLM. *(gates consent + telemetry rules)*
Dictation already sends audio/transcript to the vendor, but a draft *instruction* can be more sensitive
and more clearly "a prompt to an AI." Decisions: does draft mode need an **explicit opt-in / consent**
beyond the Labs toggle (given it's generative)? What is loggable — the project rule is
**secrets/content never logged** (settings-plan §9; telemetry is metadata-only, `telemetry: bool` at
`main.rs:130`, transport parked). Confirm draft instructions and outputs are **never** telemetered and
never written to logs. Interaction with BYOK (the user's own key vs PyAI) also matters for where the
prompt goes.

### 4.7 Context scope — does draft mode read the focused field / selection as input? *(big scope lever)*
"Reply to this email" implies draft mode reads the *surrounding/selected text* of the focused app, not
just the spoken instruction. The AX layer can read focus (see `axinject.rs read_focus`, STATUS.md M3),
but reading *arbitrary field content* is a much larger privacy + reliability surface. Decision: **v1 =
instruction-only** (no reading the target field) vs **v1 = context-aware**. *Strong recommendation:
v1 instruction-only; context-aware is a separate, later milestone.* This decision changes the
`generate()` signature (§3.1).

### 4.8 Streaming vs one-shot generation, and history. *(minor, but affects UX + adapter shape)*
Stream the generated draft token-by-token into the review box, or one-shot? Keep a history of drafts
(re-run/recall, like the tray "Show Last Result" at `main.ts:559`)? *Both can default simple (one-shot,
no history) for v1; note for completeness.*

### 4.9 Failure behaviour — what happens when generation fails? *(safety-relevant; no safe local fallback)*
Dictation's finalize path has a deterministic offline fallback: on any error it emits the raw/cleaned
transcript (`pipeline.ts:287-289` → `emitFormatted(raw)`; `localFormat` for the format pass). Draft mode
has **no equivalent** — the accumulated audio is an *instruction* ("draft a reply saying no"), so
falling back to the raw transcript would inject the literal instruction, which is worse than nothing.
Decision: on a `generate()` failure/timeout, does draft mode (a) surface an error and inject nothing
(safe default), (b) offer retry/regenerate, or (c) fall back to inserting the cleaned instruction with a
warning? This gates the pipeline draft branch's catch path (§3.2) and the review UI's error state (§3.3).
*Recommendation to consider: (a)+(b) — never auto-inject an un-generated result.*

---

## 5. What to build NOW — minimal and decision-independent

**Primary (do now):**

1. **Write `docs/product/draft-mode.md`** — the design note (outline in §6). This is the actual Phase 6
   deliverable and is 100% decision-independent (it *captures* the decisions rather than making them).
2. **Leave the Labs toggle exactly as-is.** `settings.html:456-467` is already a disabled "Planned"
   placeholder wired to nothing — the intended end state. **No edit.** (Verifying this *is* the task;
   the correct action is "confirm, don't change.")
3. **Update the settings-execution INDEX** (`docs/product/settings/INDEX.md`) — mark Phase 6 plan ✅ and
   add draft mode's decision list to the "Parked / needs-input log". (Housekeeping; no product code.)

**Optional (only if Mayank wants a visible momentum marker) — offer, don't auto-apply:**

4. An **inert `draft_mode: bool` config field** defaulting `false` in `AppConfig`
   (`main.rs:112-160`), read by nothing. It's backward-compat-free via `#[serde(default)]` (§3.4).
   **Caveats that make this NOT recommended yet:** (i) its *shape* is gated by decision §4.1 (bool vs
   `draft_mode_hotkey: String`) — committing `bool` may force a later migration; (ii) it's **Rust —
   cannot compile in the cloud**, so it would be authored-only and unverifiable here; (iii) it buys
   nothing until behaviour exists. **Default recommendation: do NOT add it.** Keep the surface honest
   at "design note + Planned toggle."

**Explicitly NOT building now (would bake in a guess):**

- No `generate()` method / `DRAFT_PROMPT` in `packages/core` — signature is gated by §4.3/§4.7 (though
  it's the *first* thing to build once those two land, and it's fully cloud-testable then).
- No pipeline `draft` branch (`finalizeOnce`) — contract gated by §4.2/§4.8.
- No widget review UI or draft trigger — gated by §4.1/§4.2.
- No Rust hotkey/config wiring — gated by §4.1, and un-compilable in cloud regardless.

---

## 6. `docs/product/draft-mode.md` — design-note outline

The note should contain, in order:

1. **Concept & one-paragraph pitch.** Speak an instruction ("draft a reply declining the meeting"),
   the model *generates* text, you review, then insert. Explicitly contrast with dictation: dictation
   transcribes-and-cleans *your words*; draft *authors new words from your instruction* (ties to §4.5).
2. **Why it's a separate surface, not a setting.** The non-generative invariant of the current pipeline
   (`prompt.ts` SYSTEM_PROMPT / FORMAT_PROMPT) and the auto-inject-on-`formatted` flow it inverts.
3. **UX flows considered** (with the trade-offs, not a pick): trigger options (§4.1), review-vs-insert
   (§4.2), streaming vs one-shot (§4.8), context-aware vs instruction-only (§4.7). Include a simple
   state diagram: idle → (draft trigger) → listen → generate → **review** → insert / redo / discard.
4. **Architecture options that reuse the existing pipeline/adapters.** Reference the real seams:
   `CorrectionProvider` + a proposed `generate()` reusing `PyAiCorrection.messages()`
   (`pyai.ts:20-43`); a `DRAFT_PROMPT` sibling in `prompt.ts`; a `mode: "draft"` / `draft` flag on the
   WS `start` frame (`main.ts:336-348`) and a `finalizeOnce` branch (`pipeline.ts:262-293`); the
   injection intercept at `main.ts:289-295`. Draw the option boundaries so the decisions in §4 map to
   concrete code sites.
5. **The decision list** — lift §4 of this plan verbatim (it's the heart of the note). Each with
   options + a recommendation-to-consider, marked PARKED.
6. **Privacy & trust section** — §4.5/§4.6: generative-output labeling, no logging/telemetry of
   instructions or outputs, BYOK interaction.
7. **Phased build proposal for AFTER decisions** (so the note is actionable the day decisions land):
   - **P1 — core:** `generate()` + `DRAFT_PROMPT` in `packages/core`, with eval fixtures
     (`draft.test.ts`, mirroring `format.test.ts`). *Cloud-testable.*
   - **P2 — pipeline:** the `draft` finalize branch + WS `start` frame flag + backend routing.
     *Cloud-testable at the core level.*
   - **P3 — widget UX:** the trigger (per §4.1) and the review-before-insert UI (per §4.2).
     *On-Mac (Tauri/Rust) — not cloud-verifiable.*
   - **P4 — config + Labs:** flip the Labs toggle from Planned to a real control; wire the config
     field in its *decided* shape.
   - **P5 (later milestone):** context-aware drafting (§4.7).
8. **Open questions** — anything unresolved after §4 (evals, cost/latency of a bigger model, undo UX).

---

## 7. Test checklist

Draft mode ships no behaviour this phase, so the test surface is nearly empty by design.

### Cloud (authorable + runnable now)
- **`npm run typecheck` / `tsc --noEmit`** — only needed *if* any TS is touched. Under the recommended
  scope (design note + INDEX only) **no TS changes**, so this is a formality: run once to confirm the
  baseline (106/106 per Phase 3) is still green and nothing regressed.
- **Design-note review** — the note exists at `docs/product/draft-mode.md`, contains all eight §6
  sections, and the decision list matches §4 of this plan. (Doc check, not a unit test.)
- *(If the optional inert TS scaffold in §5.4 were ever done — it isn't recommended — a trivial
  "flag defaults false / behaviour unchanged" test would go here. N/A under the recommended scope.)*

### On-Mac (required for anything Rust/UI — NOT applicable under recommended scope)
- **None this phase.** No Rust or Tauri UI changes are made. If Mayank opts into the §5.4 inert config
  field, then and only then: `cargo build` clean on the Mac, and load an old `settings.json` (missing
  `draftMode`) to confirm it deserializes via `#[serde(default)]` to `false`. Otherwise nothing to run.

---

## 8. Open questions

- **Is even the design note's *recommendation-to-consider* language wanted, or should the note stay
  strictly neutral** (options only, no lean)? This plan includes gentle recommendations; if Mayank
  prefers a pure options-menu, strip them from `draft-mode.md` §5.
- **Does draft mode belong in M6+ at all, or is it a post-1.0 "someday"?** §6 marks effort "TBD" and
  sequences it "post-M5". The design note lets it sit parked indefinitely without blocking the settings
  pass — confirm that's the intent.
- **Naming.** "Draft mode" vs "Compose" vs "Ask" — the Labs copy says "Draft mode"; worth a naming
  decision before it becomes user-visible, since it sets the mental model (§4.5).
</content>
</invoke>
