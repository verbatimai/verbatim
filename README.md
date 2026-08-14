<div align="center">
  <img src="docs/brand/verbatim-logo.svg" alt="Verbatim" width="120" />

  <h1>Verbatim</h1>

  <p><strong>Real-time, vendor-agnostic dictation with visible corrections.</strong></p>

  <p>
    Words stream in live as you speak. When you stop, the text cleans itself up —
    fillers, false starts, self-corrections — while <em>showing you exactly what was
    removed</em> before it's inserted into whatever field you were typing in.
  </p>

  <p>
    <img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg" />
    <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-lightgrey.svg" />
    <img alt="Node: 20+" src="https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg" />
    <img alt="Status: pre-release" src="https://img.shields.io/badge/status-pre--release-orange.svg" />
  </p>
</div>

> **Project status:** Pre-1.0 and under active development. The macOS desktop app is
> functionally complete (milestone M4) and daily-driver polish (M5) is in progress. There is
> **no published binary yet** — you build and run from source. See [Status & roadmap](#status--roadmap).

---

## Table of contents

- [What it is](#what-it-is)
- [Why it's different](#why-its-different)
- [How it works](#how-it-works)
- [Providers](#providers)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Usage](#usage)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Experimental](#experimental)
- [Status & roadmap](#status--roadmap)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

---

## What it is

Verbatim is a dictation tool for macOS. A floating widget listens to your microphone, shows
a live transcript as you speak, then runs a correction pass that removes disfluencies and
resolves spoken self-corrections — and it renders the edit visibly (for example
`~~8 pm no no make it~~ 9 pm`) rather than silently rewriting your words. The cleaned result
is injected into the field that was focused before the widget opened.

The core is **vendor-neutral**: speech-to-text and the correction model are separate,
swappable roles, and you bring your own API key for the vendor you choose.

## Why it's different

- **Live transcript** — text appears while you speak, not only after you finish. The live
  layer never waits on the correction model.
- **Visible correction** — you see what was removed or replaced, not just the clean output.
- **Vendor-agnostic** — PyAI (default), Deepgram, OpenAI, or Anthropic behind one interface;
  speech-to-text and correction can use different vendors.
- **BYOK, local-first** — your keys live in the OS keychain and are sent only to the vendor
  you select. There is no content telemetry.

## How it works

The pipeline has two layers that run at different speeds:

```
mic ─► STT provider (WebSocket) ─► partial events ─► Layer 1: live raw text
                                     │  stableText  = locked (solid)
                                     │  activeText  = volatile tail (dim)
                                     └─ utterance end ─► Correction provider ─► compact edits
                                                              │
                                                 reconstruct(raw, edits) ─► { cleanText, ops }
                                                              │
                                            Layer 2: animate removals ─► inject cleanText
```

- **Layer 1** is instant and never blocks on the correction model — this is what makes it
  feel real-time.
- **Layer 2** runs when a segment finalizes. The correction provider returns only the spans
  that changed (compact edits); the client re-locates each span locally to rebuild the full
  keep/remove/replace timeline the UI animates. This keeps output tokens and latency low.

Two interfaces in `packages/core` define the whole contract — `STTProvider` and
`CorrectionProvider` — and each vendor is a single adapter file behind them. See
[`docs/architecture/overview.md`](docs/architecture/overview.md) for the full code map.

## Providers

Select providers with the `STT_PROVIDER` and `CORRECTION_PROVIDER` settings. Speech-to-text
and correction are independent, so combinations are allowed (for example Deepgram STT +
Anthropic correction).

| Vendor | Speech-to-text | Correction | Required key |
|---|---|---|---|
| **PyAI** (default) | ✅ | ✅ | `PYAI_API_KEY` |
| **Deepgram** | ✅ (streaming) | — | `DEEPGRAM_API_KEY` |
| **OpenAI** | ✅ | ✅ | `OPENAI_API_KEY` |
| **Anthropic** | — | ✅ | `ANTHROPIC_API_KEY` |

> **Multilingual:** PyAI's speech-to-text is English-only today, so non-English dictation
> routes STT through Deepgram or OpenAI. See
> [`docs/architecture/multilingual.md`](docs/architecture/multilingual.md).

## Requirements

**To run the web demo (no microphone or key required):**

- **Node.js 20 or newer** (22 recommended)

**To run the macOS desktop widget:**

- **macOS** — the desktop app is macOS-only in this release
  <br/>`TODO: Maintainer input required — minimum supported macOS version`
- **Node.js 20+**
- **Rust** (stable toolchain via [rustup](https://rustup.rs)) — the widget is built with
  [Tauri v2](https://tauri.app)
- **Xcode Command Line Tools** (`xcode-select --install`) for the native build
- macOS **Accessibility** and **Microphone** permissions granted to the app at first run
- **[Bun](https://bun.sh)** — only needed to build the packaged release sidecar binary
  (`npm run build --workspace @verbatim/widget` for a full bundle); not needed for `npm run widget` dev

**For live dictation** (either target), you also need at least one vendor API key — see
[Configuration](#configuration).

## Quick start

```bash
git clone https://github.com/verbatimai/verbatim.git
cd verbatim
npm install
```

### Web demo (browser)

```bash
npm run dev
```

Open **http://localhost:5173** and click **Demo (no mic)** to see the full flow — live
transcript, the "what was removed" diff, and the formatted output — with no microphone or key.
For live dictation in the browser, add a key (see below) and click **Start dictation**.

### macOS desktop widget

```bash
npm run widget
```

The widget launches as a menu-bar app with a floating overlay. Press **⌥Space** to toggle
dictation; focus a field in another app before you stop, and the corrected text is injected
there. The app owns and supervises its own backend and injects your keys from the Keychain —
there is no separate backend process to start.

> First launch requires granting **Accessibility** and **Microphone** permissions in
> **System Settings → Privacy & Security**.

## Configuration

### API keys

- **Desktop app (recommended):** open **Settings (⚙)** and enter a key per vendor. Keys are
  stored in the **OS keychain**, never on disk in plaintext, and never exposed to the
  renderer.
- **Local development / standalone backend:** copy `.env.example` to `.env` at the repo root
  and fill in the key(s) you use. `.env` is git-ignored — never commit real keys.

```bash
cp .env.example .env
```

Relevant environment variables (see [`.env.example`](.env.example) for the full list):

| Variable | Purpose | Values / default |
|---|---|---|
| `STT_PROVIDER` | Speech-to-text provider | `pyai` (default) · `deepgram` · `openai` |
| `CORRECTION_PROVIDER` | Correction provider | `pyai` · `openai` · `anthropic` |
| `PYAI_API_KEY` | PyAI key (BYOK) | — |
| `DEEPGRAM_API_KEY` | Deepgram key (BYOK) | — |
| `OPENAI_API_KEY` | OpenAI key (BYOK) | — |
| `ANTHROPIC_API_KEY` | Anthropic key (BYOK) | — |
| `PORT` | Backend WebSocket port | `8787` |

### Settings (desktop app)

The Settings window also provides a custom **vocabulary** list, snippet **text-expansion**, a
**formatting mode** (prose / message / code / raw), configurable **paste-last** and
**revert-to-raw** hotkeys, provider/language selection, and an opt-in, **metadata-only**
telemetry toggle (never content).

## Usage

| Action | Default |
|---|---|
| Toggle dictation (tap) / hold-to-talk | **⌥Space** |
| Paste last result | Configurable in Settings |
| Revert to raw (undo correction) | Configurable in Settings |

The widget never steals keyboard focus from the app underneath it, and it **refuses to inject
into secure/password fields** (it copies to the clipboard instead).

## Repository layout

This is an npm-workspaces monorepo.

```
verbatim/
├─ packages/core/      Vendor-neutral core: provider interfaces, registries,
│                      correction prompt + reconstructor, diff logic, tests
├─ apps/
│  ├─ widget/          Tauri macOS client — menu-bar app, non-activating overlay,
│  │                   settings + onboarding windows, native (Rust) integration
│  ├─ backend/         Local pipeline bridge; the desktop app spawns it as a
│  │                   key-injected sidecar (also runnable standalone for the web demo)
│  └─ web/             Vite browser demo UI
├─ docs/
│  ├─ product/         Product plan, roadmap, milestone tasks, status
│  └─ architecture/    Code map, vendor APIs, macOS injection, release/signing
├─ e2e/                Playwright end-to-end tests
├─ experiments/        Throwaway validation scripts, fixtures, UX prototypes
└─ scripts/            dev / widget / build-sidecar runners
```

Start with [`docs/product/roadmap.md`](docs/product/roadmap.md) for the milestone plan and
[`docs/architecture/overview.md`](docs/architecture/overview.md) for the code map.

## Development

```bash
npm install            # installs all workspaces
npm run dev            # web demo: backend + browser app on http://localhost:5173
npm run widget         # macOS desktop widget (owns its own backend)
npm test               # core unit/integration tests (Vitest)
npm run test:e2e       # Playwright end-to-end (run `npx playwright install chromium` first)
npm run typecheck      # type-check all workspaces
npm run pipeline       # run the headless core pipeline from the CLI
```

Troubleshooting for the web demo (dev-server reachability, mic permissions, ports) lives in
[`docs/troubleshooting.md`](docs/troubleshooting.md).

> **Native (Rust) code** under `apps/widget/src-tauri` must be built and verified on macOS;
> it cannot be compiled in a non-macOS environment.

## Experimental

The following are present in the codebase as prototypes and are **not yet stable or verified
end-to-end**. Treat them as previews:

- **Meetings ("Granola mode")** — dual-stream (you + system audio) meeting capture,
  transcription, and templated summaries. Runs a separate backend (`npm run meetings`) and
  requires a macOS loopback audio device. See
  [`docs/product/meetings-plan.md`](docs/product/meetings-plan.md).
- **Command mode / wake word** — scaffolding for spoken commands and wake-word activation.

## Status & roadmap

**M4 (desktop app + multi-vendor + configuration) is functionally complete; M5 (daily-driver
polish) is in progress.**

- **Done (M0–M4):** headless core pipeline, live web demo, macOS focus-capture + injection,
  menu-bar desktop app with a focusable settings window, Rust config store + keychain, all
  four vendor adapters, and release sidecar packaging.
- **In progress (M5):** reliability (retry + auto-reconnect + keepalive), custom vocabulary,
  formatting modes, revert-to-raw undo, a concurrency contract, and opt-in metadata-only
  telemetry. Remaining: on-Mac verification, a performance pass, and a two-week dogfood.
- **Planned (M6, v1.0):** Windows support, signed builds, auto-update, and a public release.

Details: [`docs/product/roadmap.md`](docs/product/roadmap.md),
[`docs/product/m5-tasks.md`](docs/product/m5-tasks.md), and
[`docs/product/STATUS.md`](docs/product/STATUS.md).

## Security

- **API keys** are stored in the OS keychain, never written to disk in plaintext, never
  bundled into the client, and never exposed to the renderer process. They are sent only to
  the vendor's own API over TLS.
- **Audio and transcripts** are streamed only to the vendor you select. There is **no
  telemetry of audio or transcript content**; any usage analytics are opt-in and
  metadata-only.
- **Text injection** targets the previously focused field and refuses secure/password inputs.
- Secret scanning (`gitleaks`), SAST (CodeQL), and dependency auditing gate every pull
  request.

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not open a public issue
for security problems.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first — it covers
the ground rules (never commit secrets; keep the core vendor-neutral), how to install the
pre-commit hooks, how to add a new provider, and the Conventional Commits style.

## License

[MIT](LICENSE) © 2026 Saaslabs Technology.
