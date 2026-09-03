//! Persistent ASR worker — model loaded once at app launch.

use super::ffi::{self, Engine, LiveStream, SAMPLE_RATE};
use super::metrics::MetricsCollector;
use super::models;
use super::stabilizer::TranscriptStabilizer;
use crate::config::AppConfig;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

const MAX_QUEUE_CHUNKS: usize = 256;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptUpdate {
    pub utterance_id: String,
    pub text: String,
    pub stable_text: String,
    pub active_text: String,
    pub is_final: bool,
    pub endpoint: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub t_ms: Option<u64>,
}

enum WorkerCmd {
    StartSession {
        language: String,
        reply: SyncSender<Result<(), String>>,
    },
    PushPcm {
        samples: Vec<i16>,
    },
    StopSession {
        reply: SyncSender<Result<String, String>>,
    },
    Shutdown,
}

#[derive(Clone, Debug)]
pub struct AsrWorkerConfig {
    pub model_path: String,
    pub streaming_ms: u32,
    pub use_metal: bool,
    pub vad_model_path: String,
    pub vad_onset: f32,
    pub vad_offset: f32,
    pub language: String,
}

impl AsrWorkerConfig {
    pub fn from_app(app: &AppHandle, cfg: &AppConfig) -> Self {
        let model_path = models::resolve_model_path(app, cfg);
        Self {
            model_path,
            streaming_ms: cfg.asr_streaming_ms,
            use_metal: cfg.asr_use_metal,
            vad_model_path: cfg.asr_vad_model_path.clone(),
            vad_onset: cfg.asr_vad_onset,
            vad_offset: cfg.asr_vad_offset,
            language: cfg.language.clone(),
        }
    }
}

pub struct AsrWorker {
    tx: Sender<WorkerCmd>,
    metrics: Arc<MetricsCollector>,
    event_tx: Arc<Mutex<Option<Sender<IpcEvent>>>>,
    _handle: JoinHandle<()>,
}

#[derive(Clone, Debug)]
pub enum IpcEvent {
    Live { transcript: String, active: String },
    Transcript(TranscriptUpdate),
}

impl AsrWorker {
    pub fn spawn(app: AppHandle, cfg: AsrWorkerConfig, metrics: Arc<MetricsCollector>) -> Self {
        let (tx, rx) = mpsc::channel();
        let event_tx: Arc<Mutex<Option<Sender<IpcEvent>>>> = Arc::new(Mutex::new(None));
        let events = event_tx.clone();
        let m = metrics.clone();
        let handle = thread::Builder::new()
            .name("verbatim-asr".into())
            .spawn(move || worker_main(app, rx, cfg, m, events))
            .expect("spawn asr worker");
        Self {
            tx,
            metrics,
            event_tx,
            _handle: handle,
        }
    }

    pub fn set_event_sink(&self, sink: Option<Sender<IpcEvent>>) {
        *self.event_tx.lock().unwrap() = sink;
    }

    pub fn metrics(&self) -> Arc<MetricsCollector> {
        self.metrics.clone()
    }

    pub fn start_session(&self, language: &str) -> Result<(), String> {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        self.tx
            .send(WorkerCmd::StartSession {
                language: language.into(),
                reply: reply_tx,
            })
            .map_err(|e| e.to_string())?;
        reply_rx.recv().map_err(|e| e.to_string())?
    }

    pub fn push_pcm(&self, samples: Vec<i16>) -> Result<(), String> {
        self.tx
            .send(WorkerCmd::PushPcm { samples })
            .map_err(|e| e.to_string())
    }

    pub fn stop_session(&self) -> Result<String, String> {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        self.tx
            .send(WorkerCmd::StopSession { reply: reply_tx })
            .map_err(|e| e.to_string())?;
        reply_rx.recv().map_err(|e| e.to_string())?
    }
}

struct SessionState {
    stream: LiveStream,
    stabilizer: TranscriptStabilizer,
    utterance: u64,
    session_audio: Vec<f32>,
    started: Instant,
}

