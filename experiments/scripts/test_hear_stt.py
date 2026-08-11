#!/usr/bin/env python3
"""
PyAI Hear (speech-to-text) test — confirms STT works, discovers the streaming
schema, and measures latency (plan sections 2 & 7).

Two parts:
  A) REST baseline (reliable): POST /v1/audio/transcriptions with a WAV file.
     Confirms STT quality, accepted format, and the response shape.
  B) Streaming probe (best-effort): opens a WebSocket, streams the WAV in small
     PCM frames, timestamps the FIRST partial, and prints every server message
     so the real streaming schema reveals itself.

Because the exact Hear WS URL/protocol isn't in the public docs, part B is a
probe: pass the real URL from your API reference with --ws-url, and adjust the
start/end handshake near the CONFIG block if the server expects something
specific. Part A will work regardless.

Run:
    export PYAI_KEY="pyai_test_..."
    pip install websockets requests
    python3 test_hear_stt.py --wav test_clip_16k.wav
    # streaming probe (once you know the URL):
    python3 test_hear_stt.py --wav test_clip_16k.wav --ws-url "wss://api.pyai.com/v1/realtime"
"""
import os, sys, json, time, wave, argparse, asyncio

BASE = os.environ.get("PYAI_BASE", "https://api.pyai.com/v1")
KEY  = os.environ.get("PYAI_KEY")
if not KEY:
    sys.exit("Set PYAI_KEY first:  export PYAI_KEY='pyai_test_...'")

# -------- CONFIG: adjust to match your API reference if needed --------
MODEL = os.environ.get("PYAI_MODEL", "pyai-hear")  # confirmed STT model name; override via --model/PYAI_MODEL
FRAME_MS = 20                                     # audio frame size sent per WS message
# Real streaming endpoint discovered via openapi.json: GET /v1/audio/transcriptions/stream
DEFAULT_WS = "wss://api.pyai.com/v1/audio/transcriptions/stream"
SEND_START = os.environ.get("PYAI_SEND_START", "0") == "1"   # set 1 to send a JSON start frame
def start_message(sample_rate):
    return {"type": "start", "model": MODEL, "sample_rate": sample_rate,
            "encoding": "pcm_s16le", "channels": 1}
END_MESSAGE = {"type": "stop"}
# ----------------------------------------------------------------------

def read_wav(path):
    with wave.open(path, "rb") as w:
        assert w.getsampwidth() == 2, "expected 16-bit PCM WAV"
        sr = w.getframerate()
        ch = w.getnchannels()
        pcm = w.readframes(w.getnframes())
    return pcm, sr, ch

def rest_test(wav_path):
    import requests
    print("\n=== PART A: REST /audio/transcriptions ===")
    for model_try in dict.fromkeys([MODEL, "pyai-hear", "whisper-1"]):
        try:
            with open(wav_path, "rb") as f:
                files = {"file": (os.path.basename(wav_path), f, "audio/wav")}
                data = {"model": model_try}
                t0 = time.time()
                r = requests.post(f"{BASE}/audio/transcriptions",
                                  headers={"Authorization": f"Bearer {KEY}"},
                                  files=files, data=data, timeout=120)
                dt = time.time() - t0
            print(f"[model={model_try}] http={r.status_code} ({dt:.2f}s)")
            if r.ok:
                try:    print("  ->", json.dumps(r.json(), indent=2)[:800])
                except Exception: print("  ->", r.text[:800])
                return
            else:
                print("  body:", r.text[:300])
        except Exception as e:
            print(f"[model={model_try}] error: {e}")

async def stream_test(wav_path, ws_url):
    try:
        import websockets
    except ImportError:
        print("\n(skip streaming: `pip install websockets` to enable)"); return
    pcm, sr, ch = read_wav(wav_path)
    # Append config as query params (common for GET-upgrade STT sockets).
    if "?" not in ws_url:
        ws_url = f"{ws_url}?model={MODEL}&sample_rate={sr}&encoding=pcm_s16le&channels={ch}"
    print(f"\n=== PART B: WebSocket streaming probe -> {ws_url} ===")
    bytes_per_frame = int(sr * (FRAME_MS/1000.0)) * 2 * ch
    frames = [pcm[i:i+bytes_per_frame] for i in range(0, len(pcm), bytes_per_frame)]
    first_partial_t = None
    t_start = None
    # python.org Python often lacks a populated system CA store; use certifi's bundle
    # (same certs `requests` uses) so wss verification succeeds.
    import ssl
    try:
        import certifi
        ssl_ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        ssl_ctx = ssl.create_default_context()
    try:
        # Some servers want the key in a header, some in a query param — try header first.
        async with websockets.connect(ws_url, additional_headers={"Authorization": f"Bearer {KEY}"},
                                      ssl=ssl_ctx, max_size=None) as ws:
            async def receiver():
                nonlocal first_partial_t
                async for msg in ws:
                    now = time.time()
                    if first_partial_t is None:
                        first_partial_t = now
                        print(f"  FIRST message at +{(now - t_start)*1000:.0f} ms after audio start")
                    print("  <<", msg[:300] if isinstance(msg, str) else f"<{len(msg)} bytes binary>")
            recv_task = asyncio.create_task(receiver())
            if SEND_START:
                await ws.send(json.dumps(start_message(sr)))
            t_start = time.time()
            for fr in frames:
                await ws.send(fr)
                await asyncio.sleep(FRAME_MS/1000.0)   # real-time pacing
            # We learned {"type":"stop"} -> unknown_message_type. Probe candidates to
            # find the correct "end of audio / finalize" control message.
            for cand in ["input_audio.end", "commit", "finalize", "end",
                         "audio.end", "eof", "flush", "session.close", "close"]:
                print(f"  -> trying finalize type='{cand}'")
                await ws.send(json.dumps({"type": cand}))
                await asyncio.sleep(1.0)
            try:
                await asyncio.wait_for(recv_task, timeout=8)
            except asyncio.TimeoutError:
                print("  (no more messages; closing)")
    except Exception as e:
        print("  WS error:", repr(e))
        print("  -> Check the WS URL, auth method (header vs ?token=), and the start/stop handshake against your API reference.")

def main():
    global MODEL
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", default="test_clip_16k.wav")
    ap.add_argument("--model", default=MODEL, help="STT model (default pyai-hear)")
    ap.add_argument("--ws-url", default=os.environ.get("PYAI_WS_URL"),
                    help="e.g. wss://api.pyai.com/v1/realtime?model=pyai-hear")
    args = ap.parse_args()
    MODEL = args.model
    if not os.path.exists(args.wav):
        sys.exit(f"WAV not found: {args.wav}")
    pcm, sr, ch = read_wav(args.wav)
    print(f"Audio: {args.wav}  sr={sr} ch={ch} dur={len(pcm)/(sr*2*ch):.2f}s")
    rest_test(args.wav)
    asyncio.run(stream_test(args.wav, args.ws_url or DEFAULT_WS))

if __name__ == "__main__":
    main()
