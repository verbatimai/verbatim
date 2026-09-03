//! Local Nemotron ASR via NeMo-Speech.cpp (Metal on Apple Silicon).
//!
//! Lifecycle: initialized at app launch → model mmap/load → warm idle → sessions reuse
//! the persistent worker without reloading weights.

mod capture;
mod ffi;
mod ipc;
mod memory;
mod metrics;
mod models;
mod stabilizer;
mod worker;

use capture::DictationCapture;
use metrics::{AsrMetrics, MetricsCollector};
use models::{AsrDownloadStatus, ensure_model_downloaded, model_is_ready};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use worker::{AsrWorker, AsrWorkerConfig};

static STATE: OnceLock<Mutex<Option<Arc<AsrRuntime>>>> = OnceLock::new();
static INIT_BUSY: AtomicBool = AtomicBool::new(false);

struct AsrRuntime {
    worker: Arc<AsrWorker>,
    capture: DictationCapture,
    metrics: Arc<MetricsCollector>,
}

fn state() -> &'static Mutex<Option<Arc<AsrRuntime>>> {
    STATE.get_or_init(|| Mutex::new(None))
}

fn spawn_runtime(app: &AppHandle, cfg: &crate::config::AppConfig) {
    if state().lock().unwrap().is_some() {
        return;
    }

    let worker_cfg = AsrWorkerConfig::from_app(app, cfg);
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

fn prepare_and_spawn(app: AppHandle) {
    let cfg = crate::config::read_config(&app);
    if cfg.stt_provider != "nemotron" {
        return;
    }

    if model_is_ready(&app, &cfg) {
        spawn_runtime(&app, &cfg);
        return;
    }

    if cfg.asr_auto_download_model {
        match ensure_model_downloaded(&app, &cfg) {
            Ok(_) => eprintln!("[asr] model ready"),
            Err(e) => {
                eprintln!("[asr] model download failed: {e}");
                models::set_download_error(&e);
                let _ = app.emit("asr-download-progress", models::download_status_snapshot());
            }
        }
    } else {
        eprintln!("[asr] model missing — run: git lfs install && git lfs pull");
    }

    spawn_runtime(&app, &cfg);
}

/// Initialize the persistent ASR worker at application launch (or when nemotron is selected).
pub fn init_at_launch(app: &AppHandle) {
    let cfg = crate::config::read_config(app);
    if cfg.stt_provider != "nemotron" {
        eprintln!("[asr] skipped init — stt_provider={}", cfg.stt_provider);
        return;
    }

    if state().lock().unwrap().is_some() || INIT_BUSY.swap(true, Ordering::SeqCst) {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        prepare_and_spawn(app);
        INIT_BUSY.store(false, Ordering::SeqCst);
    });
}

/// Re-run init when the user switches to nemotron without restarting the app.
pub fn reinit_if_needed(app: &AppHandle, old_provider: &str, new_provider: &str) {
    if new_provider != "nemotron" || old_provider == "nemotron" {
        return;
    }
    init_at_launch(app);
}

fn runtime() -> Result<Arc<AsrRuntime>, String> {
    state()
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| {
            let status = models::download_status_snapshot();
            if status.state == "downloading" {
                "ASR model is still downloading — try again in a moment".into()
            } else {
                "ASR runtime not initialized — set stt_provider=nemotron".into()
            }
        })
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
pub fn asr_get_download_status(app: tauri::AppHandle) -> AsrDownloadStatus {
    let mut status = models::download_status_snapshot();
    if status.model_path.is_empty() {
        status.model_path = models::resolve_model_path(&app, &crate::config::read_config(&app));
    }
    status
}

#[tauri::command]
pub fn asr_download_model(app: tauri::AppHandle) -> Result<AsrDownloadStatus, String> {
    let cfg = crate::config::read_config(&app);
    if cfg.stt_provider != "nemotron" {
        return Err("Switch speech-to-text to Nemotron (local) first".into());
    }

    let app_bg = app.clone();
    std::thread::spawn(move || {
        let cfg = crate::config::read_config(&app_bg);
        let _ = ensure_model_downloaded(&app_bg, &cfg);
        if state().lock().unwrap().is_none() {
            spawn_runtime(&app_bg, &cfg);
        }
    });

    Ok(models::download_status_snapshot())
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
