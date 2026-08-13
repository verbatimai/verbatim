# Roadmap & Milestones

The plan (`../product/product-plan.md`) is the *what* and *why*. This is the *in what order*, broken into small, demoable milestones so we never drift from the North Star.

## North Star
> A polished, open-source, **vendor-agnostic** dictation widget that inserts **real-time, self-correcting, transparent** transcription into whatever field you're typing in — words appear as you speak, then clean themselves up while **showing you exactly what was removed**.

## Operating principles
- **Every milestone ends in something you can run or demo.** No milestone is "internal plumbing only".
- **Don't start milestone N+1 until N's exit criteria are met.** Exit criteria are concrete and demoable, not "looks done".
- **Vendor-neutral core.** PyAI stays the default (and the stress-test target); no vendor detail leaks above the adapter boundary.
- **Security is not a milestone, it's a gate.** Every PR passes secret-scan + SAST + dep-audit from M0 onward.
- **Two open risks drive sequencing:** correction *latency* is closed in **M1**; macOS *injection* is closed in **M3**. These are the scariest unknowns, so they come early.

---

## M0 — Foundation & de-risking  ·  ~90% done
**Goal:** prove the hard unknowns and stand up the repo before writing product code.

**Deliverables**
- ✅ PyAI API fully mapped; streaming STT protocol decoded; correction quality validated (`experiments/`).
- ✅ Vendor-agnostic interfaces + PyAI/Deepgram STT adapters + shared correction/reconstructor (`packages/core`).
- ✅ Repo structure, MIT license, SECURITY, CI (secret-scan/SAST/dep-audit), pre-commit.
- ⬜ `git init`, push to a private remote, branch protection + CI green on the scaffold.

**Exit criteria:** repo is initialized and CI passes on `main`; all key decisions (license, providers, key model, structure) are locked. **→ then M1.**

---

## M1 — Core pipeline, headless  ·  closes the latency risk  ·  IN PROGRESS
**Goal:** the whole brain works end-to-end from a file, with no UI — audio in, live partials + corrected edit-ops out.

**Deliverables**
- ✅ `packages/core` wired into a runnable CLI (`npm run pipeline`): STT session → segmenter → compact-ops correction → emits `{stableText, activeText}` live events + reconstructed diff ops + latency to the console.
- ✅ Offline path (`--stt fixture --correction mock`) replays a real capture + canned correction so the whole pipeline runs and tests with no network. Verified green.
- ✅ Unit tests (reconstruct, segmenter, WAV reader) — 11/11 pass; typecheck clean.
- ✅ Live PyAI adapters coded (`--stt pyai --correction pyai`).
- ⬜ Run the live path on the Mac against `experiments/fixtures/*.wav`; **measure real correction latency (F9)** with compact-ops; target < ~1s/segment.
- ⬜ Confirm the streaming **finalize message (F10)** and wire it into `pyai.stt.ts` (`finalize()` currently guesses `{"type":"finalize"}`).

**Exit criteria:** `npm run pipeline -- --stt pyai --correction pyai --wav clip.wav` on the Mac prints live partials + a correct, validated diff, with correction latency measured and at/near target. Offline demo already meets the shape. **This is where we prove the product is viable.**

---

## M2 — Live web demo  ·  first usable thing  ·  IN PROGRESS
**Goal:** the real experience in a browser — speak, watch it transcribe and self-correct live.

