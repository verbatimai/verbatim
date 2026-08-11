# Open Dictation (working title)

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
open-dictation/
├─ packages/core/     vendor-neutral brain: provider interfaces, registries,
│                     correction prompt + reconstructor, diff logic
├─ apps/
│  ├─ widget/         Tauri desktop client (M3 — not yet implemented)
│  └─ backend/        optional hosted key-proxy (open-core; post-M4)
├─ docs/
│  ├─ product/        product-plan.md, roadmap.md
│  ├─ architecture/   overview.md, git-and-release.md
│  └─ research/        PyAI findings (internal — not published publicly)
└─ experiments/       throwaway validation scripts, fixtures, UX prototype (internal)
```
Start with **docs/product/roadmap.md** for the milestone plan and **docs/architecture/overview.md** for the code map.

## Quick start (once M1 lands)
```bash
cp .env.example .env    # add your own vendor key(s) — BYOK
npm install
npm run dev
```

## Status
Pre-M1. The core interfaces, security/CI scaffolding, and validated experiments exist;
the runnable pipeline and desktop app are the next milestones (see the roadmap).

## Security
See [SECURITY.md](./SECURITY.md). Keys in the OS keychain, no content telemetry,
secret scanning + SAST + dependency audit gate every PR.

## License
MIT — see [LICENSE](./LICENSE).
