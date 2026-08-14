# P3 — Wake-Word Activation (openWakeWord, on-device) — Implementation Plan

**Track:** Platform (P-series) · **Phase:** P3 · **Owner:** Mayank Banga · Saaslabs
**Date:** 14 Aug 2026 · **Status:** ✅ **APPROVED** (v2 — reviewer must-fix 1–4 + should-fix 1–3 folded in; `p3-review.md`). D3 remains a **Mac spike**.
**Umbrella:** `../platform-evolution.md` (§6 — engine decision **openWakeWord**, locked for MIT).

> **Honest scope for this phase.** Wake-word detection is **on-device ONNX inference + always-on audio capture — entirely Rust/native, none of it verifiable in the cloud.** So P3 delivers: (a) this reviewed plan, (b) the **config + activation wiring** (small, safe, authored properly, cloud-typecheckable on the TS side), and (c) a **structured `wake.rs` scaffold** with the openWakeWord pipeline documented and a clear ONNX-inference boundary. The inference + audio core is a **Mac spike** — like the meetings track's N0-A native capture, it is built and validated at the Mac, not authored blind. This phase ends as *"scaffolded + plan-complete,"* not *"tested."*

## 1. What a wake word is here

An **optional, off-by-default** activation *source* (platform-evolution §2/§6): a tiny local model listens continuously and, on the trigger phrase, fires the **same activation event** P1/P2 already use (`emit("dictation"|"command","start")`). No raw audio ever leaves the device — the point of on-device spotting. It is one activation source among several (hotkey stays primary); it never becomes the only way to reach a handler.

## 2. Engine: openWakeWord (chosen §6)

openWakeWord's pipeline (all 16 kHz mono):
1. **Melspectrogram** — a small `melspectrogram.onnx` turns audio frames into mel features.
2. **Embedding** — Google's shared speech-embedding `embedding_model.onnx` → 96-dim vectors.
3. **Wake-word classifier** — a per-phrase `<word>.onnx` scores a rolling window of embeddings → 0–1.
4. **Threshold + patience** — score ≥ threshold for N consecutive frames → detection; debounce to avoid repeats.