fn worker_main(
    app: AppHandle,
    rx: Receiver<WorkerCmd>,
    cfg: AsrWorkerConfig,
    metrics: Arc<MetricsCollector>,
    event_tx: Arc<Mutex<Option<Sender<IpcEvent>>>>,
) {
    let runtime = ffi::detect_runtime(cfg.use_metal);
    metrics.set_runtime_info(
        &runtime.backend,
        &runtime.device,
        runtime.metal_available,
        "nemotron-speech-streaming-en-0.6b",
        &ffi::infer_quantization(&cfg.model_path),
        cfg.streaming_ms,
        &cfg.model_path,
        ffi::is_linked(),
    );
    metrics.log_startup();

    let worker_cfg = cfg.clone();
    let mut engine: Option<Engine> = None;
    let mut session: Option<SessionState> = None;
    let mut pending_audio: VecDeque<Vec<i16>> = VecDeque::new();

    if let Err(e) = ensure_engine(&mut engine, &worker_cfg, &metrics) {
        eprintln!("[asr] model load failed: {e}");
        if !ffi::is_linked() {
            eprintln!(
                "[asr] NeMo-Speech.cpp is not linked — rebuild with:\n\
                   export NEMO_SPEECH_PREFIX=$HOME/nemo-speech\n\
                   cargo build -p verbatim-widget --features nemotron"
            );
        }
    }

    while let Ok(cmd) = rx.recv() {
        match cmd {
            WorkerCmd::StartSession { language, reply } => {
                let lang = if language.is_empty() {
                    worker_cfg.language.clone()
                } else {
                    language
                };
                metrics.begin_session();
                pending_audio.clear();
                match engine.as_ref() {
                    Some(eng) => match eng.start_stream(&lang) {
                        Ok(stream) => {
                            session = Some(SessionState {
                                stream,
                                stabilizer: TranscriptStabilizer::default(),
                                utterance: 1,
                                session_audio: Vec::new(),
                                started: Instant::now(),
                            });
                            let _ = reply.send(Ok(()));
                        }
                        Err(e) => {
                            let _ = reply.send(Err(e.to_string()));
                        }
                    },
                    None => {
                        let _ = reply.send(Err("ASR engine not loaded".into()));
                    }
                }
            }
            WorkerCmd::PushPcm { samples } => {
                if pending_audio.len() >= MAX_QUEUE_CHUNKS {
                    metrics.inc_dropped();
                    eprintln!("[asr] dropped audio chunk — inference queue full");
                } else {
                    pending_audio.push_back(samples);
                    metrics.set_queue_depth(pending_audio.len() as u64);
                }
            }
            WorkerCmd::StopSession { reply } => {
                let t0 = Instant::now();
                let result = finalize_session(&mut session, &engine, &worker_cfg, &metrics);
                metrics.note_finalize(t0.elapsed().as_millis() as u64);
                metrics.update_process_memory();
                let _ = reply.send(result);
            }
            WorkerCmd::Shutdown => break,
        }

        while let Some(pcm) = pending_audio.pop_front() {
            metrics.set_queue_depth(pending_audio.len() as u64);
            let f32_samples: Vec<f32> = pcm.iter().map(|s| *s as f32 / 32768.0).collect();
            let audio_ms = (f32_samples.len() as f64 / SAMPLE_RATE as f64) * 1000.0;
            metrics.note_audio_chunk(audio_ms);

            if let Some(sess) = session.as_mut() {
                sess.session_audio.extend_from_slice(&f32_samples);
                let infer_t0 = Instant::now();
                if let Err(e) = sess.stream.push_f32(&f32_samples) {
                    eprintln!("[asr] push failed: {e}");
                    continue;
                }
                let infer_ms = infer_t0.elapsed().as_secs_f64() * 1000.0;
                metrics.note_inference(infer_ms, audio_ms);
                drain_stream_results(&app, sess, &metrics, &event_tx);
            }
        }
    }
}

fn ensure_engine(
    engine: &mut Option<Engine>,
    cfg: &AsrWorkerConfig,
    metrics: &MetricsCollector,
) -> Result<(), String> {
    if engine.is_some() {
        return Ok(());
    }
    let before = super::memory::resident_mb().unwrap_or(0.0);
    metrics.begin_model_load();

    let vad = if cfg.vad_model_path.is_empty() {
        None
    } else {
        Some(cfg.vad_model_path.as_str())
    };
    let loaded = ffi::load_engine(
        &cfg.model_path,
        cfg.streaming_ms,
        cfg.use_metal,
        vad,
        cfg.vad_onset,
        cfg.vad_offset,
    )
    .map_err(|e| e.to_string())?;
    let steady = super::memory::resident_mb().unwrap_or(before);
    metrics.end_model_load(steady.max(before), steady);
    *engine = Some(loaded);
    Ok(())
}

fn drain_stream_results(
    app: &AppHandle,
    sess: &mut SessionState,
    metrics: &MetricsCollector,
    event_tx: &Arc<Mutex<Option<Sender<IpcEvent>>>>,
) {
    loop {
        match sess.stream.next_result() {
            Ok(Some((text, is_final))) if !text.is_empty() => {
                let (stable, active) = sess.stabilizer.update(&text, is_final);
                metrics.note_partial();
                let update = TranscriptUpdate {
                    utterance_id: format!("u{}", sess.utterance),
                    text,
                    stable_text: stable.clone(),
                    active_text: active.clone(),
                    is_final,
                    endpoint: is_final,
                    t_ms: Some(sess.started.elapsed().as_millis() as u64),
                };
                let _ = app.emit("asr-transcript", &update);
                let _ = app.emit(
                    "asr-live",
                    serde_json::json!({
                        "transcript": stable,
                        "active": active,
                    }),
                );
                if let Some(tx) = event_tx.lock().unwrap().as_ref() {
                    let _ = tx.send(IpcEvent::Live {
                        transcript: stable.clone(),
                        active: active.clone(),
                    });
                    let _ = tx.send(IpcEvent::Transcript(update.clone()));
                }
            }
            Ok(Some(_)) => continue,
            Ok(None) => break,
            Err(e) => {
                eprintln!("[asr] next_result: {e}");
                break;
            }
        }
    }
}

fn finalize_session(
    session: &mut Option<SessionState>,
    engine: &Option<Engine>,
    cfg: &AsrWorkerConfig,
    metrics: &MetricsCollector,
) -> Result<String, String> {
    let Some(mut sess) = session.take() else {
        return Ok(String::new());
    };

    let _ = sess.stream.finish();
    // Drain remaining results without emit (session ending).
    while let Ok(Some((text, is_final))) = sess.stream.next_result() {
        if !text.is_empty() {
            sess.stabilizer.update(&text, is_final);
        }
    }

    let text = if let Some(eng) = engine.as_ref() {
        match eng.transcribe_offline(&sess.session_audio, &cfg.language) {
            Ok(t) if !t.trim().is_empty() => t,
            _ => sess.stabilizer.finalize(),
        }
    } else {
        sess.stabilizer.finalize()
    };

    drop(sess);
    metrics.update_process_memory();
    Ok(text.trim().to_string())
}
