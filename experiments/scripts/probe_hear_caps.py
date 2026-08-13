#!/usr/bin/env python3
"""
PyAI Hear capability probe — diarization + languages.  (internal, throwaway)

Answers three questions the meetings build is blocked on:
  1. Does /openapi.json now advertise diarization / speaker / language params
     on the transcription routes?
  2. Does REST batch transcription accept a diarization param, and what does a
     speaker-labelled response actually look like?
  3. What does the STREAMING event schema look like with diarization on —
     i.e. which field carries the speaker id, and on which event type?

Run:
    export PYAI_KEY="$(grep -m1 '^PYAI_API_KEY=' ~/Claude/shuuuu/verbatim/.env | cut -d= -f2-)"
    pip3 install requests websockets certifi
    python3 probe_hear_caps.py --wav ~/Claude/shuuuu/verbatim/experiments/fixtures/test_clip_16k.wav \
        | tee /tmp/hear_caps.txt

Then paste /tmp/hear_caps.txt back into the session.

SAFETY: the key is read from the env, never printed, and redacted out of every
URL and error string before anything is written to stdout.  Read the output
before pasting anyway.
"""
import os, sys, json, time, wave, argparse, asyncio, re

BASE = os.environ.get("PYAI_BASE", "https://api.pyai.com/v1")
KEY = os.environ.get("PYAI_KEY") or os.environ.get("PYAI_API_KEY")
if not KEY:
    sys.exit("Set PYAI_KEY first (see docstring).")
MODEL = os.environ.get("PYAI_MODEL", "pyai-hear")
WS_URL = os.environ.get("PYAI_WS_URL", "wss://api.pyai.com/v1/audio/transcriptions/stream")


def safe(s):
    """Redact the key from anything we print."""
    s = str(s)
    if KEY:
        s = s.replace(KEY, "***REDACTED***")
        if len(KEY) > 8:
            s = s.replace(KEY[:8], "***")
    return re.sub(r"(Bearer\s+)\S+", r"\1***REDACTED***", s)


def p(*a):
    print(*[safe(x) for x in a], flush=True)


def hr(t):
    p("\n" + "=" * 70); p(t); p("=" * 70)


# ── 1. openapi.json — free, no audio needed ──────────────────────────────────
def probe_openapi():
    hr("1. OPENAPI — transcription routes, params, enums")
    import requests
    spec = None
    for url in (f"{BASE}/openapi.json", "https://api.pyai.com/openapi.json"):
        try:
            r = requests.get(url, headers={"Authorization": f"Bearer {KEY}"}, timeout=30)
            p(f"GET {url} -> {r.status_code}")
            if r.ok:
                spec = r.json(); break
        except Exception as e:
            p(f"GET {url} -> error {e}")
    if not spec:
        p("!! no openapi spec reachable — skipping to REST probe")
        return
    paths = spec.get("paths", {})
    p(f"\n{len(paths)} routes total. Audio/transcription routes:")
    for path, ops in sorted(paths.items()):
        if not any(k in path for k in ("audio", "transcri", "stream", "realtime", "hear")):
            continue
        p(f"\n--- {path}")
        p(json.dumps(ops, indent=1)[:3000])
    # Hunt the whole spec for the keywords we care about.
    blob = json.dumps(spec)
    hr("1b. KEYWORD HITS across the whole spec")
    for kw in ("diariz", "speaker", "language", "punctuat", "timestamp", "word",
               "channel", "multichannel", "utterance", "vad", "keyword", "vocab"):
        hits = [m.start() for m in re.finditer(kw, blob, re.I)]
        p(f"\n[{kw}] {len(hits)} hits")
        for h in hits[:6]:
            p("   …" + blob[max(0, h - 160):h + 200].replace("\n", " ") + "…")


