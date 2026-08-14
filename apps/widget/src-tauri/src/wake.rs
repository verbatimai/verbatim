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
//   ort     = "2"            # ONNX Runtime bindings — runs the 3 openWakeWord models.
//   cpal    = "0.15"         # cross-platform audio capture — an INDEPENDENT always-on input
//                            #   stream, separate from the webview's getUserMedia dictation mic.
//   ndarray = "0.16"         # tensor buffers for the mel window + rolling embedding window.
//   ureq    = "2"            # tiny blocking HTTP client (rustls TLS on by default) — downloads
//                            #   the models on first enable (see ensure_models); runs on the wake thread.
// Model assets — DOWNLOAD-ON-FIRST-USE (the chosen fallback to the license gate). Rather than
//   BUNDLING melspectrogram.onnx + embedding_model.onnx (which derive from Google's speech-
//   embedding model), the app DOWNLOADS all three files from openWakeWord's official release into
//   a writable app-data dir on first enable (`ensure_models`). Verbatim therefore never
//   redistributes them, which sidesteps the redistribution-license question entirely. openWakeWord
//   itself is Apache-2.0. No `bundle.resources` entry is needed. (VERIFY on Mac: the `.onnx` assets
//   exist on the v0.5.1 release — openWakeWord ships both `.tflite` and `.onnx`, same stem.)
// ───────────────────────────────────────────────────────────────────────────────────────
#![cfg(target_os = "macos")]

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::config::AppConfig;

// ───────────────────────────── audio / pipeline constants ───────────────────────────────
/// openWakeWord operates entirely at 16 kHz mono. If the input device runs at another rate
/// (48 kHz is the macOS default), the capture callback must resample down to this.
const SAMPLE_RATE: u32 = 16_000;

/// After a detection fires, ignore further detections for this long so ONE utterance = ONE
/// activation (openWakeWord's per-frame score can stay high for several frames). Complements
/// the model's own "patience" (N consecutive frames over threshold) — see the pipeline below.
const DEBOUNCE_MS: u128 = 2_000;

// ───────────────────────── model assets (download-on-first-use) ──────────────────────────
/// openWakeWord official release (v0.5.1). We DOWNLOAD these into a writable app-data dir on
/// first enable rather than bundling them, so Verbatim never redistributes the Google-derived
/// melspectrogram/embedding models (the chosen fallback to the license gate).
const MODEL_BASE_URL: &str = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1";
const SHARED_MODELS: [&str; 2] = ["melspectrogram.onnx", "embedding_model.onnx"];

/// Map the config's short model id to its release filename (pretrained wake words carry a
/// version suffix). An unknown id is assumed to already be a full filename stem.
fn word_filename(model: &str) -> String {
    match model {
        "hey_jarvis" => "hey_jarvis_v0.1.onnx".into(),
        "alexa" => "alexa_v0.1.onnx".into(),
        "hey_mycroft" => "hey_mycroft_v0.1.onnx".into(),
        "hey_rhasspy" => "hey_rhasspy_v0.1.onnx".into(),
        other => format!("{other}.onnx"),
    }
}

/// Ensure the 3 model files exist in a writable app-data dir, downloading any that are missing
/// from the openWakeWord release. Returns the dir. Blocking (runs on the wake thread); a clean
/// failure (offline / 404) just declines to start the listener rather than crashing.
fn ensure_models(app: &AppHandle, model: &str) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("wakeword");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    let mut files: Vec<String> = SHARED_MODELS.iter().map(|s| s.to_string()).collect();
    files.push(word_filename(model));

    for name in &files {
        let dest = dir.join(name);
        let have = std::fs::metadata(&dest).map(|m| m.len() > 0).unwrap_or(false);
        if have {
            continue;
        }
        let url = format!("{MODEL_BASE_URL}/{name}");
        eprintln!("[wake] downloading model {name} …");
        download_file(&url, &dest)?;
        eprintln!("[wake] downloaded {name}");
    }
    Ok(dir)
}

/// Blocking download to a `.part` temp then atomic rename, so a partial download is never seen
/// as a valid model. Uses `ureq` (rustls TLS on by default; follows the GitHub release redirect).
fn download_file(url: &str, dest: &std::path::Path) -> Result<(), String> {
    let resp = ureq::get(url).call().map_err(|e| format!("GET {url}: {e}"))?;
    let tmp = dest.with_extension("part");
    let mut reader = resp.into_reader();
    let mut file =
        std::fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
    std::io::copy(&mut reader, &mut file).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    file.sync_all().ok();
    std::fs::rename(&tmp, dest).map_err(|e| format!("rename into {}: {e}", dest.display()))?;
    Ok(())
}

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

