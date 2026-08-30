# DMG E2E test on a clean Mac — runbook

Purpose: validate Verbatim end to end on a **second, never-used-for-dev Mac**, from
first-run onboarding through dictation, injection and Settings. A clean machine is the only
way to exercise `setup_state: "unseen"`, the two macOS permission prompts, and the
"no dev toolchain anywhere" assumption.

Written 30 Aug 2026, for the **unsigned + internal-test-key** build variant.

---

## 0. Build variant chosen

| Axis | Choice | Consequence |
|---|---|---|
| Signing | **Unsigned** (no Developer ID) | Gatekeeper must be bypassed by hand on the test Mac; Accessibility grants are keyed to an unstable ad-hoc identity and must be re-granted after every rebuild. |
| Test key | **Included** (`VERBATIM_PYAI_TEST_KEY`) | Onboarding's one-click test-key button renders; onboarding window title is watermarked `(internal build)`. |

> **The artifact is a secret.** The PyAI key is compiled into the binary and recoverable with
> `strings`. Do not put this DMG in Slack, Drive, or any shared location. Hand-carry it, and
> **rotate the PyAI key once the test is done** (still-open item from STATUS.md).
> `scripts/assert-no-test-key.sh` is *designed to fail* on this build — that is correct here,
> and it must pass on anything public.

---

## 1. Build machine prerequisites

```bash
command -v bun   || curl -fsSL https://bun.sh/install | bash   # sidecar compile, hard requirement
command -v rustc || echo "install Rust: https://rustup.rs"      # build-sidecar.mjs reads the host triple
xcode-select -p  || xcode-select --install
```

## 2. Build the DMG

`tauri.release.conf.json` now sets `"targets": ["app", "dmg"]`. Without that the build emits
only a `.app` and no installer — the base `tauri.conf.json` has `"targets": "app"`.

```bash
cd ~/Claude/shuuuu/verbatim

# Compile-time only. option_env! bakes it in; never commit this line.
export VERBATIM_PYAI_TEST_KEY="$(grep '^PYAI_API_KEY=' .env | cut -d= -f2-)"
[ -n "$VERBATIM_PYAI_TEST_KEY" ] || echo "EMPTY — check .env"   # never echo the value itself

cd apps/widget
npm run tauri build -- --config src-tauri/tauri.release.conf.json
# → src-tauri/target/release/bundle/dmg/Verbatim_1.0.0_aarch64.dmg
```

Confirm the key actually landed (the watermark is the visible proof):

```bash
# Expect a HIT — this build is meant to contain it.
VERBATIM_PYAI_TEST_KEY_PREFIX="${VERBATIM_PYAI_TEST_KEY:0:8}" \
  sh ../../scripts/assert-no-test-key.sh src-tauri/target/release/bundle/macos/Verbatim.app
# "FAIL: test key present" == the internal build is correct.
```

If the watermark does not appear on the test Mac, cargo reused a cached object:
`cargo clean -p verbatim-widget` and rebuild.

## 3. Get it onto the clean Mac past Gatekeeper

An unsigned app copied over a network arrives quarantined. Pick one:

```bash
xattr -dr com.apple.quarantine /Applications/Verbatim.app     # simplest
```
or System Settings → Privacy & Security → **Open Anyway** after the first blocked launch.
Right-click → Open alone is no longer sufficient on recent macOS for unsigned bundles.

## 4. Grant the two permissions

- **Microphone** — prompted in-window on onboarding Screen 2.
- **Accessibility** — System Settings → Privacy & Security → Accessibility, add `Verbatim.app`.

> Unsigned builds have no stable code-signing identity, so **after every rebuild** remove
> the old Verbatim entry from the Accessibility list and re-add it. A stale entry looks
> granted while silently failing — this will masquerade as an injection bug.

---

## 5. E2E checklist

Onboarding (the never-before-run path — `setup_state: "unseen"`):

- [ ] Onboarding window appears on first launch, 440×566, title reads **(internal build)**.
- [ ] Screen 1 — paste a key; vendor detected from its shape; chip editable; verified before saving.
- [ ] Screen 1 — **one-click test key** button renders and works (O6; this build only).
- [ ] Screen 1 — Wi-Fi off ⇒ *"saved anyway"*, never *"rejected"*.
- [ ] Screen 1 — a real 401 reddens the **correct** vendor field. *(Known-broken: `onboarding.ts:488` blames the FIRST vendor when the SECOND key 401s.)*
- [ ] Screen 2 — mic prompt appears once; AX status flips live without relaunch.
- [ ] Screen 3 — "give it one try" renders your own dictation via `dictation-progress`.
- [ ] All three exits (finish / skip / close) hide the window, revert the activation policy, and leave **no Dock icon**.
- [ ] Relaunch ⇒ onboarding does **not** reappear; tray shows **Finish setup…** only while unfinished.

Core dictation:

- [ ] ⌥Space over a field in another app; transcript streams and visibly self-corrects.
- [ ] Corrected text injects into the focused field.
- [ ] Widget never steals focus — caret keeps blinking in the target app.
- [ ] **Password field ⇒ refuses and copies instead.** (M3 exit criterion.)
- [ ] Tap-to-toggle and hold-to-talk both work; fn-key hold works.

Settings:

- [ ] **Names & Jargon** loads and a term survives an app restart (verifies `glossary_get`/`glossary_save`, fixed 30 Aug).
- [ ] Snippets, Shortcuts, Permissions, formatting modes, revert-to-raw.
- [ ] All four vendor rows — no "needs undefined", no blank selects, no `(unavailable)` for a configured provider.

Release-only paths that dev never exercises:

- [ ] Sidecar starts from inside the bundle (`Contents/MacOS/verbatim-backend`) — dictation working at all proves it.
- [ ] Error banners cite a log path that **exists** (fixed 30 Aug: `PYAI_LOG_FILE` → app log dir; previously `/logs/errors.log`, unwritable).
- [ ] No `.env` anywhere near the app — keys come only from the secret store.

---

## 6. Known issues that will surface — not regressions

1. **PyAI is 404-ing** (vendor-side): `/v1/messages` correction and the Hear stream. Live
   defaults are `stt=pyai correction=openai`, so **onboard with an OpenAI or Deepgram key**
   or Screen 3 will fail for reasons unrelated to the build.
2. **Wrong-field 401** on the second key — `onboarding.ts:488`, see checklist above.
3. **Copy is inaccurate**: Screen 1 says keys are *"stored in your macOS keychain"*, but the
   default is `key_storage: "local"` — a `0600 secrets.json` in the app config dir
   (`secrets.rs`). Either the copy or the default must change before public release.
4. Three benign compiler warnings (`tray.rs:94`, `axinject.rs:402`, `fnkey.rs:360`).
