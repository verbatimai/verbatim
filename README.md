# Verbatim (working title)

A real-time, vendor-agnostic dictation widget with **visible corrections** —
words stream in live as you speak, then the text cleans itself up (fillers,
false starts, self-corrections) while *showing you exactly what was removed*
before inserting the result into whatever field you were typing in.

> Think Wispr Flow, but real-time, transparent about its edits, open source, and
> not locked to a single AI vendor.

## Why it's different
- **Live transcript** — text appears as you speak (not after you finish).
- **Visible correction** — see `~~8 pm no no make it~~ 9 pm`, not just the clean result.
- **Vendor-agnostic** — PyAI (default), Deepgram, OpenAI, or Anthropic behind one interface.
- **BYOK, local-first** — your keys stay in your OS keychain; nothing is sent anywhere but the vendor you choose.

## Providers
| Vendor | Speech-to-text | Correction LLM |
|---|---|---|
| PyAI (default) | ✅ `pyai-hear` | ✅ `gpt-5.6-sol` |
| Deepgram | ✅ streaming | — |
| OpenAI | ✅ Whisper/Realtime | ✅ |
| Anthropic | — | ✅ Claude |

Select with `STT_PROVIDER` / `CORRECTION_PROVIDER`. Mixing is allowed (e.g. Deepgram STT + Anthropic correction).

## Repository layout
```
verbatim/
├─ packages/core/     vendor-neutral brain: provider interfaces, registries,
│                     correction prompt + reconstructor, diff logic
├─ apps/
│  ├─ widget/         Tauri macOS client — menu-bar app + non-key overlay + settings window
│  └─ backend/        local pipeline bridge; the app spawns it as a key-injected sidecar
├─ docs/
│  ├─ product/        product-plan.md, roadmap.md
│  ├─ architecture/   overview.md, git-and-release.md
│  └─ research/        PyAI findings (internal — not published publicly)
└─ experiments/       throwaway validation scripts, fixtures, UX prototype (internal)
```
Start with **docs/product/roadmap.md** for the milestone plan and **docs/architecture/overview.md** for the code map.

## Quick start
```bash
npm install
# Web demo (no mic/key needed): backend + browser app
npm run dev            # → http://localhost:5173, click "Demo (no mic)"
# macOS desktop widget (the product): the app spawns its own keyed backend
npm run widget         # ⌥Space toggles the overlay; enter keys in Settings (⚙)
```
For live dictation, add a vendor key in the app's **Settings** window (stored in the OS
keychain) — or, for standalone dev, `cp .env.example .env` and fill in a key. Settings also
has a custom **vocabulary** list, snippet **text-expansion**, a **formatting mode** (prose /
message / code / raw), configurable **paste-last** and **revert-to-raw** hotkeys, and an
opt-in, metadata-only **telemetry** toggle.

## Status
**M4 functionally complete; M5 in progress.** M0–M3 are done (headless core pipeline, live
web demo, macOS focus-capture + injection). M4 shipped the menu-bar desktop app, a focusable
settings window, the Rust config store + keychain, all four vendor adapters (PyAI / Deepgram /
OpenAI / Anthropic), and the release sidecar packaging. **M5 (daily-driver polish)** adds
reliability (retry + auto-reconnect + keepalive), custom vocabulary, formatting modes,
revert-to-raw undo, a concurrency contract, and opt-in metadata-only telemetry with latency
capture — remaining is on-Mac verification, a perf pass, and a two-week dogfood. See
`docs/product/roadmap.md`, `docs/product/m5-tasks.md`, and `docs/product/m5.7-dogfood-exit.md`.

## Security
See [SECURITY.md](./SECURITY.md). Keys in the OS keychain, no content telemetry,
secret scanning + SAST + dependency audit gate every PR.

## License
MIT — see [LICENSE](./LICENSE).
