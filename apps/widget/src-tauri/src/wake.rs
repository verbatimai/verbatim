// P3 — Wake-Word Activation (openWakeWord, on-device) — listener scaffold.
//
// WHAT THIS IS: an OPTIONAL, off-by-default activation *source*. A tiny on-device model
// listens continuously and, on the trigger phrase, fires the SAME activation seam the
// hotkeys use (`win.show()` + set the recording flag + `emit("dictation"|"command","start")`).
// No raw audio ever leaves the device — the whole point of on-device spotting. It is one
// activation source among several (the hotkey stays primary); it never becomes the only way
// to reach a handler.
//
// STRUCTURE MIRRORS fnkey.rs: `set_enabled(app, on, cfg)` owns a background thread + an
// `AtomicBool` stop flag, so start/stop is idempotent and reconciled from set_config /
// clear_config / shortcuts::setup. `set_threshold` / `set_handler` publish to atomics the
// thread polls, so Settings changes tune the LIVE listener with no restart (should-fix 1).
//
// ⚠ MAC SPIKE. Like fnkey.rs this file CANNOT be compiled or verified in the cloud, AND the
// ONNX-inference + mel-preprocessing core is a genuine spike: the exact tensor shapes and mel
// normalization must be validated against openWakeWord's reference on the Mac, not authored
// blind. Every such boundary is flagged `// MAC SPIKE:` below. This phase ships the lifecycle
// + activation wiring authored correctly; the audio→ONNX→score core is proven on the Mac.
//
// ───────────────────────────────────────────────────────────────────────────────────────
// P3 Cargo deps (add to apps/widget/src-tauri/Cargo.toml on the Mac; versions pinned there —
// no Cargo.toml exists in this snapshot, so they are listed here rather than edited in):
//   ort     = "2"            # ONNX Runtime bindings — runs the 3 openWakeWord models
//                            #   (melspectrogram.onnx, embedding_model.onnx, <word>.onnx).
//   cpal    = "0.15"         # cross-platform audio capture — an INDEPENDENT always-on input
//                            #   stream, separate from the webview's getUserMedia dictation mic.
//   ndarray = "0.16"         # tensor buffers for the mel window + rolling embedding window
//                            #   handed to `ort` (Value::from_array).
// Model assets: ship melspectrogram.onnx + embedding_model.onnx (shared) + <word>.onnx under
//   src-tauri/resources/wakeword/ and add "resources/wakeword/*" to tauri.conf.json `bundle.resources`.
//   (must-fix 4 — LICENSE GATE: melspectrogram.onnx + embedding_model.onnx derive from Google's
//    speech-embedding model; verify they permit redistribution inside an MIT app BEFORE bundling.
//    openWakeWord itself is Apache-2.0 (ok). A license fail invalidates the bundling approach.)
// ───────────────────────────────────────────────────────────────────────────────────────
#![cfg(target_os = "macos")]

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::config::AppConfig;

// ───────────────────────────── audio / pipeline constants ───────────────────────────────
/// openWakeWord operates entirely at 16 kHz mono. If the input device runs at another rate
/// (48 kHz is the macOS default), the capture callback must resample down to this.
#[allow(dead_code)] // used once the MAC SPIKE audio pipeline (cpal resample) is implemented
const SAMPLE_RATE: u32 = 16_000;

/// After a detection fires, ignore further detections for this long so ONE utterance = ONE
/// activation (openWakeWord's per-frame score can stay high for several frames). Complements
/// the model's own "patience" (N consecutive frames over threshold) — see the pipeline below.
const DEBOUNCE_MS: u128 = 2_000;

// ───────────────────────────────── shared / module state ────────────────────────────────
/// The listener thread is live. Mirrors fnkey's RUNNING.
static RUNNING: AtomicBool = AtomicBool::new(false);
/// Cooperative stop flag the capture/inference loop polls each iteration (fnkey uses a
/// CFRunLoopStop; a cpal loop instead polls an AtomicBool and returns, joining cleanly).
static STOP: AtomicBool = AtomicBool::new(false);
static WAKE_THREAD: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);

/// The model currently loaded by the running thread. A change here (via set_enabled) is a
/// stop-then-start; the same value while running is a no-op (mirrors fnkey's CURRENT_KEY).
static CURRENT_MODEL: Mutex<String> = Mutex::new(String::new());

