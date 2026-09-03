# Local Nemotron ASR (NeMo-Speech.cpp + Metal)

Fully local speech-to-text on Apple Silicon using NVIDIA Nemotron Speech Streaming 0.6B (Q8 GGUF) via [NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp).

## Model weights (bundled — no Hugging Face)

The GGUF file lives in the repo under `models/nemotron/` and is tracked with **Git LFS**:

```bash
git lfs install   # once per machine
git lfs pull      # after every clone
```

No Hugging Face token or account is required for contributors or users who clone the repo.

See [`models/nemotron/README.md`](../../models/nemotron/README.md) for maintainer notes and license.

## Architecture

```
Microphone (cpal, 16 kHz mono)
    ↓ lock-free queue
Persistent ASR worker (verbatim-asr thread)
    ↓ NeMo-Speech.cpp C ABI
Metal backend
    ↓ partial / final transcripts
Transcript stabilizer
    ↓ Tauri events + IPC (127.0.0.1:8788)
Node backend (correction/format unchanged)
    ↓
macOS active text field
```

The ASR worker starts at **application launch** when `stt_provider=nemotron`. The GGUF model is loaded once and stays resident across dictation sessions.

## Build NeMo-Speech.cpp (Metal)

```bash
git clone https://github.com/NVIDIA/NeMo-Speech.cpp
cd NeMo-Speech.cpp
./scripts/install.sh --source --backend metal --prefix $HOME/nemo-speech
```

Build the widget with the SDK linked:

```bash
export NEMO_SPEECH_PREFIX=$HOME/nemo-speech
cd apps/widget
npm run start:nemotron   # or: cargo build --features nemotron
```

Without `NEMO_SPEECH_PREFIX`, the app compiles a stub ASR that reports linkage instructions at runtime.

Optional Silero VAD (recommended for trailing-word protection) — follow the
[NeMo-Speech.cpp VAD docs](https://github.com/NVIDIA/NeMo-Speech.cpp) and place
the converted model at:

```bash
~/Library/Application\ Support/co.saaslabs.verbatim.widget/models/vad.gguf
```

## Settings

| Field | Default | Description |
|-------|---------|-------------|
| `sttProvider` | `nemotron` | Enables local ASR path |
| `asrAutoDownloadModel` | `false` | Copy bundled GGUF into app data on start (optional cache) |
| `asrModelPath` | app data `models/*.q8_0.gguf` | GGUF path override; "" = bundled repo copy or app data |
| `asrStreamingMs` | `560` | Streaming preset: `160`, `560`, or `1120` |
| `asrUseMetal` | `true` | Metal GPU backend |
| `asrVadOnset` | `0.5` | VAD speech onset threshold |
| `asrVadOffset` | `0.35` | VAD speech offset threshold |

## Streaming presets

| Target latency | `rnnt_right_context` | Notes |
|----------------|------------------------|-------|
| 160 ms | 1 | Low latency, less stable partials |
| 560 ms | 6 | **Default for product testing** |
| 1120 ms | 13 | Highest stability, higher latency |

## Performance metrics

Inspect at runtime:

```javascript
await invoke("asr_get_metrics")
```

Collected fields include:

- `modelLoadMs`, `modelPeakMemoryMb`, `modelSteadyMemoryMb`
- `firstPartialLatencyMs`, `finalizationLatencyMs`
- `realTimeFactor` (target < 0.10, stretch < 0.05)
- `droppedAudioChunks`, `audioQueueDepth`
- `backend`, `device`, `metalAvailable`, `quantization`

Startup logs (stderr):

```
[asr] backend=metal device=Apple GPU (Metal) metal=true model=nemotron-speech-streaming-en-0.6b quant=q8_0 stream=560ms
```

## Memory profiling

Report working set as:

```
ASR working set = weights + encoder cache + decoder state + scratch + runtime + audio buffers
```

Use Activity Monitor / `asr_get_metrics` resident values. Investigate duplicate copies if steady-state exceeds ~2 GB on 8 GB machines.

## IPC protocol (Node provider)

TCP `127.0.0.1:8788`:

- JSON lines: `sessionStart`, `sessionStop`, `ping`
- Binary frames: 4-byte LE length + PCM s16le mono @ 16 kHz

The `packages/core/src/providers/nemotron.stt.ts` adapter connects here when the backend selects `stt_provider=nemotron`.

## Duplicate model copy investigation

When profiling with the linked SDK:

1. Measure resident memory at idle (pre-load), post-load steady-state, and active transcription.
2. Compare against GGUF file size (~600 MB Q8) — large excess suggests CPU/Metal duplication.
3. Change one variable at a time; verify transcript correctness after each optimization.

Do not modify NeMo-Speech.cpp internals without baseline benchmarks.