// ───────────────────────────── openWakeWord inference pipeline ───────────────────────────
// Constants from openWakeWord's streaming design (github.com/dscripka/openWakeWord). These are
// the documented defaults; if detection is poor, the frame math is the thing to re-verify.
const CHUNK: usize = 1280; // 80 ms @ 16 kHz — one streaming step
const MEL_BINS: usize = 32; // mel bands the melspectrogram model emits
const EMB_WINDOW_MELS: usize = 76; // mel frames per embedding window
const EMB_DIM: usize = 96; // embedding vector length
const WAKE_WINDOW: usize = 16; // embeddings the wake-word classifier reads (~1.28 s)
const MEL_CONTEXT: usize = 480; // 160*3 raw samples of lookback fed to each melspec call. openWakeWord
                                // runs melspec on CHUNK+480 samples; its frame formula (ceil(N/160)-3)
                                // drops exactly these 3 context frames, so each call emits 8 fresh,
                                // non-overlapping frames aligned to the new CHUNK.
const MEL_KEEP: usize = 200; // mel frames retained (need ≥ EMB_WINDOW_MELS for the window; bound the rest)
const RAW_KEEP: usize = 4000; // raw samples retained (need ≥ CHUNK+MEL_CONTEXT = 1760 for context)
const MELSPEC_DIV: f32 = 10.0; // openWakeWord melspec transform: mel = mel/10 + 2
const MELSPEC_ADD: f32 = 2.0;
const PATIENCE: u32 = 3; // consecutive over-threshold predictions to confirm (tunable)

/// ⚠ ort 2.x API. The `Session::builder`/`commit_from_file`, `Tensor::from_array`, `run`, and
/// `try_extract_tensor` calls below target ort 2.x — pin the exact version in Cargo.toml and
/// expect the compiler to want small tweaks per the release (this is the spike's known risk).
///
/// Holds the 3 ort sessions + streaming buffers. `feed()` takes 16 kHz **int16-range** mono
/// audio (openWakeWord's melspec model is trained on int16 values, NOT −1..1) and returns the
/// newest wake-word score once a fresh prediction is available.
struct WakePipeline {
    mel: ort::session::Session,
    emb: ort::session::Session,
    word: ort::session::Session,
    raw: VecDeque<f32>,  // rolling raw 16 kHz int16-range samples (keeps ≥ CHUNK+MEL_CONTEXT for context)
    mels: Vec<f32>,      // flattened mel frames [frame * MEL_BINS], bounded to MEL_KEEP frames
    embs: VecDeque<f32>, // flattened embeddings, kept to the last WAKE_WINDOW (one produced per CHUNK)
    acc: usize,          // new raw samples accumulated since the last CHUNK was processed
}

impl WakePipeline {
    fn load(dir: &std::path::Path, model: &str) -> Result<Self, String> {
        use ort::session::Session;
        let mk = |p: std::path::PathBuf| -> Result<Session, String> {
            Session::builder()
                .map_err(|e| e.to_string())?
                .commit_from_file(&p)
                .map_err(|e| format!("load {}: {e}", p.display()))
        };
        let mel = mk(dir.join("melspectrogram.onnx"))?;
        let emb = mk(dir.join("embedding_model.onnx"))?;
        let word = mk(dir.join(word_filename(model)))?;
        // Log graph input names so the exact shapes/names are visible on the Mac (spike aid).
        eprintln!(
            "[wake] loaded models — mel/emb/word inputs: {:?} / {:?} / {:?}",
            mel.inputs().iter().map(|i| i.name().to_string()).collect::<Vec<_>>(),
            emb.inputs().iter().map(|i| i.name().to_string()).collect::<Vec<_>>(),
            word.inputs().iter().map(|i| i.name().to_string()).collect::<Vec<_>>(),
        );
        Ok(Self {
            mel,
            emb,
            word,
            raw: VecDeque::new(),
            mels: Vec::new(),
            embs: VecDeque::new(),
            acc: 0,
        })
    }

    /// Run a single-input / single-output f32 ONNX session. Returns the flat output data.
    fn run(session: &mut ort::session::Session, shape: Vec<i64>, data: Vec<f32>) -> Result<Vec<f32>, String> {
        let tensor = ort::value::Tensor::from_array((shape, data)).map_err(|e| e.to_string())?;
        let outputs = session
            .run(ort::inputs![tensor])
            .map_err(|e| e.to_string())?;
        let (_shape, out) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        Ok(out.to_vec())
    }