/// Live-tunable detection threshold, stored as f32 bits in an AtomicU32 (fnkey uses
/// AtomicI64 for the keycode; f32 has no atomic, so bit-pun through u32). The inference loop
/// loads this every frame, so a Settings change re-tunes without a restart (should-fix 1).
static THRESHOLD_BITS: AtomicU32 = AtomicU32::new(0);

/// Live-tunable handler selector. true = "command" (set COMMAND_RECORDING + emit "command"),
/// false = "dictate" (set RECORDING + emit "dictation"). Polled at fire time, so a Settings
/// change re-routes without a restart (should-fix 1).
static HANDLER_IS_COMMAND: AtomicBool = AtomicBool::new(false);

/// Last time a detection fired, for the DEBOUNCE_MS refractory window.
static LAST_FIRE_AT: Mutex<Option<Instant>> = Mutex::new(None);

fn store_threshold(t: f32) {
    // Clamp to the valid score range so a bad config can't disable (≤0) or dead-lock (>1) detection.
    let clamped = t.clamp(0.0, 1.0);
    THRESHOLD_BITS.store(clamped.to_bits(), Ordering::SeqCst);
}
fn load_threshold() -> f32 {
    f32::from_bits(THRESHOLD_BITS.load(Ordering::SeqCst))
}

// ───────────────────────────────── D2 activation (the seam) ─────────────────────────────
/// The FULL start handshake, identical to shortcuts.rs toggle-Pressed / fnkey fn_press
/// (must-fix 1): show the NSPanel overlay (Rust must do this — the webview can't), set the
/// recording flag TRUE, and emit the start event. Gated + debounced (must-fix 2).
///
/// Returns true if it actually fired (started a session), false if suppressed (self-trigger
/// gate or debounce) — the caller uses this to reset its per-detection latch.
fn fire_activation(app: &AppHandle) -> bool {
    // ── Self-trigger gate (must-fix 2, the linchpin) ──
    // Never fire while a dictation OR command session is already live, else the user
    // dictating the wake phrase re-triggers activation mid-session. Because must-fix 1 sets
    // the flag on start, this guard is self-suppressing for the session we ourselves start.
    if *crate::RECORDING.lock().unwrap() || *crate::COMMAND_RECORDING.lock().unwrap() {
        return false;
    }

    // ── Debounce: one utterance = one activation ──
    {
        let mut last = LAST_FIRE_AT.lock().unwrap();
        if let Some(t) = *last {
            if t.elapsed().as_millis() < DEBOUNCE_MS {
                return false;
            }
        }
        *last = Some(Instant::now());
    }

    // Summon the overlay WITHOUT stealing focus — show(), never set_focus() — matching the
    // hotkey/PTT paths. The panel is non-activating, so the target app keeps focus.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
    }

    if HANDLER_IS_COMMAND.load(Ordering::SeqCst) {
        // Command handler: mirror shortcuts.rs command toggle-start (set COMMAND_RECORDING +
        // emit "command","start"). Stop happens via the existing command hotkey tap / webview
        // finalize — which works ONLY because the flag is set here (must-fix 1).
        *crate::COMMAND_RECORDING.lock().unwrap() = true;
        let _ = app.emit("command", "start");
    } else {
        // Dictation handler: mirror shortcuts.rs toggle-start / fnkey fn_press.
        *crate::RECORDING.lock().unwrap() = true;
        let _ = app.emit("dictation", "start");
    }
    true
}

