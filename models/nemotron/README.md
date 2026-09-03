# Nemotron speech model (bundled)

Local speech-to-text uses **Nemotron Speech Streaming 0.6B** (Q8 GGUF).

| File | Size (approx.) |
|------|----------------|
| `nemotron-speech-streaming-en-0.6b.q8_0.gguf` | ~667 MB |

## Clone

This file is tracked with **Git LFS**. After cloning the repo:

```bash
git lfs install   # once per machine
git lfs pull
```

No Hugging Face account or `HF_TOKEN` is required — the weights ship with the repository.

## License

The weights are subject to [NVIDIA Nemotron Speech terms](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b).
Only commit or redistribute them if your use complies with that license.

## Maintainer: re-add or refresh the file

```bash
git lfs track "models/nemotron/*.gguf"
git add .gitattributes models/nemotron/nemotron-speech-streaming-en-0.6b.q8_0.gguf
git commit -m "chore: bundle Nemotron ASR model via Git LFS"
```

Verify LFS before pushing:

```bash
git lfs ls-files
```
