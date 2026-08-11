# Git & Release Strategy

## Repository model
One **monorepo** rooted at `open-dictation/`. It is a single `git` repo (run `git init` here). Rationale: the core, the widget, the optional backend, and the docs evolve together and share types; a monorepo keeps them in lockstep and makes atomic cross-cutting changes easy.

## Public vs. internal — the important part
This project becomes a **public, MIT** repo, but not everything here should be public:

| Path | Visibility | Why |
|---|---|---|
| `packages/`, `apps/`, root hygiene files | **Public** | the product |
| `docs/product/`, `docs/architecture/` | **Public** | help contributors |
| `docs/research/` (PyAI findings) | **Internal** | references our in-house model + internal findings |
| `experiments/` | **Internal** | stress-test scripts for PyAI; not part of the product |
| `.archive/` | **Internal** | scratch |

**Recommended approach:** develop everything in a **private** repo now. When ready to open-source, publish the public subset to a new public repo (via `git subtree split` of the public paths, or a scripted mirror that excludes internal paths). Keep `docs/research/` and `experiments/` in the private repo only. This avoids ever exposing PyAI internals in public history — which matters because git history is forever.

`.gitignore` already excludes secrets, build output, and `.archive/`. Internal-only paths are controlled at *publish time* (what we push public), not by `.gitignore` (we still want them tracked privately).

## Branching & commits
- **Trunk-based.** `main` is always releasable and **protected** (no direct pushes; PR + green CI required).
- Short-lived **feature branches**: `feat/…`, `fix/…`, `docs/…`.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`) — drives the changelog.
- Squash-merge to keep `main` history clean.

## CI gates (block merge) — already scaffolded
`gitleaks` secret scan (incl. full history) · CodeQL SAST · `npm audit --audit-level=high` · lint + typecheck + tests. Plus Dependabot and pre-commit hooks (secrets + formatters) so problems are caught before they're committed.

## Branch protection & repo config (set on the remote)
- Require PR review + all CI checks before merge to `main`.
- Enable secret scanning + push protection (GitHub native) in addition to gitleaks.
- Add later: `CODEOWNERS`, PR template, issue templates, `CODE_OF_CONDUCT.md`.

## Releases
- **SemVer** tags (`vMAJOR.MINOR.PATCH`); pre-1.0 during M1–M5, `v1.0.0` at M6.
- **Signed** desktop builds (notarized on macOS); verify signatures before distribution.
- Auto-generated changelog from Conventional Commits; GitHub Releases with signed artifacts.

## First steps (M0 exit)
```bash
cd open-dictation
git init && git add -A && git commit -m "chore: initial scaffold and docs"
# create a PRIVATE remote, push, enable branch protection + secret scanning
```
> Before any remote push: rotate the PyAI test key that leaked into planning chat, and confirm no real key is staged (`git grep -i pyai_` should find only placeholders).
