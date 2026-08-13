# Draft mode — design note

**Status:** PARKED — design only. No feature code ships until the decisions in §5 are made by Mayank.
**Owner:** Mayank Banga · Saaslabs
**Date:** 13 Aug 2026
**Source scope:** `settings-plan.md` §6 (Wave 5); execution plan `docs/product/settings/phase-6-plan.md`; reviewer cross-check `docs/product/settings/phase-6-review.md` (binding, adds decision §5.9).

This note captures a proposed feature — it does **not** commit to any of the product decisions it lists. Its
job is to (1) define draft mode precisely, (2) show it reuses the existing pipeline/adapter seams cleanly,
(3) enumerate the decisions blocking a build, and (4) give a ready-to-execute build sequence for the day
those decisions land. The Labs "Draft mode" row (`apps/widget/settings.html:456-467`) stays a disabled
`Planned` placeholder and is deliberately unchanged.

---

## 1. Concept & one-paragraph pitch

**Draft mode:** hold a trigger, speak an *instruction* ("draft a reply declining the meeting", "write a
one-line status update saying the build is green"), the model **generates** written text from that
instruction, you **review** it, then **insert** it into the focused field. It turns Verbatim from a
transcription tool into a spoken-instruction compose tool for the same target surface (any focused text
field), reusing the same audio → widget → inject plumbing.

The distinction that defines the whole design: **dictation transcribes-and-cleans *your* words; draft
mode *authors new* words from your instruction.** In dictation, the audio *is* the content. In draft mode,
the audio is a *command* and the output is model prose the user never literally said.

---

## 2. Why it's a separate surface, not a setting — the non-generative invariant

Draft mode cannot be a toggle over the existing finalize path, because it **inverts a load-bearing contract**
of that path. Both of Verbatim's current LLM passes are contractually **non-generative**:

- **Correction pass** — `packages/core/src/correction/prompt.ts`, `SYSTEM_PROMPT` (line ~13):
  > "DO NOT add or change punctuation, capitalization, spacing, or wording. DO NOT rephrase, reorder, or
  > 'improve' grammar … If the transcript has no disfluencies, return an EMPTY edits array."
- **Format pass** — same file, `FORMAT_PROMPT` (line ~26):
  > "Do NOT add new information, opinions, or content the speaker didn't say, and do not change meaning.
  > Preserve the speaker's words."

Both are word-preserving by design. Draft mode's entire purpose is the **opposite** — invent wording that
wasn't spoken. That is not a stronger version of "format"; it is a different capability. Consequences that
force a separate surface:

1. **New prompt.** A `DRAFT_PROMPT` sibling to `SYSTEM_PROMPT` / `FORMAT_PROMPT` — generative, not
   edits-only.
2. **New adapter method.** `CorrectionProvider` (`packages/core/src/correction/types.ts:44-58`) exposes only
   `correct()` and optional `format()`; neither fits an instruction → text call. A third method is required.
3. **New widget state.** Today the final text **auto-injects with no review step**: on the `formatted`
   message the webview sets `finalText = m.text` and immediately calls `void injectFinal(m.text)`
   (`apps/widget/src/main.ts:294`). Draft-generated text is *new content* the user should see before it lands
   in their document — so "review, then insert" is a brand-new UI state that must intercept **before** that
   auto-inject line.
4. **New privacy story.** A free-form instruction typed-by-voice ("reply to my boss saying I quit") is a more
   sensitive, more clearly "a prompt to an AI" payload than a dictation transcript.

You cannot "toggle it on" over the current path. Hence: separate surface, gated on product decisions.

---

## 3. UX flows considered

State diagram (the target shape, independent of which options are chosen):

```
idle ──(draft trigger)──▶ listen (speak instruction) ──(stop)──▶ generate
                                                                    │
                                            ┌───────────────────────┤
                                            ▼                       ▼
                                         review  ──(insert)──▶  inject → idle
                                            │                       ▲
                                            ├──(redo)──▶ generate ───┘
                                            └──(discard)──────────▶ idle
                                         (generate fails) ──▶ error state (retry / discard)
```

### 3a. Trigger — separate hotkey vs a mode of ⌥Space
- **(a) Dedicated global hotkey.** A second accelerator (new config field like `paste_last_hotkey` at
  `main.rs:127`) that emits its own `dictation`-style start/stop event. *Tradeoff:* cleanest mental model —
  "⌥Space dictates, ⌥X drafts" — no overloading, but it consumes another global shortcut and needs Rust work.
- **(b) Modifier on the existing hotkey.** e.g. ⌥⇧Space, branching inside the current global-shortcut
  handler. *Tradeoff:* one key family, but chord discoverability is poor and it risks misfires against the
  plain dictation gesture.
- **(c) Webview mode toggle.** A button in the card that switches the *next* session to draft. *Tradeoff:*
  zero new global shortcuts and no Rust, but it makes draft a two-step (focus widget, toggle, then speak)
  rather than a single hold — worse for the "speak an instruction" ergonomics.

The current Labs copy ("Hold to speak an instruction…") *implies* a hold trigger but should be read as a
proposal, not a commitment.

### 3b. Auto-insert vs review-first
- **(a) Review-first.** Render the generated text in a new review state with explicit **Insert / Redo /
  Discard**, and only call `injectFinal` on Insert. *Tradeoff:* safe — the user never ships model prose
  blindly — but it's a new widget UI state and an extra interaction step. Matches the Labs copy.
- **(b) Insert + undo.** Inject immediately (as dictation does today), then offer a one-key undo/regenerate.
  *Tradeoff:* faster, consistent with the current flow, but a bad generation lands in the user's document
  first — higher blast radius for generative output.
- **(c) Configurable.** Ship both, default to review-first. *Tradeoff:* more surface, more to test.

Because draft output is authored-by-model (§2), review-first is the low-risk default — but this is a
decision (§5.2), not a settled call.

### 3c. Streaming vs one-shot; history
Stream tokens into the review box as they generate (feels responsive, but complicates the review-state
transition and the adapter signature), or one-shot render on completion (simpler). Keep a history of drafts
for recall/re-run (mirrors the tray "Show Last Result" at `main.ts:559`) or not. Both can default simple
(one-shot, no history) for v1. Decision §5.8.

### 3d. Context scope — instruction-only vs context-aware
"Reply to this email" implies reading the *focused field / selection*, not just the spoken instruction. The
AX layer can read focus (`axinject.rs read_focus`, per STATUS.md M3), but reading arbitrary field content is
a much larger privacy and reliability surface. **Recommended v1: instruction-only** (no reading the target
field); context-aware is a separate later milestone. This changes the `generate()` signature. Decision §5.7.

---

## 4. Architecture options — reusing the existing seams

Every seam draft mode needs already exists and is clean. What's missing is a prompt, a method, a branch, and
a UI state — all shaped by the §5 decisions. The real code sites:

### 4a. Adapter: a new `generate()` method reusing the existing transport
In the default adapter, both public methods funnel through one private HTTP helper:
`PyAiCorrection.messages(body, label)` → `POST {PYAI_BASE}/messages`, Anthropic-Messages-style, `model
gpt-5.6-sol`, retry/backoff on 5xx/429 (`packages/core/src/correction/pyai.ts:20-43`; `correct` at 45-65,
`format` at 67-82). A draft call reuses `messages()` **verbatim** and sends a new generative system prompt:

```
generate(instruction, ctx): Promise<{ text: string }>   // proposed third method
```

with a new `DRAFT_PROMPT` sibling in `prompt.ts`. All three vendor adapters (`pyai.ts`, `openai.ts`,
`anthropic.ts`) share `prompt.ts` and are registered in `correction/registry.ts:11-18`, so one method + one
prompt propagates exactly the way `correct`/`format` do today.

**Open architectural question (Decision §5.3):** is `generate()` a **new method on `CorrectionProvider`**
(cheapest — reuses provider selection and the one transport) or a **new provider role** (a separate
"generation" provider/model, e.g. a stronger model than cleanup)? The method's *signature* is also
decision-gated: whether it takes focused-field context (§5.7) and whether it streams (§5.8).

### 4b. Pipeline: a parallel `finalizeOnce` branch
`Pipeline` finalize (`packages/core/src/pipeline.ts:262-293`) hard-codes `correct()` → `format()` →
`emitFormatted()`, with `opts.correct`/`opts.format` read at lines 270-271 and a deterministic error fallback
`emitFormatted(raw)` at 289. Draft mode needs a **parallel branch**: treat the accumulated transcript as an
*instruction* and call `generate()` instead of correct→format. The toggle plumbing already demonstrates the
pattern (flags threaded from the WS `start` frame), so a future `draft?: boolean` / `mode` discriminator
slots in the same way. Note the branch's **catch path has no safe reuse of `emitFormatted(raw)`** — see §5.9.

### 4c. Transport: `mode: "draft"` on the WS `start` frame
`connect()` already sends a `mode` field (`"demo" | "live"`) plus a behaviour-flag bag on the `start` frame
(`apps/widget/src/main.ts:336-348`: `correct`, `format`, `autoDetect`, `vocabulary`, `snippets`,
`telemetry`). A `mode: "draft"` (or `draft: true`) rides the same frame — **zero new transport** — once it
exists.

### 4d. Widget: the injection intercept
The review state intercepts at the auto-inject site (`main.ts:289-295`). Instead of `void injectFinal(m.text)`
on `formatted`, draft renders the generated text in a review state with Insert/Redo/Discard and only calls
`injectFinal` on Insert. The card already has a final-output box (`finalOut`) and a Copy button, so the review
UI is a modest extension of existing widgets. Its exact shape is gated by §5.2.

### 4e. Config: serde-default is backward-compat-safe — but shape is undecided
`AppConfig` (`apps/widget/src-tauri/src/main.rs:110-160`) is `#[serde(rename_all = "camelCase", default)]`
with an explicit `impl Default`, so any new field deserializes cleanly from an old `settings.json` (missing →
default) — the mechanism that carried `correct`/`format`/`telemetry`/`fn_push_to_talk`. Adding a draft flag is
mechanically free. **But its shape is gated by §5.1:** a `draft_mode: bool` (a "mode of the existing hotkey"
world) vs a `draft_mode_hotkey: String` (a "separate hotkey" world, like `paste_last_hotkey`). Committing the
wrong shape now forces a later migration — so **no config field is added in this phase.**

**Bottom line:** the seams (adapter transport, prompt module, pipeline flags, `mode` on the start frame, the
injection intercept, serde-default config) all exist and are clean. None is missing. All are *shaped by a
decision not yet made.* Hence design + park.

---

## 5. Decisions needed from Mayank — PARKED (the heart of this note)

Nothing below is built until decided. Ordered roughly by how much downstream code each gates. Each is a
question with options and, where there's a defensible lean, a recommendation-to-consider (not a commitment).

### 5.1 Trigger — separate hotkey, or a mode of the existing one? *(gates config shape + Rust)*
Options: (a) a **dedicated global hotkey** (new `draft_mode_hotkey` config like `paste_last_hotkey`, own
accelerator in `main.rs`, emits a new `dictation`-style event); (b) a **modifier on ⌥Space** (e.g. ⌥⇧Space)
branching in the existing handler; (c) a **webview mode toggle**. Fixes the config field shape (§4e) and
whether Rust work is in scope. **Recommendation to consider:** (a) a separate hotkey — cleanest mental model
("dictate" vs "draft"), reuses the `paste_last_hotkey` pattern, no overloading of ⌥Space.

### 5.2 Insert directly, or open a review UI first? *(gates the widget UX + the auto-inject intercept)*
Today auto-injects (`main.ts:294`). Draft output is *new content*, so blind injection is riskier than
dictation. Options: (a) **review-first** (render, explicit Insert / Redo / Discard, then inject) — matches
the Labs copy; (b) **insert + undo** (inject immediately, one-key undo/regenerate); (c) **configurable**.
**Recommendation to consider:** (a) — the Labs copy already promises review and generative output warrants a
look-before-insert; confirm.

### 5.3 Which model / adapter generates the text? *(gates the adapter method + provider selection)*
Options: (a) **reuse the selected correction provider** and its model (`gpt-5.6-sol` default via `PYAI_MODEL`,
`pyai.ts:46`) — cheapest, one transport; (b) a **separate "generation" provider/model** in config (generation
may want a stronger/larger model than disfluency cleanup). Fixes whether `generate()` is a new method on
`CorrectionProvider` or a new provider role. **Recommendation to consider:** reuse for a first cut (fast
path), leaving room to add a generation-model selector later; note draft is a harder task than cleanup, so a
bigger model may be justified.

### 5.4 Prompt design for instruction → text. *(gates `DRAFT_PROMPT`)*
Open questions: default tone/length? Does it honour meta-instructions in the utterance ("in three bullet
points", "formal", "reply saying no politely")? Does it obey `vocabulary` (known terms) and the non-English
`languageNote` (`prompt.ts:41-43`)? How does it avoid over-generating / hallucinating detail the user didn't
give? Does the spoken instruction itself get disfluency-cleaned before it reaches `generate()`? Genuine
prompt-engineering work; should be its own iteration with eval fixtures (mirroring `prompt.test.ts` /
`format.test.ts`).

### 5.5 How does draft differ from correction/formatting — is the boundary clear to users? *(trust/labeling)*
Both existing passes are word-preserving (§2); draft is generative. Confirm the product framing: draft is
**not** "aggressive formatting" — it invents wording. The UI must make it obvious the output is *authored by
the model from your instruction*, not a transcript of what you said, so users don't ship model prose thinking
it's their own words. Labeling decision.

### 5.6 Privacy posture — it sends a free-form instruction to an LLM. *(gates consent + telemetry rules)*
A draft *instruction* can be more sensitive and more clearly "a prompt to an AI" than a dictation transcript.
Decisions: does draft mode need an **explicit opt-in / consent** beyond the Labs toggle (given it's
generative)? What is loggable — the project rule is **secrets/content never logged**; telemetry is
metadata-only (`telemetry: bool`, `main.rs:130`, transport parked). Confirm draft **instructions and outputs
are never telemetered and never written to logs.** BYOK (user's own key vs PyAI) matters for where the prompt
goes. **Recommendation to consider:** treat instructions + outputs as content (never logged/telemetered);
decide separately whether a first-run generative-consent prompt is warranted.

### 5.7 Context scope — does draft read the focused field / selection? *(big scope lever)*
"Reply to this email" implies reading surrounding/selected text of the focused app, not just the spoken
instruction. The AX layer can read focus (`axinject.rs read_focus`, STATUS.md M3), but reading arbitrary
field content is a much larger privacy + reliability surface. Decision: **v1 = instruction-only** vs **v1 =
context-aware**. **Strong recommendation:** v1 instruction-only; context-aware is a separate, later milestone.
Changes the `generate()` signature (§4a).

### 5.8 Streaming vs one-shot generation, and history. *(minor; affects UX + adapter shape)*
Stream the generated draft token-by-token into the review box, or one-shot? Keep a history of drafts
(re-run/recall, like "Show Last Result" at `main.ts:559`)? **Recommendation to consider:** default simple
(one-shot, no history) for v1; note for completeness.

### 5.9 Failure behaviour — what happens when generation fails? *(safety-relevant; no safe local fallback)*
Dictation's finalize path has a deterministic offline fallback: on any error it emits the raw/cleaned
transcript (`pipeline.ts:287-289` → `emitFormatted(raw)`; `localFormat` for the format pass). **Draft mode
has no equivalent** — the accumulated audio is an *instruction* ("draft a reply saying no"), so falling back
to the raw transcript would inject the literal instruction, which is worse than nothing. Decision: on a
`generate()` failure/timeout, does draft mode (a) surface an error and inject nothing (safe default), (b)
offer retry/regenerate, or (c) fall back to inserting the cleaned instruction with a warning? This gates the
pipeline draft branch's catch path (§4b) and the review UI's error state (§4d). **Recommendation to
consider:** (a)+(b) — never auto-inject an un-generated result.

---

## 6. Privacy & trust

- **Never logged, never telemetered.** Draft **instructions and outputs are user free-text sent to an LLM**
  and must be treated as content: never written to logs, never included in telemetry (telemetry stays
  metadata-only; `telemetry: bool` at `main.rs:130`). This is a hard rule, not a decision — it follows the
  project's "secrets/content never logged" posture. The *policy question* of whether a separate generative
  consent step is needed is §5.6; the no-log/no-telemetry rule itself is not up for debate.
- **Generative-output labeling (§5.5).** The review UI must make clear the text is authored by the model from
  the user's instruction, not a transcript — so users don't ship model prose as their own words.
- **BYOK routing (§5.6).** Where the instruction goes (PyAI vs the user's own key) must be honest and match
  the provider the user selected; generative payloads should not silently route to PyAI when a BYOK provider
  is configured.

---

## 7. Phased build proposal — for AFTER the decisions land

Ready to execute the day §5 resolves. Cloud-testability noted per project convention (Rust/Tauri UI is
Mac-only; `packages/core` is cloud-testable).

- **P1 — core.** Add `generate()` + `DRAFT_PROMPT` in `packages/core` (reusing `PyAiCorrection.messages()`),
  with eval fixtures (`draft.test.ts`, mirroring `format.test.ts` / `prompt.test.ts`). *Cloud-testable.*
  Gated by §5.3 (method-vs-role) and §5.7 (signature).
- **P2 — pipeline.** Add the `draft` finalize branch in `pipeline.ts` + the `mode: "draft"` / `draft` flag on
  the WS `start` frame + backend routing, including the §5.9 failure catch path. *Cloud-testable at the core
  level.*
- **P3 — widget UX.** The trigger (per §5.1) and the review-before-insert UI (per §5.2), intercepting the
  inject at `main.ts:289-295`. *On-Mac (Tauri/Rust) — not cloud-verifiable.*
- **P4 — config + Labs.** Wire the config field in its *decided* shape (§4e/§5.1); flip the Labs toggle
  (`settings.html:456-467`) from `Planned` to a real, wired control in `settings.ts`. *On-Mac.*
- **P5 — later milestone.** Context-aware drafting (§5.7) — reading the focused field/selection as input.

---

## 8. Open questions (beyond §5)

- **Recommendation language.** This note includes gentle recommendations-to-consider. If Mayank prefers a
  pure options-menu, strip the leans and leave options only.
- **Milestone placement.** Does draft mode belong in M6+, or is it a post-1.0 "someday"? The design lets it
  sit parked indefinitely without blocking the settings pass.
- **Naming.** "Draft mode" vs "Compose" vs "Ask" — the Labs copy says "Draft mode"; worth a naming decision
  before it becomes user-visible, since it sets the mental model (§5.5).
- **Cost/latency of a bigger generation model (§5.3)** and the exact **undo UX (§5.2)** are secondary but
  should be settled before P3.
