# Contributing

Thanks for helping build an open, vendor-neutral dictation tool!

## Ground rules
- **Never commit secrets.** Use `.env` (git-ignored) locally; the desktop app
  uses the OS keychain. Install the pre-commit hooks (below) before your first
  commit.
- Keep the **core vendor-neutral**. Anything PyAI/Deepgram/OpenAI-specific lives
  in an adapter under `packages/core/src/providers` or `.../correction`, behind
  the shared interfaces — never in app code or the core pipeline.
- All PRs must pass CI: lint, typecheck, tests, secret scan, dependency audit,
  and CodeQL.

## Getting started
```bash
git clone <repo> && cd <repo>
cp .env.example .env          # add your own vendor key(s)
npm install
npm run dev
```

## Pre-commit hooks
```bash
pip install pre-commit
pre-commit install            # runs gitleaks + detect-secrets + formatters on commit
```

## Adding a new provider
1. Implement `STTProvider` and/or `CorrectionProvider` from
   `packages/core/src/providers/types.ts` in a new file.
2. Register it in `registry.ts`.
3. Add its required key(s) to `.env.example` and document them in the README.
4. Add unit tests that normalize a captured sample of the vendor's wire format
   into the shared `TranscriptEvent` / correction ops. No live network in tests.

## Commit style
Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:` …). Small, focused PRs.
