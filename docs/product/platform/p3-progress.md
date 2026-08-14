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

## Gates / decisions needed (parked for Mayank / the Mac)
- **⚠ Model license gate (must-fix 4):** verify `melspectrogram.onnx` + `embedding_model.onnx` (Google speech-embedding derivatives) may be redistributed inside an MIT app **before** bundling. If not, the bundling approach changes (download-on-first-enable, or a different embedding). *This is a real decision, parked here per the "hold items needing Mayank" rule — it doesn't block the spike, but it gates shipping.*
- **Custom "hey verbatim" model:** v1 proves the pipeline on a stock phrase ("hey jarvis"); training a custom word is a separate effort (data + a training run).
- **Cargo deps + resource bundling:** `ort`/`cpal`/`ndarray` + `tauri.conf.json` resources aren't in the cloud snapshot; documented in a `// P3 Cargo deps:` block atop `wake.rs`, to be applied on the Mac.

## On-Mac checklist
- [ ] resolve the model-license gate; obtain the 3 `.onnx` assets.
- [ ] add `ort`/`cpal`/`ndarray` to `Cargo.toml`; bundle assets via `tauri.conf.json` resources.
- [ ] `cargo build`; models load; stock phrase detects at threshold (measure false-accept/reject).
- [ ] detection fires dictate/command activation identically to the hotkey; **self-trigger gate holds** (phrase during a session does nothing).
- [ ] toggle starts/stops from Settings; survives restart; disabled = no mic/orange-dot.
- [ ] CPU/battery overhead measured (record machine spec); confirm `generate_handler!` cfg-gated entry compiles.
- [ ] add the Settings UI (toggle + handler picker + threshold slider + always-listening/on-device copy).

## Held items needing Mayank
- **Model-license gate** (above) — a genuine decision before shipping wake word; parked, not blocking the spike.
