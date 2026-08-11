#!/usr/bin/env python3
"""
PyAI API surface discovery.

We learned /v1/chat/completions is 404 — PyAI has no plain text-chat LLM.
This probe maps what DOES exist so we can pick the correction engine.
It checks:
  - /openapi.json (if present, dumps every route — the jackpot)
  - a set of candidate REST routes (responses, completions, audio/speech, ...)
  - /v1/realtime/sessions  (OpenAI-realtime-style ephemeral token mint — also
    answers the plan's 'does PyAI support ephemeral tokens?' question)

Run:
    export PYAI_KEY="pyai_test_..."
    python3 discover_api.py
"""
import os, sys, json
import requests

BASE = os.environ.get("PYAI_BASE", "https://api.pyai.com/v1")
ROOT = BASE.rsplit("/v1", 1)[0]
KEY  = os.environ.get("PYAI_KEY")
if not KEY:
    sys.exit("Set PYAI_KEY first:  export PYAI_KEY='pyai_test_...'")
H = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

def show(label, r):
    body = r.text[:400].replace("\n", " ")
    print(f"  [{label}] http={r.status_code}  {body}")

def try_openapi():
    print("\n=== OpenAPI / docs (best case: lists every route) ===")
    for url in [f"{ROOT}/openapi.json", f"{BASE}/openapi.json",
                f"{ROOT}/openapi.yaml", f"{ROOT}/docs", f"{ROOT}/.well-known/openapi.json"]:
        try:
            r = requests.get(url, headers=H, timeout=20)
            print(f"  GET {url} -> {r.status_code}")
            if r.ok and "json" in url:
                try:
                    spec = r.json()
                    paths = list(spec.get("paths", {}).keys())
                    print("    PATHS FOUND:")
                    for p in paths:
                        methods = list(spec["paths"][p].keys())
                        print(f"      {p}  {methods}")
                    return True
                except Exception as e:
                    print("    (not parseable json:", e, ")")
        except Exception as e:
            print(f"  GET {url} -> error {e}")
    return False

def probe_rest():
    print("\n=== Candidate REST routes ===")
    tests = [
        ("POST", "/chat/completions", {"model": "pyai-omni-realtime",
            "messages": [{"role": "user", "content": "say hi"}]}),
        ("POST", "/responses", {"model": "pyai-omni-realtime", "input": "say hi"}),
        ("POST", "/completions", {"model": "pyai-omni-realtime", "prompt": "say hi"}),
        ("POST", "/messages", {"model": "pyai-omni-realtime", "max_tokens": 16,
            "messages": [{"role": "user", "content": "say hi"}]}),
        ("POST", "/audio/speech", {"model": "pyai-voice", "input": "hello", "voice": "default"}),
        ("GET",  "/realtime", None),
    ]
    for method, path, body in tests:
        try:
            if method == "GET":
                r = requests.get(f"{BASE}{path}", headers=H, timeout=20)
            else:
                r = requests.post(f"{BASE}{path}", headers=H, json=body, timeout=30)
            show(f"{method} {path}", r)
        except Exception as e:
            print(f"  [{method} {path}] error: {e}")

def probe_realtime_session():
    print("\n=== Realtime session mint (ephemeral token support) ===")
    for model in ["pyai-omni-realtime", "pyai-hear"]:
        for path in ["/realtime/sessions", "/realtime/transcription_sessions"]:
            try:
                r = requests.post(f"{BASE}{path}", headers=H, json={"model": model}, timeout=25)
                show(f"POST {path} (model={model})", r)
            except Exception as e:
                print(f"  [POST {path} model={model}] error: {e}")

def main():
    print(f"ROOT={ROOT}  BASE={BASE}")
    if not try_openapi():
        print("  (no openapi spec reachable — relying on route probes below)")
    probe_rest()
    probe_realtime_session()
    print("\nDone. Paste this whole output back.")

if __name__ == "__main__":
    main()