// ───────────────────────────────── D3 listener thread ───────────────────────────────────
// Runs on the dedicated "verbatim-wake" thread. Owns the cpal input stream + the 3 ort
// sessions for its entire life; loops pulling audio → mel → embedding → score until STOP.
fn run_listen_thread(app: AppHandle, model: String) {
    // Resolve the bundled model assets. In dev this is target/…/resources/; in a bundled .app
    // it is Contents/Resources/ — resource_dir() abstracts both (should-fix 2).
    let res_dir = match app.path().resource_dir() {
        Ok(d) => d.join("resources").join("wakeword"),
        Err(e) => {
            eprintln!("[wake] resource_dir() failed: {e} — cannot locate wake-word models");
            RUNNING.store(false, Ordering::SeqCst);
            return;
        }
    };
    let mel_path = res_dir.join("melspectrogram.onnx");
    let emb_path = res_dir.join("embedding_model.onnx");
    let word_path = res_dir.join(format!("{model}.onnx"));
    if !mel_path.exists() || !emb_path.exists() || !word_path.exists() {
        eprintln!(
            "[wake] missing model asset(s) under {} (model '{}') — listener not started",
            res_dir.display(),
            model
        );
        RUNNING.store(false, Ordering::SeqCst);
        return;
    }

    // MAC SPIKE: load the three ONNX sessions once here.
    //   let mel_session   = ort::Session::builder()?.commit_from_file(&mel_path)?;
    //   let emb_session   = ort::Session::builder()?.commit_from_file(&emb_path)?;
    //   let word_session  = ort::Session::builder()?.commit_from_file(&word_path)?;
    // The exact ort 2.x builder API + input/output NAMES must be confirmed against the model
    // graphs on the Mac (netron / ort introspection). Do NOT assume names here.

    // MAC SPIKE: open the default cpal input device and build an input stream.
    //   let host   = cpal::default_host();
    //   let device = host.default_input_device()?;      // engages the mic + the orange dot
    //   let config = device.default_input_config()?;    // typically 48 kHz f32 on macOS
    //   let stream = device.build_input_stream(&config.into(), move |data: &[f32], _| {
    //       // resample data -> SAMPLE_RATE mono, push into the ring buffer below
    //   }, err_cb, None)?;
    //   stream.play()?;
    // Confirm on the Mac: (a) cpal + the webview getUserMedia can hold the input device
    // simultaneously (macOS allows multiple mic clients — this is what makes the self-trigger
    // gate necessary, not optional); (b) the resample path to 16 kHz mono is correct.

    // A ring buffer of 16 kHz mono samples, fed by the cpal callback, drained by the loop.
    // MAC SPIKE: size + hop must match openWakeWord's framing (80 ms mel hop; the classifier
    // reads a rolling window of embeddings). Placeholder capacity ~ a few seconds.
    // let ring = HeapRb::<f32>::new(SAMPLE_RATE as usize * 4);

    RUNNING.store(true, Ordering::SeqCst);
    eprintln!("[wake] listener started (model '{}')", model);

    // Per-detection latch: require the score to drop back below threshold (a "release")
    // before we will fire again, so a single sustained utterance can't machine-gun activations
    // even inside the debounce window. Reset when fire_activation is suppressed too.
    let mut armed = true;

    while !STOP.load(Ordering::SeqCst) {
        // MAC SPIKE: the openWakeWord inference pipeline for one hop:
        //   1. pull one mel-hop worth of samples from the ring (16 kHz mono);
        //   2. melspectrogram.onnx  : samples          -> mel frames;
        //   3. embedding_model.onnx : mel window        -> a 96-dim embedding vector;
        //   4. push the embedding into a ROLLING window (openWakeWord keeps the last N);
        //   5. <word>.onnx          : rolling embedding window -> score in 0..1;
        //   6. detection = score >= threshold for `patience` consecutive hops.
        // The exact mel params (n_fft, hop, n_mels, normalization) + tensor shapes MUST be
        // validated against openWakeWord's reference implementation on the Mac — fabricating
        // them here would be a lie. Until then this loop just idles.
        //
        // let threshold = load_threshold();               // live-tunable, read every hop
        // let score = run_pipeline(&mut ring, &mel_session, &emb_session, &word_session, &mut emb_window);
        // if score >= threshold && patience_met {
        //     if armed { if fire_activation(&app) { /* fired */ } armed = false; }
        // } else if score < threshold {
        //     armed = true;                               // re-arm once the phrase ends
        // }
        let _ = (&app, load_threshold(), &mut armed, fire_activation); // silence unused until the spike lands

        // Idle cadence stand-in for the spike; the real loop is paced by the audio callback /
        // ring-buffer availability, not a fixed sleep.
        std::thread::sleep(Duration::from_millis(80));
    }

    // ── teardown (still on the listener thread) ──
    // MAC SPIKE: drop(stream) to stop capture + release the mic (clears the orange dot);
    // the ort sessions drop here too. cpal has no explicit close — dropping the Stream stops it.
    RUNNING.store(false, Ordering::SeqCst);
    eprintln!("[wake] listener stopped");
}