    /// Push 16 kHz int16-range mono audio; returns the newest wake score if one was produced.
    ///
    /// Mirrors openWakeWord's streaming pipeline exactly: buffer raw audio, and every CHUNK
    /// (1280 samples / 80 ms) run melspec on the LAST CHUNK+MEL_CONTEXT raw samples (the context
    /// gives the model lookback; its frame formula drops those 3 frames, so 8 fresh mel frames
    /// come out), take the LAST EMB_WINDOW_MELS (76) mel frames → ONE embedding, then score over
    /// the last WAKE_WINDOW (16) embeddings. One embedding + one score per CHUNK — NOT a step-8
    /// sliding window (the earlier version's cadence bug capped the score).
    fn feed(&mut self, samples: &[f32]) -> Option<f32> {
        let mut newest: Option<f32> = None;

        for &s in samples {
            self.raw.push_back(s);
            self.acc += 1;
            if self.acc < CHUNK {
                continue;
            }
            self.acc = 0;

            // 1) melspec on the last CHUNK + MEL_CONTEXT raw samples (context = model lookback).
            let need = CHUNK + MEL_CONTEXT;
            let take = need.min(self.raw.len());
            if take < 400 {
                continue; // openWakeWord requires ≥ 400 samples (25 ms) for a melspec frame
            }
            let start = self.raw.len() - take;
            let slice: Vec<f32> = self.raw.iter().skip(start).copied().collect();
            let mel_out = match Self::run(&mut self.mel, vec![1, take as i64], slice) {
                Ok(o) => o,
                Err(e) => {
                    eprintln!("[wake] melspec error: {e}");
                    return newest;
                }
            };
            // melspec out is [1,1,frames,32]; apply openWakeWord's transform (x/10 + 2) and append.
            for v in &mel_out {
                self.mels.push(v / MELSPEC_DIV + MELSPEC_ADD);
            }
            // Bound the buffers — keep only what the windows below need.
            let frames = self.mels.len() / MEL_BINS;
            if frames > MEL_KEEP {
                self.mels.drain(..(frames - MEL_KEEP) * MEL_BINS);
            }
            while self.raw.len() > RAW_KEEP {
                self.raw.pop_front();
            }

            // 2) ONE embedding over the LAST EMB_WINDOW_MELS mel frames (once enough accumulate).
            let frames = self.mels.len() / MEL_BINS;
            if frames < EMB_WINDOW_MELS {
                continue;
            }
            let begin = (frames - EMB_WINDOW_MELS) * MEL_BINS;
            let window = self.mels[begin..].to_vec(); // exactly EMB_WINDOW_MELS * MEL_BINS values
            let e = match Self::run(
                &mut self.emb,
                vec![1, EMB_WINDOW_MELS as i64, MEL_BINS as i64, 1],
                window,
            ) {
                Ok(o) => o,
                Err(e) => {
                    eprintln!("[wake] embedding error: {e}");
                    return newest;
                }
            };
            // embedding out may be [1,1,1,96]; take the trailing EMB_DIM values.
            for &v in &e[e.len().saturating_sub(EMB_DIM)..] {
                self.embs.push_back(v);
            }
            while self.embs.len() > WAKE_WINDOW * EMB_DIM {
                self.embs.pop_front();
            }

            // 3) score over the last WAKE_WINDOW embeddings, once the window is full.
            if self.embs.len() >= WAKE_WINDOW * EMB_DIM {
                let feat: Vec<f32> = self.embs.iter().copied().collect();
                match Self::run(&mut self.word, vec![1, WAKE_WINDOW as i64, EMB_DIM as i64], feat) {
                    Ok(o) => newest = o.first().copied(),
                    Err(e) => eprintln!("[wake] wakeword error: {e}"),
                }
            }
        }
        newest
    }
}

/// Linear-resample device-rate f32 (−1..1) → 16 kHz **int16-range** f32 (×32767), taking mono
/// channel 0 from an interleaved buffer. openWakeWord's melspec model wants int16-magnitude input.
fn resample_to_16k_int16(input: &[f32], in_rate: u32, channels: usize) -> Vec<f32> {
    let mono: Vec<f32> = if channels <= 1 {
        input.to_vec()
    } else {
        input.iter().step_by(channels).copied().collect()
    };
    if in_rate == SAMPLE_RATE {
        return mono.iter().map(|s| s * 32767.0).collect();
    }
    let ratio = in_rate as f32 / SAMPLE_RATE as f32;
    let out_len = (mono.len() as f32 / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f32 * ratio;
        let idx = src as usize;
        let frac = src - idx as f32;
        let a = mono.get(idx).copied().unwrap_or(0.0);
        let b = mono.get(idx + 1).copied().unwrap_or(a);
        out.push((a + (b - a) * frac) * 32767.0);
    }
    out
}

