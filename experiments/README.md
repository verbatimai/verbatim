# Experiments (internal, not part of the product)

Throwaway scripts used to **stress-test PyAI** and de-risk the design. They are
not shipped, not imported by `packages/` or `apps/`, and are kept **internal**
(not published to the public repo — see `../docs/architecture/git-and-release.md`).

## Setup
```bash
export PYAI_KEY="pyai_test_..."     # your own key; never commit it
pip install requests websockets
```

## Scripts (`scripts/`)
- `discover_api.py` — maps the PyAI API surface (routes, `/openapi.json`, model list).
- `test_llm_correction.py` — validates the correction / edit-ops design on sample sentences.
- `test_correction_compact.py` — compares full-ops vs compact-ops for latency/tokens (the F9 fix).
- `test_hear_stt.py` — batch + streaming STT; decodes the streaming protocol and probes the finalize message (F10).

## Fixtures (`fixtures/`)
`test_clip_16k.wav`, `test_clip_8k.wav` — synthetic speech (espeak-ng) with deliberate
fillers and a self-correction. Synthetic, so word-error-rate isn't representative;
they exist to exercise the pipeline deterministically.

## Prototypes (`prototypes/`)
`correction_ux_demo.html` — the correction animation (stable/active transcript +
strike-through/fade diff), driven by real captured ops. This is the UX reference
that `apps/widget` will implement against live data.

## Findings
Results are written up in `../docs/research/pyai-api-findings.md` (internal).
