# Release: sign + notarize the macOS app (M4.8)

How to produce a distributable, signed, notarized `Verbatim.app` — including the bundled
backend **sidecar**. Pairs with `../product/m4.8-sidecar-plan.md` (the transport) and the
`bundle.macOS` + `externalBin` config in `apps/widget/src-tauri/tauri.conf.json`.

## What ships in the bundle

- `Verbatim.app/Contents/MacOS/verbatim-widget` — the Tauri app.
- `Verbatim.app/Contents/MacOS/verbatim-backend` — the **sidecar** (`externalBin`), a
  self-contained binary compiled from `apps/backend` by `scripts/build-sidecar.mjs`
  (`beforeBuildCommand` runs it, so `tauri build` produces it automatically).
- Rust spawns the sidecar next to its own exe and injects the vendor keys from the Keychain
  (`main.rs` release branch) — the webview never sees a key.

## Prerequisites (one-time)

- **Xcode command-line tools** and a paid **Apple Developer** account.
- A **Developer ID Application** certificate in your login Keychain (Xcode → Settings →
  Accounts → Manage Certificates → +). Note your **Team ID**.
- **bun** for the sidecar compile: `curl -fsSL https://bun.sh/install | bash` (or `brew install bun`).
- An **app-specific password** for notarization (appleid.apple.com → Sign-In & Security).

## Build + sign + notarize (Tauri does it in one pass)

Signing and notarization are driven by environment variables — **nothing secret goes in the
repo**. `tauri build` signs the app + the sidecar with your Developer ID, applies
`entitlements.plist`, then (if the notarization vars are set) uploads to Apple and staples.

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
# notarization (any one of these auth styles):
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"   # the app-specific password
export APPLE_TEAM_ID="TEAMID"

cd apps/widget
npm run tauri build          # → src-tauri/target/release/bundle/macos/Verbatim.app
```

Verify:
```bash
codesign -dv --verbose=4 "…/Verbatim.app"                        # app is Developer-ID signed, hardened runtime
codesign -dv --verbose=4 "…/Verbatim.app/Contents/MacOS/verbatim-backend"  # sidecar signed too
spctl -a -vvv "…/Verbatim.app"                                   # "accepted / Notarized Developer ID"
```

## Local testing without a certificate

You don't need signing to try the release build locally:
```bash
cd apps/widget && npm run tauri build       # unsigned .app
```
Right-click the `.app` → **Open** once to get past Gatekeeper. (Unsigned/un-notarized builds
are for your machine only — don't distribute them.)

## Gotchas (the ones that actually bite)

- **JIT under hardened runtime.** The sidecar is a bun-compiled JS engine; without
  `com.apple.security.cs.allow-jit` (+ `allow-unsigned-executable-memory`) it crashes on
  launch *after* notarization. Both are in `entitlements.plist`; keep them.
- **The sidecar must be signed too.** Tauri signs `externalBin`s with your identity during
  bundling — confirm with the `codesign` check above. An unsigned nested binary fails
  notarization.
- **Demo mode fixture.** `FixtureSTT` reads a fixture file at runtime; a compiled sidecar may
  not resolve that path. Live vendors work; if demo-in-the-packaged-app matters, embed the
  fixture or gate demo to dev. (Not needed for the exit demo, which uses real vendors.)
- **Architecture.** `build-sidecar.mjs` names the binary with the host target triple
  (`rustc -vV`), so build on (or cross-compile for) each arch you ship (Apple-silicon vs
  Intel). A universal build needs both.
- **Never commit secrets.** Signing identity + notarization creds are env-only; `.env` and
  keys stay out of git (secret-scan gate, per SECURITY.md).