// ───────────────────────────────── D3 listener thread ───────────────────────────────────
// Runs on the dedicated "verbatim-wake" thread. Owns the cpal input stream + the 3 ort
// sessions for its entire life; loops pulling audio → mel → embedding → score until STOP.
fn run_listen_thread(app: AppHandle, model: String) {
    // Resolve the model assets — DOWNLOAD-ON-FIRST-USE into a writable app-data dir (the chosen
    // fallback to the license gate: fetch from openWakeWord's release rather than bundling /
    // redistributing them). Blocking, on this thread; a clean failure (offline) declines to start.
    let res_dir = match ensure_models(&app, &model) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[wake] model download/setup failed: {e} — listener not started");
            RUNNING.store(false, Ordering::SeqCst);
            return;
        }
    };
    // Load the 3 ONNX sessions.
    let mut pipeline = match WakePipeline::load(&res_dir, &model) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[wake] model load failed: {e} — listener not started");
            RUNNING.store(false, Ordering::SeqCst);
            return;
        }
    };

    // Open the default input device (engages the mic + the macOS orange dot) and stream f32
    // frames to this thread over a channel. macOS allows multiple mic clients, so this cpal
    // stream coexists with the webview's getUserMedia dictation mic — which is exactly why the
    // self-trigger gate in fire_activation() is required.
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        eprintln!("[wake] no default input device — listener not started");
        RUNNING.store(false, Ordering::SeqCst);
        return;
    };
    let supported = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[wake] default_input_config failed: {e} — listener not started");
            RUNNING.store(false, Ordering::SeqCst);
            return;
        }
    };
    let in_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let fmt = supported.sample_format();
    let config = supported.config();
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let err_fn = |e| eprintln!("[wake] cpal stream error: {e}");

    // macOS input is f32 by default; bail clearly on anything else rather than mis-reading samples.
    if fmt != cpal::SampleFormat::F32 {
        eprintln!("[wake] input sample format {fmt:?} unsupported (expected f32) — listener not started");
        RUNNING.store(false, Ordering::SeqCst);
        return;
    }
    let stream = device.build_input_stream(
        &config,
        move |data: &[f32], _: &cpal::InputCallbackInfo| {
            let _ = tx.send(data.to_vec());
        },
        err_fn,
        None,
    );
    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[wake] build_input_stream failed: {e} — listener not started");
            RUNNING.store(false, Ordering::SeqCst);
            return;
        }
    };
    if let Err(e) = stream.play() {
        eprintln!("[wake] stream.play failed: {e} — listener not started");
        RUNNING.store(false, Ordering::SeqCst);
        return;
    }

    RUNNING.store(true, Ordering::SeqCst);
    eprintln!("[wake] listener started (model '{model}', in_rate={in_rate}, ch={channels})");

    // Per-detection latch + patience: fire once the score holds over threshold for PATIENCE
    // predictions, then disarm until the score drops (the phrase ends) so one utterance = one fire.
    let mut armed = true;
    let mut over = 0u32;

    while !STOP.load(Ordering::SeqCst) {
        // Block briefly for audio so STOP stays responsive between callbacks.
        let frame = match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(f) => f,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let samples = resample_to_16k_int16(&frame, in_rate, channels);
        if let Some(score) = pipeline.feed(&samples) {
            let threshold = load_threshold(); // live-tunable each prediction
            // TEMP (spike): log any non-trivial score so the phrase's peak is visible for tuning.
            if score >= 0.1 {
                eprintln!("[wake] score {score:.3} (threshold {threshold:.2})");
            }
            if score >= threshold {
                over += 1;
                if armed && over >= PATIENCE {
                    if fire_activation(&app) {
                        eprintln!("[wake] '{model}' detected (score {score:.2})");
                    }
                    armed = false;
                    over = 0;
                }
            } else {
                over = 0;
                armed = true; // re-arm once the phrase ends
            }
        }
    }

    // Teardown: dropping the cpal Stream stops capture + releases the mic (clears the orange
    // dot); the ort sessions drop with `pipeline`.
    drop(stream);
    drop(pipeline);
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
