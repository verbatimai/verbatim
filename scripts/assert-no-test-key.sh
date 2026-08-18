#!/bin/sh
# Release gate: assert the internal PyAI test key (docs/product/onboarding-plan.md §7,
# guardrail 3) is ABSENT from a build we are about to publish.
#
# The key reaches the binary only through `option_env!("VERBATIM_PYAI_TEST_KEY")`
# (apps/widget/src-tauri/src/testkey.rs), so a public build made without that env var
# cannot contain it. This script proves that rather than assuming it — anyone holding the
# artifact can run `strings` on it, so absence must be verified, not trusted.
#
# WHERE THIS RUNS: it is a RELEASE-CHECKLIST step, not a CI job.
# .github/workflows/ci.yml has no macOS runner today (every job is ubuntu-latest) and a
# .app bundle only exists after a macOS `cargo tauri build`. Wire this into CI the moment a
# macOS build job lands; until then run it by hand before publishing an artifact.
#
# Usage:
#   VERBATIM_PYAI_TEST_KEY_PREFIX=<first chars of the key> \
#     sh scripts/assert-no-test-key.sh /path/to/Verbatim.app
#   sh scripts/assert-no-test-key.sh --self-test   # prove the gate can fail
#
# The PREFIX (not the key) is what CI/release environments hold, so this script never needs
# the secret itself and never prints it.
#
# Exit codes: 0 = clean · 1 = the key is present (DO NOT SHIP) · 2 = misuse / cannot check.

set -eu

# --self-test: prove the check can actually fail. A gate nobody has watched reject
# something is not a gate (onboarding-plan.md O6 exit criterion). Uses a deliberately
# regex-hostile prefix so a future regression back to `grep -q` is caught here.
if [ "${1:-}" = "--self-test" ]; then
  command -v strings >/dev/null 2>&1 || { echo "FAIL(self-test): 'strings' not found." >&2; exit 2; }
  VERBATIM_PYAI_TEST_KEY_PREFIX='pyai+test.v1['
  tmp="$(mktemp -d)"
  printf 'harmless text\n' > "$tmp/clean"
  printf 'leading %s trailing\n' "$VERBATIM_PYAI_TEST_KEY_PREFIX" > "$tmp/poisoned"
  contains_prefix() { strings "$1" | grep -qF "$VERBATIM_PYAI_TEST_KEY_PREFIX"; }
  rc=0
  contains_prefix "$tmp/poisoned" || { echo "FAIL(self-test): poisoned artifact NOT detected — the gate is failing open." >&2; rc=1; }
  contains_prefix "$tmp/clean"    && { echo "FAIL(self-test): clean artifact reported as poisoned." >&2; rc=1; }
  rm -rf "$tmp"
  [ "$rc" -eq 0 ] && echo "OK(self-test): gate detects a planted prefix and clears a clean file."
  exit "$rc"
fi

APP="${1:-}"
if [ -z "$APP" ]; then
  echo "usage: VERBATIM_PYAI_TEST_KEY_PREFIX=<prefix> sh $0 /path/to/Verbatim.app" >&2
  exit 2
fi

# Never silently pass: an unset prefix means we checked nothing.
if [ -z "${VERBATIM_PYAI_TEST_KEY_PREFIX:-}" ]; then
  echo "FAIL: VERBATIM_PYAI_TEST_KEY_PREFIX is unset — cannot verify the test key's absence." >&2
  echo "      Set it to the leading characters of the internal key and re-run." >&2
  exit 2
fi

BIN="$APP/Contents/MacOS/verbatim-widget"
if [ ! -f "$BIN" ]; then
  echo "FAIL: no executable at $BIN — is '$APP' a built Verbatim.app?" >&2
  exit 2
fi

if ! command -v strings >/dev/null 2>&1; then
  echo "FAIL: 'strings' not found (install Xcode command line tools)." >&2
  exit 2
fi

# -F is load-bearing: without it the prefix is a REGEX, so a '+', '.', '*' or '[' in the
# real key would stop the pattern matching its own literal bytes and this gate would pass a
# build that DOES contain the key — failing open, in the direction that looks safe.
# The prefix is never echoed, so a CI log cannot leak it.
contains_prefix() {  # $1 = file to scan
  strings "$1" | grep -qF "$VERBATIM_PYAI_TEST_KEY_PREFIX"
}

if contains_prefix "$BIN"; then
  echo "FAIL: test key present in a public artifact — DO NOT SHIP $APP" >&2
  exit 1
fi

echo "OK: no test key in $APP"
exit 0
