# P3 — Progress

**Phase:** P3 — Wake-word activation (openWakeWord, on-device) · **Date:** 14 Aug 2026
**Overall:** **Scaffolded + plan-complete** (plan v2, findings folded) · config + activation wiring **compiles ✓ (`cargo build` clean on Mac, 14 Aug)** · **Settings UI added** (Wake word beta: enable + handler + threshold) · the **ONNX/audio core is a Mac spike** (authored skeleton) · **synced to repo**. Remaining: model-license gate + the Mac spike (models + cpal/ort pipeline).

> P3 was always going to end here: wake-word detection is on-device ONNX + always-on audio, entirely Rust/native. What's *done* is everything that can be done off-Mac; what remains is the spike itself.

## Implemented (authored)

**Rust:**
- `wake.rs` — NEW. Mirrors `fnkey.rs`: `set_enabled(app,on,cfg)` (bg thread + `AtomicBool` STOP, idempotent), `set_threshold`/`set_handler` (live via atomics), `wake_mic_status` command. `fire_activation` does the **full toggle-start handshake** (must-fix 1): self-trigger gate `if RECORDING||COMMAND_RECORDING skip` (must-fix 2) → `win.show()` → set `RECORDING`/`COMMAND_RECORDING` true → `emit("dictation"|"command","start")`; debounced. The openWakeWord pipeline (cpal 16 kHz → melspec → embedding → classifier → threshold/patience) is marked `// MAC SPIKE:` with honest TODOs — **no fabricated tensor shapes**.
- `config.rs` — 4 flat fields (`wake_word_enabled` default false, `wake_word_handler` "dictate", `wake_word_threshold` 0.5, `wake_word_model` "hey_jarvis") + `Default`; **selective reconcile** (restart only on enabled/model; threshold/handler live-pushed — should-fix 1); teardown in `clear_config`.
- `main.rs` — `mod wake;`, `pub(crate) use state::COMMAND_RECORDING;` re-export (must-fix 2), `wake::wake_mic_status` in `invoke_handler`.
- `shortcuts.rs` — startup reconcile in `setup()` (starts the listener if enabled), beside the fnkey reconcile.

**TypeScript (no regression):**
- `settings.ts` — 4 FLAT camelCase optional keys `wakeWordEnabled?/wakeWordHandler?/wakeWordThreshold?/wakeWordModel?` (must-fix 3 — not nested).

## Cloud check ✅ (regression only)
`npx vitest run`: **47 passed / 47** — P1/P2 command suite unaffected. No meaningful runtime cloud test exists for a native audio/ONNX feature (stated up front).

## Mac spike — the real gate (in scope for the on-Mac session)
Boundaries the dev agent marked `// MAC SPIKE:` (all in `wake.rs`), each needing Mac validation:
- load the 3 `ort` ONNX sessions — confirm ort 2.x builder API + real tensor input/output **names**.
- cpal default input + `build_input_stream`; confirm it coexists with the webview `getUserMedia` mic; resample to 16 kHz mono.
- ring-buffer size + hop matches openWakeWord framing (~80 ms mel hop, rolling embedding window).
- the core pipeline: exact mel params (n_fft/hop/n_mels/normalization) + all tensor shapes vs openWakeWord's reference.
- teardown drops the stream (releases mic / clears the orange dot).
- `wake_mic_status`: real mic TCC read (AVFoundation `authorizationStatus(for:.audio)`); currently a conservative `is_running()` stand-in.

## Gates / decisions
- **✅ Model-license gate RESOLVED (14 Aug 2026) → download-on-first-use.** Rather than bundling `melspectrogram.onnx` + `embedding_model.onnx` (Google speech-embedding derivatives), the app now **downloads all three `.onnx` files from openWakeWord's v0.5.1 release** into a writable app-data dir on first enable (`wake.rs` `ensure_models` → `download_file`, via `ureq`). Verbatim never redistributes them, so the redistribution-license question doesn't arise. No `tauri.conf.json bundle.resources` entry needed.
- **Custom "hey verbatim" model:** v1 proves the pipeline on a stock phrase ("hey jarvis"); training a custom word is a separate effort (data + a training run).
- **Cargo deps:** `ort`/`cpal`/`ndarray`/**`ureq`** aren't in the cloud snapshot; documented in the `// P3 Cargo deps:` block atop `wake.rs`, to be added on the Mac.

## On-Mac checklist
- [x] add `ort`/`cpal`/`ureq` to `Cargo.toml` (14 Aug — `ndarray` dropped: the pipeline uses plain `Vec<f32>` buffers, no `ndarray` needed; no resource bundling — models download on first enable).
- [ ] verify the `.onnx` asset URLs resolve on openWakeWord's v0.5.1 release (the `.tflite` names with a `.onnx` extension).
- [ ] `cargo build`; models load; stock phrase detects at threshold (measure false-accept/reject).
- [ ] detection fires dictate/command activation identically to the hotkey; **self-trigger gate holds** (phrase during a session does nothing).
- [ ] toggle starts/stops from Settings; survives restart; disabled = no mic/orange-dot.
- [ ] CPU/battery overhead measured (record machine spec); confirm `generate_handler!` cfg-gated entry compiles.
- [ ] add the Settings UI (toggle + handler picker + threshold slider + always-listening/on-device copy).

## Detection pipeline implemented (14 Aug 2026)
The Mac-spike core is now authored in `wake.rs` (was a stub `run_listen_thread`):
- **Deps added** to `apps/widget/src-tauri/Cargo.toml` (macOS target): `ort = { version = "2", features = ["download-binaries"] }`, `cpal = "0.15"` (alongside the already-present `ureq = "2"`). `ndarray` proved unnecessary — buffers are plain `Vec<f32>`/`VecDeque<f32>`.
- **`WakePipeline`** — holds the 3 `ort` sessions (mel / embedding / wake) + streaming buffers; `load()` commits them from the downloaded files and logs graph input names (spike aid); `feed()` streams audio → 80 ms mel CHUNKs → 76-frame embedding windows (step 8) → the 16-embedding wake window → score, applying openWakeWord's `mel/10 + 2` transform and int16-magnitude input.
- **Capture** — `cpal` default input device + `build_input_stream` (f32) → `mpsc` channel; the loop resamples device-rate → 16 kHz mono int16-range and feeds the pipeline. PATIENCE (3 consecutive over-threshold predictions) + a per-utterance latch + the DEBOUNCE window gate firing; threshold/handler stay live-tunable atomics.
- **Activation** unchanged — `fire_activation` keeps the must-fix self-trigger gate (`RECORDING || COMMAND_RECORDING` → no-op) and the full show()+flag+emit handshake.
- **Settings** — the Wake-word row now reads *Say “Hey Jarvis” to start.* so the trigger phrase is visible in the UI.
- **Known risk (in-file `// ⚠ ort 2.x API`):** `Session::builder`/`commit_from_file`, `Tensor::from_array`, `run(ort::inputs![..])`, `try_extract_tensor::<f32>` target ort 2.x and may need small compiler-driven tweaks; mel params / tensor shapes are validated against openWakeWord's reference on the Mac.
- **Not cloud-compilable** (native audio + ONNX). Next: `cargo build` on the Mac, then tune threshold against false-accept/reject.

## Held items needing Mayank
- None blocking. (The model-license gate is resolved via download-on-first-use; the remaining work is the on-Mac spike — deps + the cpal/ort audio pipeline.)
