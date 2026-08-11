#!/usr/bin/env python3
"""
Compact-ops correction test — the latency fix for finding F9.

The original test made the model echo EVERY kept word back as an op, so short
sentences generated 200-620 output tokens and took 4.4-13 s. Here the model
returns clean_text + only the EDITS (the spans it removed/replaced), as literal
raw substrings applied left-to-right. The untouched "keep" spans are never
echoed, so output tokens drop sharply -> lower latency, same UI result.

This script runs BOTH formats on the same sentences and prints a latency /
token comparison so you can see the improvement.

Run:
    export PYAI_KEY="pyai_test_..."
    python3 test_correction_compact.py
"""
import os, sys, json, time, re
import requests

BASE  = os.environ.get("PYAI_BASE", "https://api.pyai.com/v1")
KEY   = os.environ.get("PYAI_KEY")
MODEL = os.environ.get("PYAI_MODEL", "gpt-5.6-sol")
if not KEY:
    sys.exit("Set PYAI_KEY first:  export PYAI_KEY='pyai_test_...'")
H = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

SENTENCES = [
    "Umm let's schedule a meeting at 8 pm no no make it 9 pm",
    "So I I think we should uh ship the the feature on Friday actually no Thursday",
    "Can you send the report to John, wait, to Sarah instead by end of day",
    "The the total is like fifty, umm, fifty five dollars ahh yeah fifty five",
    "lets schedule a meeting at eightpm no no make it ninepm r i think that that works for me",
]

# ---- FULL-OPS (original, verbose) ----
FULL_SYSTEM = """You clean up spoken dictation. Remove fillers (um, uh, ahh, like), false starts, repetitions, and self-corrections (keep the final intended value); fix spoken numbers (eightpm -> 8 pm). Do not change meaning.
Output ONLY JSON: {"clean_text":"...","ops":[{"type":"keep|remove|replace","text":"<raw span>","replacement":"<for replace>","reason":"filler|false_start|self_correction|repetition|grammar|none"}]}
Concatenating every op.text in order MUST equal the raw transcript."""

# ---- COMPACT-OPS (edits only) ----
COMPACT_SYSTEM = """You clean up spoken dictation. Remove fillers (um, uh, ahh, like), false starts, repetitions, and self-corrections (keep the final intended value); fix spoken numbers (eightpm -> 8 pm). Do not change meaning.
Return ONLY the EDITS you make - do NOT echo unchanged text.
Output ONLY JSON: {"clean_text":"<full cleaned text>","edits":[{"raw":"<exact substring to change, copied verbatim from the transcript>","replacement":"<new text, empty string to delete>","reason":"filler|false_start|self_correction|repetition|grammar"}]}
List edits in the order they appear in the transcript. Each "raw" must be an exact, contiguous substring of the transcript."""

def norm(s): return re.sub(r"\s+", " ", s or "").strip()

def post(system, raw):
    body = {"model": MODEL, "max_tokens": 1024, "temperature": 0, "system": system,
            "messages": [{"role": "user", "content": f"Raw transcript:\n{raw}"}]}
    t0 = time.time()
    r = requests.post(f"{BASE}/messages", headers=H, json=body, timeout=90)
    return r, time.time() - t0

def parse(j):
    for b in j.get("content", []):
        if b.get("type") == "text":
            m = re.search(r"\{.*\}", b.get("text", ""), re.S)
            if m:
                try: return json.loads(m.group(0))
                except Exception: return None
    return None

def apply_compact(raw, edits):
    """Apply edits left-to-right by locating each literal raw substring; also
    return the ordered op timeline (keep/remove/replace) for UI animation."""
    out, ops, cur = [], [], 0
    for e in edits:
        span = e.get("raw", "")
        idx = raw.find(span, cur) if span else -1
        if idx < 0:
            continue  # substring not found (model drift) -> skip; validation will catch
        if idx > cur:
            ops.append({"type": "keep", "text": raw[cur:idx]})
            out.append(raw[cur:idx])
        rep = e.get("replacement", "")
        ops.append({"type": "replace" if rep else "remove", "text": span,
                    "replacement": rep, "reason": e.get("reason")})
        out.append(rep)
        cur = idx + len(span)
    if cur < len(raw):
        ops.append({"type": "keep", "text": raw[cur:]})
        out.append(raw[cur:])
    return "".join(out), ops

def main():
    print(f"Model: {MODEL}\n" + "=" * 78)
    tot_full_t = tot_comp_t = tot_full_out = tot_comp_out = 0.0
    n = 0
    for raw in SENTENCES:
        print(f"\nRAW: {raw}")
        # full
        rf, tf = post(FULL_SYSTEM, raw)
        # compact
        rc, tc = post(COMPACT_SYSTEM, raw)
        if not (rf.ok and rc.ok):
            print(f"  full http={rf.status_code} compact http={rc.status_code}")
            if not rc.ok: print("   compact body:", rc.text[:200])
            continue
        jf, jc = rf.json(), rc.json()
        of, oc = parse(jf), parse(jc)
        uf, uc = jf.get("usage", {}), jc.get("usage", {})
        clean_c, ops_c = ("", [])
        ok_c = False
        if oc:
            clean_c, ops_c = apply_compact(raw, oc.get("edits", []))
            ok_c = norm(clean_c) == norm(oc.get("clean_text", ""))
        fout, cout = uf.get("output_tokens", 0), uc.get("output_tokens", 0)
        print(f"  FULL   : {tf:5.2f}s  out_tok={fout:4}  clean={of.get('clean_text') if of else 'PARSE_FAIL'}")
        print(f"  COMPACT: {tc:5.2f}s  out_tok={cout:4}  clean={oc.get('clean_text') if oc else 'PARSE_FAIL'}  edits_valid={ok_c}")
        if fout and cout:
            print(f"  -> compact used {100*cout/max(fout,1):.0f}% of full's output tokens, "
                  f"{tf/tc:.1f}x {'faster' if tc<tf else 'slower'}")
        tot_full_t += tf; tot_comp_t += tc; tot_full_out += fout; tot_comp_out += cout; n += 1
    if n:
        print("\n" + "=" * 78)
        print(f"AVG latency  full={tot_full_t/n:.2f}s  compact={tot_comp_t/n:.2f}s")
        print(f"AVG out_tok  full={tot_full_out/n:.0f}   compact={tot_comp_out/n:.0f}")
        print("Note: gpt-5.6-sol may be under stress-test load; rerun off-load for a clean read.")

if __name__ == "__main__":
    main()