fn start_thread(app: &AppHandle, model: &str) {
    let mut slot = WAKE_THREAD.lock().unwrap();
    if let Some(h) = slot.as_ref() {
        if !h.is_finished() {
            return; // a live listener thread already runs
        }
    }
    if let Some(done) = slot.take() {
        let _ = done.join(); // reap a finished thread (e.g. a prior missing-asset failure)
    }
    STOP.store(false, Ordering::SeqCst);
    let app_owned = app.clone();
    let model_owned = model.to_string();
    let handle = std::thread::Builder::new()
        .name("verbatim-wake".into())
        .spawn(move || run_listen_thread(app_owned, model_owned))
        .ok();
    *slot = handle;
}

fn stop_thread() {
    // Signal the loop to return, then join so teardown (stream drop + mic release) completes
    // before we return — mirrors fnkey's stop_tap join discipline.
    STOP.store(true, Ordering::SeqCst);
    let joiner = WAKE_THREAD.lock().unwrap().take();
    if let Some(join) = joiner {
        let _ = join.join();
    }
}

// ───────────────────────────────────── public surface ──────────────────────────────────
/// Start or stop the wake-word listener. Only runs the listener when `on` is true, so a user
/// who never enables wake word never engages the mic (no orange dot, no TCC prompt).
///
/// SELECTIVE (should-fix 1): the caller (config::set_config) only invokes this for an
/// enabled/model change — the heavy path (cpal + 3 ONNX sessions). Threshold/handler changes
/// go through set_threshold / set_handler instead (no restart). We still publish the current
/// threshold + handler here so a fresh thread starts already tuned. A model change while
/// running is a stop-then-start; the same model while running is a no-op; off while stopped
/// is a no-op.
pub fn set_enabled(app: &AppHandle, on: bool, cfg: &AppConfig) {
    // Keep the live atomics in sync with config on every reconcile.
    store_threshold(cfg.wake_word_threshold);
    HANDLER_IS_COMMAND.store(cfg.wake_word_handler == "command", Ordering::SeqCst);

    if on {
        let want = cfg.wake_word_model.clone();
        let same = RUNNING.load(Ordering::SeqCst) && *CURRENT_MODEL.lock().unwrap() == want;
        if same {
            return; // already listening on this model; threshold/handler already pushed above
        }
        stop_thread(); // stop any prior listener (model change) / reap a finished thread
        *CURRENT_MODEL.lock().unwrap() = want.clone();
        start_thread(app, &want);
    } else {
        *CURRENT_MODEL.lock().unwrap() = String::new();
        stop_thread();
    }
}

/// Push a new detection threshold to the LIVE listener (no restart) — should-fix 1.
pub fn set_threshold(threshold: f32) {
    store_threshold(threshold);
}

/// Push a new handler selection to the LIVE listener (no restart) — should-fix 1.
pub fn set_handler(handler: &str) {
    HANDLER_IS_COMMAND.store(handler == "command", Ordering::SeqCst);
}

/// Is the listener thread currently running? (For the Settings status line.)
pub fn is_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

/// Microphone permission status probe, the mic analogue of fnkey::input_monitoring_status.
/// Enabling wake word engages the mic with no prior dictation, so the first enable may raise
/// the macOS mic (TCC kTCCServiceMicrophone) prompt — Settings surfaces "mic granted?" via
/// this command (should-fix 3).
#[tauri::command]
pub fn wake_mic_status() -> bool {
    // MAC SPIKE: a non-mutating mic-authorization read. The clean API is AVFoundation's
    //   AVCaptureDevice.authorizationStatus(for: .audio) == .authorized   (== 3)
    // reached via objc2 (objc2-av-foundation) — the mic analogue of IOHIDCheckAccess. This
    // codebase avoids objc2 in fnkey/axinject via hand-declared FFI, so the exact binding is
    // decided at the Mac (add objc2-av-foundation, or msg_send! the class method). Until then
    // report whether the listener is up (a running listener implies the mic is engaged /
    // granted) so the UI has a truthful signal without a false "granted".
    is_running()
}
