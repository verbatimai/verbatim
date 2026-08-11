# STATUS / HANDOFF — Open Dictation

Snapshot so any new session (or teammate) can continue with zero context loss. The **repo is the source of truth**, not any chat.

_Last updated: 11 Aug 2026._

## Where things stand
- **M0 Foundation** — done, except `git init` (see below).
- **M1 Core pipeline** — done & tested (offline). Live latency (F9) still to measure on a Mac.
- **M2 Live web demo** — working. Output (cleanup + formatting) is clean and correct. Live input streams as a growing transcript. **Robust design:** live input = `TranscriptAccumulator` over Hear's stream; **final output = BATCH transcription of the full audio on stop** (`/v1/audio/transcriptions`) → cleanup → format, so the inserted result never depends on reconstructing the messy stream.
- **M3 Desktop widget** — in progress. **Phase 3.0 spikes ✅ both confirmed on a real Mac (11 Aug 2026) — hard gate cleared.** **Spike A** (non-activating overlay): built & run via `apps/widget`; the widget floats over Notes/Slack without stealing focus — caret keeps blinking and typing still goes to the other app. **Working recipe:** `tauri-nspanel` **`v2.1`** branch, `tauri_panel!` macro with `can_become_key_window: false` + `is_floating_panel: true`, reclass the "main" window via `window.to_panel::<SpikePanel>()`, `set_style_mask(NSWindowStyleMask::NonactivatingPanel)` (typed via the crate's re-exported `objc2_app_kit`), `set_activation_policy(Accessory)`, ⌥Space shows without `set_focus`. The **non-key** part (`can_become_key_window:false`) was the piece that fixed keystrokes being swallowed by the widget. **Spike B** (injection): clipboard + ⌘V `inject_text` pastes into the focused field with no countdown (focus never leaves the target app). Note: needed an app icon at `src-tauri/icons/icon.png` (added) for `generate_context!`. **Next: Phase 3.1+** (real app scaffold, then AX-write injection + capture-focus-before-show + secure-field refusal in 3.4).

## Tests (all green in cloud)
- 37 unit/integration tests (`npm test`) — pipeline, accumulator (16 in-depth streaming cases), reconstruct, wav/pcmToWav, segmenter, PyAI STT/correction/batch adapters vs mock servers.
- 1 Playwright e2e (`npm run test:e2e`) — headless-Chromium demo flow (stream → diff → formatted, no console errors).

## How to run
```bash
cd open-dictation && npm install
npm run dev            # backend + web → http://localhost:5173 ; click "Demo (no mic)"
# live: put PYAI_API_KEY in .env at repo root, then npm run dev → "Start dictation"
npm test               # unit
npm run test:e2e       # e2e (dev: npx playwright install chromium first)
# widget spike (Mac): cd apps/widget && npx tauri dev
```

## Immediate next steps (pick up here)
1. `git init` + first commit + push to a **private** remote (repo isn't under version control yet — this is the real save point). See `docs/architecture/git-and-release.md`.
2. Wire `npm run test:e2e` into `.github/workflows/ci.yml`.
3. M3 **Phase 3.0 spikes ✅ done** (A + B confirmed on Mac — see above). Pick up at **Phase 3.1**: promote `apps/widget` from spike to real app — import `@open-dictation/core`, render the M2 transcript/diff/final-output UI in the panel, wire the mic → pipeline → `inject_text(finalized output)` flow. Then **Phase 3.4** hardening: AX-write injection (paste as fallback), `capture_focus()` before show, and secure/password-field refusal.

## Known open items / caveats
- **Live long-input transcript** can still show occasional stitch artifacts (Hear streams overlapping/revising windows). The final batch output is unaffected. To improve: capture the raw stream with `PYAI_STT_DEBUG=1 npm run backend`, save a few `[hear]` lines, and tune `mergeOverlap` / add a fixture in `packages/core/src/pipeline.test.ts`.
- **F9** — real correction/format latency on live PyAI not yet measured.
- **F10** — Hear has no working stream "finalize" control message; we close the socket to end (documented in `docs/research/pyai-api-findings.md`).
- **Security:** rotate the PyAI test key that was pasted during development before going public.

## Map
- `packages/core` — vendor-neutral pipeline (providers, correction, accumulator, batch, diff).
- `apps/backend` — dev WS bridge (live preview + batch-on-stop). `apps/web` — Vite demo UI. `apps/widget` — Tauri macOS widget (M3).
- `docs/product` — plan, roadmap, m3-tasks, this status. `docs/architecture` — overview, vendor-apis, macos-injection, tauri-stack, multilingual, git-and-release. `docs/research` — PyAI findings (internal). `experiments/` — throwaway probes (internal).