# ── 2. REST batch — does it accept diarization, and what comes back? ─────────
def probe_rest(wav):
    hr("2. REST /audio/transcriptions — diarization + language params")
    import requests
    # Candidate param spellings, most likely first.
    candidates = [
        {},
        {"diarize": "true"},
        {"diarization": "true"},
        {"speaker_labels": "true"},
        {"enable_speaker_diarization": "true"},
        {"diarize": "true", "response_format": "verbose_json"},
        {"timestamp_granularities[]": "word", "response_format": "verbose_json"},
    ]
    for extra in candidates:
        try:
            with open(wav, "rb") as f:
                data = {"model": MODEL, **extra}
                t0 = time.time()
                r = requests.post(f"{BASE}/audio/transcriptions",
                                  headers={"Authorization": f"Bearer {KEY}"},
                                  files={"file": (os.path.basename(wav), f, "audio/wav")},
                                  data=data, timeout=120)
                dt = time.time() - t0
            p(f"\nparams={extra or '(none)'} -> http={r.status_code} ({dt:.2f}s)")
            body = r.text
            p("  " + body[:1200])
            # Flag whether a speaker field actually appears in the payload.
            if re.search(r"speaker", body, re.I):
                p("  ** SPEAKER FIELD PRESENT **")
        except Exception as e:
            p(f"\nparams={extra} -> error {e}")

    hr("2b. LANGUAGE — which codes are accepted now?")
    for lang in ["en", "hi", "es", "fr", "de", "ja", "auto"]:
        try:
            with open(wav, "rb") as f:
                r = requests.post(f"{BASE}/audio/transcriptions",
                                  headers={"Authorization": f"Bearer {KEY}"},
                                  files={"file": (os.path.basename(wav), f, "audio/wav")},
                                  data={"model": MODEL, "language": lang}, timeout=120)
            ok = "OK " if r.ok else "ERR"
            p(f"  language={lang:5s} -> {ok} http={r.status_code}  {r.text[:180]}")
        except Exception as e:
            p(f"  language={lang:5s} -> error {e}")


# ── 3. Streaming — the event schema with diarization on ─────────────────────
def read_wav(path):
    with wave.open(path, "rb") as w:
        assert w.getsampwidth() == 2, "expected 16-bit PCM WAV"
        return w.readframes(w.getnframes()), w.getframerate(), w.getnchannels()


async def probe_stream(wav, qs_extra):
    import websockets, ssl
    try:
        import certifi
        ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        ctx = ssl.create_default_context()
    pcm, sr, ch = read_wav(wav)
    url = f"{WS_URL}?model={MODEL}&sample_rate={sr}&encoding=pcm_s16le&channels={ch}{qs_extra}"
    p(f"\n--- WS {url}")
    seen = []
    try:
        async with websockets.connect(url, additional_headers={"Authorization": f"Bearer {KEY}"},
                                      ssl=ctx, max_size=None) as ws:
            async def rx():
                async for m in ws:
                    txt = m if isinstance(m, str) else f"<{len(m)} bytes binary>"
                    seen.append(txt)
                    p("  << " + txt[:400])
            task = asyncio.create_task(rx())
            fpf = int(sr * 0.02) * 2 * ch
            for i in range(0, len(pcm), fpf):
                await ws.send(pcm[i:i + fpf])
                await asyncio.sleep(0.02)
            await asyncio.sleep(3.0)
            task.cancel()
    except Exception as e:
        p("  WS error: " + repr(e))
    joined = " ".join(seen)
    if re.search(r"speaker", joined, re.I):
        p("  ** SPEAKER FIELD PRESENT IN STREAM EVENTS **")
    else:
        p("  (no 'speaker' field seen in stream events)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--skip-stream", action="store_true")
    a = ap.parse_args()
    if not os.path.exists(a.wav):
        sys.exit(f"WAV not found: {a.wav}")
    pcm, sr, ch = read_wav(a.wav)
    p(f"Audio: {a.wav} sr={sr} ch={ch} dur={len(pcm)/(sr*2*ch):.2f}s")
    p(f"Base: {BASE}  Model: {MODEL}")

    probe_openapi()
    probe_rest(a.wav)
    if not a.skip_stream:
        hr("3. STREAMING — event schema with diarization params")
        for qs in ["", "&diarize=true", "&diarization=true", "&speaker_labels=true"]:
            asyncio.run(probe_stream(a.wav, qs))

    hr("DONE — paste this output back into the session")


if __name__ == "__main__":
    main()