**Deliverables**
- ✅ `apps/backend` — Node WS dev bridge: browser audio ↔ `packages/core` pipeline ↔ vendor. **Key stays server-side.** `mode:"demo"` uses fixture+mock (no key/mic). Passes a headless end-to-end smoke test (ready → live×N → correction → done).
- ✅ `apps/web` — Vite app: mic capture → 16 kHz PCM downsample → WS → live transcript (stable solid / active dim) + the strike-through/fade correction animation (the prototype UI, now driven by **live** ops). Builds clean (tsc + vite). Demo + Live modes.
- ✅ `Pipeline.startStreaming()` added to core for push-style audio.
- ✅ **Verified without pyai.com or a mic:** integration tests run the *real* `PyAiSTT` and `PyAiCorrection` adapters against faithful mock servers (auth header, `session.created`/`transcript.partial`/`final` parse, stable/active mapping, `/v1/messages` post+parse+reconstruct) — 14/14 core tests pass. A headless-Chromium test loads the built web app, runs Demo, and confirms the transcript + animated diff + final output render with no console errors.
- ✅ DX hardened: `.env` loading (inline-comment safe), clear startup logs, `EADDRINUSE` message, IPv4 bind + Vite `/ws` proxy (fixes the macOS localhost→::1 "cannot reach" bug), one-command `npm run dev`, and `docs/troubleshooting.md`.
- ✅ **Clean live streaming:** Hear emits overlapping, self-revising rolling windows; the pipeline `mergeOverlap`s them into ONE clean growing transcript (locked text solid + volatile tail dim) so the input reads correctly instead of stacking duplicates. (Per-chunk incremental correction was tried and reverted — correcting Hear's raw windows inline inherently garbles the display.)
- ✅ **Cleanup + formatting as a finalize pass:** on stop, one cleanup pass drives a single "what was removed" diff over the finished transcript, and the formatter produces the polished output (grammar, punctuation, capitalization, and structure — spoken enumerations become titled numbered/bulleted lists). Verified offline (`"1 shopping and 2 swimming"` → `1. Shopping / 2. Swimming`); live quality tuned via `FORMAT_PROMPT`. Loading indicator sits on the Final Output while it computes.
- ✅ **Robust final via BATCH transcription (the real fix):** reconstructing a clean transcript from Hear's overlapping/revising rolling windows proved unreliable (kept producing duplicated text), so the product path changed: the **live input is a rolling preview** of Hear's current window (no reconstruction → can't stack/duplicate), and on stop the backend **batch-transcribes the full buffered audio** (`POST /v1/audio/transcriptions`) for ONE clean transcript, then cleanup + format. `PyAiSTT.transcribeBatch` + `pcmToWav` added and unit-tested; backend buffers PCM and runs the finalize path. Demo mode falls back to the last streamed window (fixture is a clean single utterance). (`TranscriptAccumulator`/`mergeOverlap` remain as library utilities for the CLI/tests but are no longer the product path.) `PYAI_STT_DEBUG=1` logs the raw Hear stream.
- ✅ **E2E:** committed **Playwright** suite drives the built web app in headless Chromium (Demo flow: streaming → correction diff → formatted output, no console errors). 37 core unit tests green.
- ⬜ Run live on the Mac: put `PYAI_API_KEY` in `.env`, `npm run dev`, speak into the mic — the only remaining unknowns are real pyai.com I/O, real mic audio, and the finalize message (F10) in `pyai.stt.ts`.

**Exit criteria:** open the web app, speak a sentence with fillers and a self-correction, and see it stream + correct + show what was removed — live, end to end. Offline demo mode already demonstrates the shape (backend smoke + web build green). **→ then M3.**

---

## M3 — Desktop widget shell (macOS)  ·  closes the injection risk  ·  IN PROGRESS
**Goal:** the actual product form factor — a floating widget that types into the focused field of any app.

**Deliverables**
- 🔬 **Phase 3.0 injection spike scaffolded** in `apps/widget` (Tauri v2: ⌥Space global hotkey + clipboard/⌘V text injection via `enigo`/`arboard`). Runs on macOS; proves Spike B (inject into the focused app). See `docs/product/m3-tasks.md`. **Next:** Spike A — non-activating `NSPanel` overlay via `tauri-nspanel` so it stops stealing focus.
- Tauri app: global hotkey, borderless **non-focusable** always-on-top overlay, capture-focused-element-before-show, and text injection (AX write, clipboard-paste fallback) into the previously focused field.
- The M2 UI embedded in the widget.
- Handle secure/password fields (refuse + "copy instead").

**Exit criteria:** trigger the hotkey over a real third-party app (Slack/Notes/Chrome), dictate, and the corrected text lands in the right field without the widget stealing focus. **The hardest OS risk is now proven.**

---

## M4 — Desktop app + multi-vendor + configuration  ·  ✅ FUNCTIONALLY DONE (14 Aug 2026)
**Goal:** turn the widget into a real menu-bar app with a focusable settings window, and deliver on the vendor-agnostic promise and the BYOK key model. Full breakdown + live phase checklist in `../product/m4-tasks.md` (the former standalone `desktop-app-plan.md` is now folded into it).

**Status (13 Aug 2026):** 4.0 decisions, 4.1 core config/capability, 4.2 settings window, 4.3 config store + keychain, and **4.7 settings UI + multilingual** are **done** (window/keychain/settings-UI code compiles + builds on the Mac, release `.app` launches; on-Mac interactive click-through acceptance pending). **All three vendor adapters are also done** — Deepgram STT (4.4), OpenAI STT+correction (4.5), Anthropic correction (4.6) — cloud-tested vs mocks. **4.8 sidecar wiring — dev code done** (Rust owns the backend + injects Keychain keys into its env; no key crosses the renderer), pending Mac verify + release packaging. **4.9 slim-the-overlay done**. **4.8 release packaging done** — the release `.app` builds on the Mac with the backend sidecar bundled. **4.10 exit demo essentially done** — the packaged app runs full live dictation (streaming STT → visible correction → injection) on OpenAI/Anthropic/Deepgram. **Milestone functionally complete.** Follow-ups (not blockers): exhaustive per-combo/non-English confirmation; **PyAI API is externally 404-ing** (vendor-side); **rotate the leaked PyAI test key before M6.**

**Deliverables**
- ✅ **Desktop app / window split:** single-window overlay split into a **menu-bar app + focusable settings window** (activation-policy switch), backed by one Rust config store with a `config-changed` live refresh. Unlocks typed API keys, arbitrary hotkey capture, and provider/model dropdowns. *(4.2 + 4.3 — compiles; runtime pending.)*
- ✅ Vendor adapters behind the existing interfaces: **Deepgram STT** (4.4), **OpenAI STT+correction** (4.5), **Anthropic correction** (4.6) — all cloud-tested vs mocks. *(Deepgram is STT-only — no correction adapter, by design; pair it with a correction vendor.)*
- ✅ **Keys in the OS keychain** (never plaintext/disk/bundle, never through the renderer) done via the config store (4.3), with typed per-vendor Save/Clear fields in the real Settings UI (4.7); the **app-owned sidecar** that hands keys to the pipeline is 4.8.
- ✅ Startup capability check + mix-and-match (e.g. Deepgram STT + Anthropic correction) — core layer done in 4.1; surfaced live in the Settings UI (4.7).
- ✅ **Multilingual** (see `../architecture/multilingual.md`): PyAI Hear is **English-only** today, so non-English dictation routes STT through Deepgram/OpenAI (PyAI stays the `en` default). Core `language` + English-only guard (4.1); the language setting UI, English-only hint, and localized cleanup/format prompts (non-English note in `prompt.ts`, threaded through every correction adapter) all land in 4.7.

**Exit criteria:** menu-bar app with a focusable settings window (type a key + capture a hotkey there while the overlay keeps injecting); switch STT and correction vendors from settings; keys persist in the keychain and never cross the renderer; app runs with any valid combination.

---

## M5 — Quality & polish (daily-driver)
**Goal:** good enough that the team dictates with it every day.

**Deliverables**
- Custom vocabulary/dictionary, punctuation/formatting modes, undo, edit-while-correcting, robust error/reconnect handling.
- Opt-in, metadata-only telemetry (never content); perf pass on latency and memory.

**Exit criteria:** two weeks of internal dogfooding with no blocking bugs; latency and accuracy feel "instant" in normal use.

---

## M6 — Open-source release (v1.0)
**Goal:** ship it to the public, safely.

**Deliverables**
- Windows support (UI Automation + SendInput), signed builds, auto-update.
- Docs complete (user + contributor); final security review; clean secret-scan on full history.
- Public repo published per `../architecture/git-and-release.md` (internal findings/experiments kept private).

**Exit criteria:** v1.0 tagged; public repo live; a new contributor can clone, `npm install`, and run with their own key in minutes.

---

## Risk → milestone map
| Open risk | Closed in |
|---|---|
| Correction latency (F9) | M1 |
| Streaming finalize / end-of-utterance (F10) | M1 |
| macOS focus-capture + injection | M3 |
| PyAI tool-use 503 (F1) — need faster/structured path | tracked with PyAI team; JSON-in-text works meanwhile |

## Sequencing at a glance
`M0 (done) → M1 (viability) → M2 (usable) → M3 (real form factor) → M4 (vendors) → M5 (polish) → M6 (public v1.0)`

Each arrow is a hard gate: the left side must be demoable before the right side starts.