- **Rust integration:** `ort` (ONNX Runtime bindings) for the three models, `ndarray` for tensors, audio via `cpal` (an independent always-on capture — separate from the webview's dictation mic path). Prior art exists (openWakeWord is Apache-licensed; Rust `ort` examples exist).
- **Models are assets:** ship `melspectrogram.onnx` + `embedding_model.onnx` (shared) + a wake-word model. **v1 uses a stock openWakeWord model** (e.g. `hey_jarvis`) to prove the pipeline; a **custom "hey verbatim"** is trained via openWakeWord's training flow as a follow-up (own task — needs data + a training run, not cloud work).

## 3. Deliverables

### D1 — Config + settings · *Rust (Mac) + core TS (cloud-typecheck)*
- `config.rs` `AppConfig`: `wake_word_enabled: bool` (default **false**), `wake_word_handler: String` (`"dictate"` | `"command"`, default `"dictate"`), `wake_word_threshold: f32` (default `0.5`), `wake_word_model: String` (asset id, default the stock model). Add to struct + `Default`.
- **(should-fix 1) Selective reconcile:** `set_config` restarts the listener (`wake::set_enabled`) ONLY when `wake_word_enabled` or `wake_word_model` changes (tearing down cpal + reloading 3 ONNX sessions is heavy). `wake_word_threshold` / `wake_word_handler` are **pushed live** to the running thread via atomics (mirror fnkey's `AtomicI64 PTT_KEYCODE`) — no restart. `clear_config`: tear down.
- **(must-fix 3) `settings.ts`: FLAT camelCase keys** (the store is a superset of `AppSettings` with same-key camelCase; a nested object won't round-trip `set_config`'s shallow merge): `wakeWordEnabled?`, `wakeWordHandler?`, `wakeWordThreshold?`, `wakeWordModel?`.
- **Test:** *(cloud)* settings typecheck. *(Mac)* toggle starts/stops the listener; persists; old config loads (serde default).

### D2 — Activation wiring · *Rust (Mac), small + safe — but do the FULL handshake*
- **(must-fix 1) Replicate the full start sequence, not just an emit.** The real triggers (`fnkey.rs` fn_press, `shortcuts.rs` toggle-Pressed) do THREE things: `app.get_webview_window("main").show()` (Rust shows the NSPanel — the webview can't) + set the recording flag `true` + emit start. On detection `wake.rs` must do the same: for `wake_word_handler=="command"` → set `COMMAND_RECORDING=true` + `emit("command","start")`; else set `RECORDING=true` + `emit("dictation","start")`; plus `win.show()`. Debounced so one utterance = one activation.
- **Stop story:** a wake word is a toggle-start with no "hold" — the session ends via the existing hotkey tap / webview finalize, which works **only because** the recording flag was set (hence must-fix 1).
- **(must-fix 2 — the linchpin) Self-trigger gate:** detection must NOT fire while `crate::RECORDING || crate::state::COMMAND_RECORDING` is true (else dictating the phrase re-triggers mid-session). Setting the flag in must-fix 1 makes this guard self-suppressing. Add a `pub(crate) use state::COMMAND_RECORDING` re-export in `main.rs` for symmetry with `RECORDING`.
- Startup reconcile in `shortcuts.rs setup()`: if `wake_word_enabled`, start the listener (mirror the fnkey PTT reconcile).
- **Test:** *(Mac)* speaking the phrase starts a dictation (or command) session **identically to the hotkey** (overlay shows, flag set, stops cleanly on tap); the phrase spoken *during* a live session does nothing (self-trigger gate).

### D3 — `wake.rs` listener scaffold · *Rust (Mac spike — the ONNX/audio core)*
- New `apps/widget/src-tauri/src/wake.rs`, structured like `fnkey.rs` (a `set_enabled(app, cfg)` that owns a background thread + a stop flag/`AtomicBool`, so start/stop is idempotent and reconciled from config):
  - **Audio:** `cpal` default input → 16 kHz mono ring buffer (resample if needed). Always-on while enabled.
  - **Pipeline:** feed frames → `melspectrogram.onnx` → `embedding_model.onnx` → `<word>.onnx` via `ort` sessions loaded once at start; maintain the rolling embedding window per openWakeWord.
  - **Detection:** score ≥ `threshold` for the patience window → debounce → call D2's activation. Reset after firing.
  - **Live-tunable:** `threshold` and `handler` are read from atomics the thread polls (should-fix 1), so Settings changes them without a restart.
  - **Lifecycle:** clean thread shutdown on disable/quit; **(should-fix 2)** models loaded via `app.path().resource_dir()` join `resources/wakeword/…` (note the dev-vs-bundled path difference).
  - **Marked `// MAC SPIKE:`** at the ONNX-inference boundary — the exact tensor shapes / mel preprocessing must be validated against openWakeWord's reference on the Mac; this is not cloud-verifiable.
- **(must-fix 4) License gate BEFORE bundling:** verify `melspectrogram.onnx` + `embedding_model.onnx` (derived from Google's speech-embedding model, not openWakeWord itself) permit redistribution inside an MIT app. A license fail invalidates bundling — resolve before the spike ships.
- `Cargo.toml`: add `ort`, `ndarray`, `cpal` (author the dep lines; versions pinned on the Mac). Bundle the `.onnx` assets under `src-tauri/resources/wakeword/` + `tauri.conf.json` `resources` (pending the license gate).
- `main.rs`: `mod wake;` + any `#[tauri::command]` for a mic-permission/status probe if needed.
- **Test:** *(Mac spike)* the three models load; a stock phrase ("hey jarvis") detects reliably at threshold with acceptable false-accept/false-reject over a short session; CPU < a few %; the mic indicator behavior is understood.

### D4 — Settings UI · *(Mac, HTML/CSS)*
Toggle "Wake word (beta)" + a handler picker (Dictate / Command) + threshold slider + a clear "always-listening / on-device only" explainer and the mic-indicator note. Not in the cloud snapshot; listed for the Mac.

### D5 — UX / privacy / cost (design constraints)
- **Off by default; one toggle to disable.** Preserves the "mic only opens on explicit activation" promise for everyone who leaves it off.
- **Always-on mic ⇒ the macOS orange mic indicator stays on** while enabled — surface this in the toggle copy so it's expected, not alarming.
- **On-device only:** wake audio is never streamed anywhere; only *after* detection does the normal (BYOK) pipeline run. Document in the privacy copy.
- **Battery/CPU:** a small but continuous load; measured in the Mac spike. Consider pausing on battery-saver.
- **(must-fix 2) Self-trigger is a REQUIREMENT, not a nicety:** detection is gated off during a live dictation/command session (`RECORDING||COMMAND_RECORDING`). Without this the user's own dictation of the phrase re-fires activation.
- **(should-fix 3) Mic permission:** enabling wake word engages the mic (+ orange dot) with no prior dictation, so the first enable may trigger the macOS mic TCC prompt; the status probe reports "mic granted?" (mirror fnkey's input-monitoring status).
- **False/missed triggers:** threshold + patience are the tuning levers; threshold is exposed in settings (live-tunable).

## 4. Testing checklist

**Cloud (green before commit):**
- [ ] `settings.ts` `wakeWord` types typecheck; no core regressions.
- [ ] (no meaningful runtime cloud test — the phase is native; state this explicitly.)

**Mac spike (the real gate — in `p3-progress.md`):**
- [ ] `cargo build` with `ort`/`cpal`/`ndarray`; the 3 ONNX models load from resources.
- [ ] stock phrase detects at threshold; measured false-accept / false-reject over a few minutes.
- [ ] detection fires `dictate`/`command` activation identically to the hotkey; one utterance = one activation.
- [ ] `wake_word_enabled` toggle starts/stops the listener from Settings; survives restart; disabled = no mic session, no orange dot.
- [ ] CPU/battery overhead measured and acceptable; document the machine spec.
- [ ] (follow-up) train a custom "hey verbatim" model via openWakeWord and swap `wake_word_model`.

## 5. Risks / notes
- **The ONNX pipeline is the risk** — tensor shapes + mel preprocessing must match openWakeWord exactly; validated on the Mac, not authored blind. Treat D3 as a spike with a binary "does it detect reliably" gate before wiring it as a default-available feature.
- **Always-on mic** is a UX/trust surface (orange dot, battery) — off by default, clear copy, easy off.
- **Model assets + custom-word training** are their own follow-up (data + a training run); v1 proves the pipeline on a stock phrase.
- `cpal` always-on capture is independent of the webview dictation mic — confirm they coexist (two consumers of the input device) on the Mac.
