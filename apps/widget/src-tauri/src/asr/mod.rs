//! Local Nemotron ASR via NeMo-Speech.cpp (Metal on Apple Silicon).
//!
//! Lifecycle: initialized at app launch → model mmap/load → warm idle → sessions reuse
//! the persistent worker without reloading weights.

mod capture;
mod ffi;
mod ipc;
mod memory;
mod metrics;
mod stabilizer;
mod worker;

use capture::DictationCapture;
use metrics::{AsrMetrics, MetricsCollector};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::AppHandle;
use worker::{AsrWorker, AsrWorkerConfig};

static STATE: OnceLock<Mutex<Option<Arc<AsrRuntime>>>> = OnceLock::new();

struct AsrRuntime {
    worker: Arc<AsrWorker>,
    capture: DictationCapture,
    metrics: Arc<MetricsCollector>,
}

fn state() -> &'static Mutex<Option<Arc<AsrRuntime>>> {
    STATE.get_or_init(|| Mutex::new(None))
}

/// Initialize the persistent ASR worker at application launch.
pub fn init_at_launch(app: &AppHandle) {
    let cfg = crate::config::read_config(app);
    if cfg.stt_provider != "nemotron" {
        eprintln!("[asr] skipped init — stt_provider={}", cfg.stt_provider);
        return;
    }

    let worker_cfg = AsrWorkerConfig::from_app(app, &cfg);
    let metrics = Arc::new(MetricsCollector::new());
    let worker = Arc::new(AsrWorker::spawn(app.clone(), worker_cfg, metrics.clone()));
    ipc::spawn_ipc_server(app.clone(), worker.clone(), metrics.clone());
    ipc::install_event_bridge(app);

    *state().lock().unwrap() = Some(Arc::new(AsrRuntime {
        worker,
        capture: DictationCapture::new(),
        metrics,
    }));
    eprintln!("[asr] persistent worker initialized");
}

fn runtime() -> Result<Arc<AsrRuntime>, String> {
    state()
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "ASR runtime not initialized — set stt_provider=nemotron".into())
}

#[tauri::command]
pub fn asr_get_metrics() -> Result<AsrMetrics, String> {
    Ok(runtime()?.metrics.snapshot())
}

#[tauri::command]
pub fn asr_get_status(app: tauri::AppHandle) -> Result<AsrMetrics, String> {
    let cfg = crate::config::read_config(&app);
    let rt = runtime()?;
    let mut m = rt.metrics.snapshot();
    if m.model_path.is_empty() {
        m.model_path = AsrWorkerConfig::from_app(&app, &cfg).model_path;
    }
    Ok(m)
}

#[tauri::command]
pub fn asr_start_native_session(app: tauri::AppHandle) -> Result<(), String> {
    let rt = runtime()?;
    let cfg = crate::config::read_config(&app);
    let device = if cfg.mic_device_id.is_empty() {
        None
    } else {
        Some(cfg.mic_device_id.clone())
    };
    // Session is opened by the backend nemotron IPC client; this only starts cpal capture.
    rt.capture.start(rt.worker.clone(), device)
}

#[tauri::command]
pub fn asr_stop_native_session() -> Result<(), String> {
    let rt = runtime()?;
    rt.capture.stop();
    Ok(())
}

#[tauri::command]
pub fn asr_ipc_port() -> u16 {
    ipc::ipc_port()
}
