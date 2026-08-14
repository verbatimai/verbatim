# P3 — Reviewer Verdict (independent cross-check, pre-implementation)

**Reviewer:** independent agent · **Date:** 14 Aug 2026 · **Input:** `p3-plan.md` vs. live code + engine feasibility.
**Verdict:** **APPROVE-WITH-CHANGES** → findings folded into `p3-plan.md` v2 → **approved** (D3 stays a Mac spike).

Engine choice (openWakeWord) + crates (`ort`/`cpal`/`ndarray`) + the "wake word = just another trigger onto the existing `emit(...,"start")` seam" insight are all right, and the Mac-spike scope is honest. Four must-fix + three should-fix.

## Must-fix (folded into v2)
1. **The start handshake is more than an emit.** Both real triggers (`fnkey.rs` fn_press, `shortcuts.rs` toggle-Pressed) do: `win.show()` on the `main` panel + set `RECORDING=true` + emit `("dictation","start")`. A bare emit won't show the overlay (Rust shows the NSPanel, not the webview) and leaves `RECORDING=false`, so the next hotkey tap starts a *second* session with no clean stop. **Resolution:** D2 replicates the full sequence (`win.show()` + set `RECORDING`/`COMMAND_RECORDING` true + emit); stop happens via the existing hotkey tap / webview finalize (works *because* the flag was set).
2. **Gate detection on an active session (self-trigger fix) — mandatory, not "consider."** While `RECORDING || COMMAND_RECORDING` is true, detection must not fire (else dictating the phrase re-triggers mid-session). **Same fix as #1:** once wake-start sets the flag, a `if RECORDING||COMMAND_RECORDING { skip }` guard self-suppresses. `wake.rs` reads `crate::RECORDING` (re-exported) + `crate::state::COMMAND_RECORDING` (add a re-export for symmetry). This is the linchpin.
3. **Settings must be FLAT camelCase, not nested.** `AppConfig` is flat and the store is "a SUPERSET of `AppSettings` — same camelCase keys." A nested `wakeWord:{…}` won't round-trip `set_config`'s shallow merge into the flat Rust fields. **Resolution:** `wakeWordEnabled?`, `wakeWordHandler?`, `wakeWordThreshold?`, `wakeWordModel?`.
4. **Gate on ONNX asset licenses before bundling.** openWakeWord is Apache-2.0 (✓), but `melspectrogram.onnx` + `embedding_model.onnx` derive from Google's speech-embedding model. **Resolution:** verify those two permit redistribution inside an MIT app *before* the Mac spike bundles them — a license fail invalidates the bundling approach.

## Should-fix (folded)
1. **Don't restart the audio+3-model stack for a threshold/handler change.** Only `wake_word_enabled`/`wake_word_model` restart the listener; `wake_word_threshold`/`wake_word_handler` push live to the running thread via atomics (mirror fnkey's `AtomicI64 PTT_KEYCODE`).
2. **Name the resource API:** `app.path().resource_dir()` join `resources/wakeword/…`; note dev-vs-bundled path.
3. **Mic-permission story:** enabling wake word engages the mic (+ orange dot) with no prior dictation → first enable may trigger the TCC prompt; the status probe should report "mic granted?" (mirror `fnkey`'s input-monitoring status).

## Feasibility
Solid. Pipeline correct (melspec → shared 96-dim embedding → per-word classifier over a rolling window → threshold/patience). `ort`+`ndarray`+`cpal` are the right maintained crates; Rust openWakeWord prior art exists. Residual risk (exact tensor shapes + mel normalization) is correctly isolated behind `// MAC SPIKE`. macOS allows multiple mic input clients, so `cpal` + the webview `getUserMedia` coexist — but leaving `cpal` live through a session is the self-trigger vector (must-fix #2).

## What's right worth keeping
Wake = another trigger on the existing seam; mirroring `fnkey::set_enabled` lifecycle (bg thread + `AtomicBool` stop, idempotent, reconciled from set_config/clear_config/setup); off-by-default + single-toggle + on-device-only + orange-dot disclosure; the honest plan+scaffold+Mac-spike scope.

## Outcome
v1 → **v2** with must-fix 1–4 + should-fix 1–3. Approved; D3 remains a Mac spike.
