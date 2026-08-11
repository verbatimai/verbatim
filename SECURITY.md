# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security problems.** Report privately via
GitHub's *Security → Report a vulnerability* (private advisory) on this repo, or
email `security@saaslabs.co`. We aim to acknowledge within 3 business days and
to ship a fix or mitigation within 30 days for confirmed issues. We credit
reporters unless they prefer to remain anonymous.

## Supported versions

Until a `1.0` release, only the latest `main` and the most recent tagged release
receive security fixes.

## What this app handles (and how we protect it)

This is a dictation client. It processes three sensitive assets: your **audio**,
your **transcripts**, and your **vendor API keys**.

- **API keys** are stored in the OS keychain (macOS Keychain / equivalent secure
  store), never written to disk in plaintext, and never bundled into the client.
  Keys are sent only to the vendor's own API over TLS. The renderer/UI process
  never receives raw keys.
- **Audio and transcripts** are streamed only to the speech/LLM vendor **you**
  select. There is **no telemetry of audio or transcript content**. Any usage
  analytics are opt-in and contain metadata only (never content).
- **Text injection** targets the field that was focused before the widget
  opened; the app refuses to inject into secure/password inputs and requires an
  explicit user action.

## Handling of leaked secrets

If a key is ever committed or pasted into an issue/PR/log, treat it as
**compromised and rotate it immediately** — scanning history does not undo
exposure. CI runs `gitleaks` on every push and on full history, and a pre-commit
hook blocks commits that contain secrets, but these are backstops, not
guarantees. When in doubt, rotate.

## Supply chain

Dependencies are pinned via lockfiles, watched by Dependabot, audited in CI
(`npm audit` / `pip-audit`), and scanned with CodeQL. Release binaries are
signed; verify signatures before distributing.
