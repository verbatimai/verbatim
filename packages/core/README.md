# @open-dictation/core

The vendor-neutral brain: streaming STT → segmentation → correction → visible-diff ops.

## Run the headless pipeline (M1)
```bash
npm install

# Offline demo — no network, no keys (replays a real capture + canned correction):
npm run pipeline -- --stt fixture --correction mock

# Live, on your machine (needs a key in env):
PYAI_API_KEY=... npm run pipeline -- --stt pyai --correction pyai --wav ../../experiments/fixtures/test_clip_16k.wav
```

## Checks
```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest: reconstruct, segmenter, wav
```

## Layout
- `src/providers/` — `STTProvider` interface + adapters (`pyai`, `deepgram`, `fixture`) + registry.
- `src/correction/` — `CorrectionProvider` interface, shared `prompt.ts` (system prompt + `reconstruct`), adapters (`pyai`, `mock`) + registry.
- `src/segmenter.ts` — utterance boundary detection from the transcript stream.
- `src/pipeline.ts` — wires STT + correction; emits `onLive` / `onCorrection`.
- `src/audio/wav.ts` — 16-bit PCM WAV reader + framer.
- `src/cli.ts` — the runner above.

Adapters `fixture`/`mock` exist so the whole pipeline runs and tests offline; `pyai` (and later `deepgram`/`openai`/`anthropic`) run live.
