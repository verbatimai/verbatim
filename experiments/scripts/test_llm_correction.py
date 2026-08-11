#!/usr/bin/env python3
"""
PyAI correction test — validates the 'edit-ops' design (plan section 4).

PyAI's text LLM is Anthropic-Messages-style at POST /v1/messages (model
'gpt-5.6-sol'). NOTE: forcing Anthropic tool-use currently returns
503 "no internal Claude Code model available" — a server-side bug on PyAI's
tool path. So we PROBE tool-use once, then use plain JSON-in-text mode (which
works) to actually evaluate correction quality.

Run:
    export PYAI_KEY="pyai_test_..."
    python3 test_llm_correction.py
    # optional: export PYAI_MODEL="gpt-5.6-sol"
"""
import os, sys, json, time, re
import requests

BASE  = os.environ.get("PYAI_BASE", "https://api.pyai.com/v1")
KEY   = os.environ.get("PYAI_KEY")
MODEL = os.environ.get("PYAI_MODEL", "gpt-5.6-sol")
if not KEY:
    sys.exit("Set PYAI_KEY first:  export PYAI_KEY='pyai_test_...'")
H = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

TEST_SENTENCES = [
    "Umm let's schedule a meeting at 8 pm no no make it 9 pm",
    "So I I think we should uh ship the the feature on Friday actually no Thursday",
    "Can you send the report to John, wait, to Sarah instead by end of day",
    "The the total is like fifty, umm, fifty five dollars ahh yeah fifty five",
    # realistic raw Hear output (no punctuation, mushed numbers):
    "lets schedule a meeting at eightpm no no make it ninepm r i think that that works for me",
]

RULES = """Remove: filler words (um, uh, ahh, like), false starts, stutters/repetitions, and self-corrections (keep only the final intended value). Fix obvious spoken-number formatting (e.g. "eightpm" -> "8 pm"). Do NOT add information, change meaning, or restyle.

Return the correction as an ordered list of ops:
- Concatenating every op's "text" in order MUST equal the raw transcript.
- keep -> its text goes into clean_text; remove -> nothing; replace -> its "replacement" goes into clean_text.
- reason is one of: filler | false_start | self_correction | repetition | grammar | none."""

JSON_SYSTEM = f"""You clean up spoken dictation transcripts into written text.
{RULES}

Output ONLY a JSON object, no prose, with this exact shape:
{{"clean_text": "<cleaned text>", "ops": [{{"type":"keep|remove|replace","text":"<raw span>","replacement":"<only for replace>","reason":"<reason>"}}]}}"""

TOOL = {
    "name": "emit_correction",
    "description": "Return the cleaned transcript and ordered edit operations.",
    "input_schema": {
        "type": "object",
        "properties": {
            "clean_text": {"type": "string"},
            "ops": {"type": "array", "items": {"type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["keep", "remove", "replace"]},
                    "text": {"type": "string"},
                    "replacement": {"type": "string"},
                    "reason": {"type": "string"}},
                "required": ["type", "text"]}},
        },
        "required": ["clean_text", "ops"]},
}

def normalize(s):
    return re.sub(r"\s+", " ", s or "").strip()

def validate(raw, obj):
    ops = obj.get("ops", [])
    concat_raw = "".join(o.get("text", "") for o in ops)
    rebuilt = "".join(o.get("replacement", "") if o.get("type") == "replace"
                      else (o.get("text", "") if o.get("type") == "keep" else "")
                      for o in ops)
    return (normalize(concat_raw) == normalize(raw),
            normalize(rebuilt) == normalize(obj.get("clean_text", "")))

def post(body):
    t0 = time.time()
    r = requests.post(f"{BASE}/messages", headers=H, json=body, timeout=60)
    return r, time.time() - t0

def call_tool(raw):
    return post({"model": MODEL, "max_tokens": 1024, "temperature": 0,
                 "system": "Use the emit_correction tool. " + RULES,
                 "messages": [{"role": "user", "content": f"Raw transcript:\n{raw}"}],
                 "tools": [TOOL], "tool_choice": {"type": "tool", "name": "emit_correction"}})

def call_json(raw):
    return post({"model": MODEL, "max_tokens": 1024, "temperature": 0,
                 "system": JSON_SYSTEM,
                 "messages": [{"role": "user", "content": f"Raw transcript:\n{raw}"}]})

def extract(j):
    for b in j.get("content", []):
        if b.get("type") == "tool_use":
            return b.get("input")
    for b in j.get("content", []):
        if b.get("type") == "text":
            m = re.search(r"\{.*\}", b.get("text", ""), re.S)
            if m:
                try: return json.loads(m.group(0))
                except Exception: pass
    return None

def main():
    print(f"Base: {BASE}   Model: {MODEL}\n" + "=" * 70)

    # One-time probe: does tool-use work on this deployment?
    pr, _ = call_tool(TEST_SENTENCES[0])
    tool_works = pr.ok
    print(f"[tool-use probe] http={pr.status_code} -> "
          f"{'WORKS' if tool_works else 'broken, using JSON-in-text mode: ' + pr.text[:160]}\n")

    for raw in TEST_SENTENCES:
        print(f"RAW:  {raw}")
        r, dt = (call_tool(raw) if tool_works else call_json(raw))
        if not r.ok:
            print(f"  http={r.status_code} body={r.text[:300]}\n"); continue
        j = r.json()
        obj = extract(j)
        usage = j.get("usage", {})
        if not obj:
            print("  could not parse ops. content:", json.dumps(j.get('content'))[:400], "\n"); continue
        ok_raw, ok_clean = validate(raw, obj)
        print(f"  CLEAN: {obj.get('clean_text')}")
        print(f"  latency={dt:.2f}s  tokens(in/out)={usage.get('input_tokens')}/{usage.get('output_tokens')}"
              f"  reconstruct_raw={ok_raw} reconstruct_clean={ok_clean}")
        for o in obj.get("ops", []):
            t = o.get("type")
            extra = f" -> '{o.get('replacement')}'" if t == "replace" else ""
            reason = f"  [{o.get('reason')}]" if o.get("reason") else ""
            print(f"    {'   ' if t=='keep' else ' · '}{str(t).upper()}: '{o.get('text')}'{extra}{reason}")
        print()

if __name__ == "__main__":
    main()
