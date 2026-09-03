//! Nemotron GGUF model path resolution and install from the repo bundle (Git LFS).

use crate::config::AppConfig;
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

pub const MODEL_FILE: &str = "nemotron-speech-streaming-en-0.6b.q8_0.gguf";
/// Path inside the repo (tracked via Git LFS). Resolved relative to repo root.
pub const MODEL_REL_PATH: &str = "models/nemotron/nemotron-speech-streaming-en-0.6b.q8_0.gguf";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrDownloadStatus {
    pub state: String,
    pub progress: f64,
    pub bytes_downloaded: u64,
    pub bytes_total: Option<u64>,
    pub model_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Default for AsrDownloadStatus {
    fn default() -> Self {
        Self {
            state: "idle".into(),
            progress: 0.0,
            bytes_downloaded: 0,
            bytes_total: None,
            model_path: String::new(),
            error: None,
        }
    }
}

static DOWNLOAD_STATUS: OnceLock<Mutex<AsrDownloadStatus>> = OnceLock::new();
static INSTALL_BUSY: AtomicBool = AtomicBool::new(false);

fn status_lock() -> &'static Mutex<AsrDownloadStatus> {
    DOWNLOAD_STATUS.get_or_init(|| Mutex::new(AsrDownloadStatus::default()))
}

pub fn download_status_snapshot() -> AsrDownloadStatus {
    status_lock().lock().unwrap().clone()
}

pub fn set_download_error(message: &str) {
    set_status(|s| {
        s.state = "error".into();
        s.error = Some(message.into());
    });
}

fn set_status(update: impl FnOnce(&mut AsrDownloadStatus)) {
    if let Ok(mut s) = status_lock().lock() {
        update(&mut s);
    }
}

fn emit_progress(app: &AppHandle, status: &AsrDownloadStatus) {
    let _ = app.emit("asr-download-progress", status.clone());
}

fn mark_ready(app: &AppHandle, path: &Path) {
    let model_path = path.to_string_lossy().into();
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    set_status(|s| {
        s.state = "ready".into();
        s.progress = 100.0;
        s.bytes_downloaded = size;
        s.bytes_total = Some(size);
        s.model_path = model_path;
        s.error = None;
    });
    emit_progress(app, &download_status_snapshot());
}

/// Default destination under Tauri app data (optional cached copy).
pub fn default_model_dest(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("models").join(MODEL_FILE))
        .map_err(|e| format!("app_data_dir: {e}"))
}

pub fn model_exists_at(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false)
}

/// Candidate repo roots: env override, compile-time manifest dir, cwd.
fn repo_root_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Ok(root) = std::env::var("VERBATIM_ROOT") {
        let root = root.trim();
        if !root.is_empty() {
            out.push(PathBuf::from(root));
        }
    }
    out.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."));
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.clone());
        if let Some(parent) = cwd.parent() {
            out.push(parent.to_path_buf());
        }
    }
    out
}

/// Bundled model shipped in the repo (Git LFS). No network or Hugging Face credentials.
pub fn bundled_model_path() -> Option<PathBuf> {
    for root in repo_root_candidates() {
        let path = root.join(MODEL_REL_PATH);
        if model_exists_at(&path) {
            return path.canonicalize().ok().or(Some(path));
        }
    }
    None
}

/// Resolve GGUF path: explicit → app data → repo bundle → legacy dir.
pub fn resolve_model_path(app: &AppHandle, cfg: &AppConfig) -> String {
    if !cfg.asr_model_path.is_empty() {
        return cfg.asr_model_path.clone();
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(d) = app.path().app_data_dir() {
        candidates.push(d.join("models").join(MODEL_FILE));
    }
    if let Some(bundled) = bundled_model_path() {
        candidates.push(bundled);
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(
            PathBuf::from(home)
                .join("Library/Application Support/co.saaslabs.verbatim.widget/models")
                .join(MODEL_FILE),
        );
        candidates.push(
            PathBuf::from(home)
                .join("Library/Application Support/verbatim/models")
                .join(MODEL_FILE),
        );
    }

    for path in &candidates {
        if path.is_file() {
            return path.to_string_lossy().into();
        }
    }

    candidates
        .first()
        .map(|p| p.to_string_lossy().into())
        .unwrap_or_else(|| MODEL_REL_PATH.into())
}

pub fn model_is_ready(app: &AppHandle, cfg: &AppConfig) -> bool {
    if !cfg.asr_model_path.is_empty() {
        return model_exists_at(Path::new(&cfg.asr_model_path));
    }
    if let Ok(dest) = default_model_dest(app) {
        if model_exists_at(&dest) {
            return true;
        }
    }
    if bundled_model_path().is_some() {
        return true;
    }
    model_exists_at(Path::new(&resolve_model_path(app, cfg)))
}

fn copy_file_with_progress(
    src: &Path,
    dest: &Path,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let total = std::fs::metadata(src)
        .map_err(|e| format!("stat {}: {e}", src.display()))?
        .len();
    let mut reader =
        std::fs::File::open(src).map_err(|e| format!("open {}: {e}", src.display()))?;
    let tmp = dest.with_extension("part");
    let mut writer =
        std::fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;

    let mut buf = [0u8; 1024 * 1024];
    let mut done: u64 = 0;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("read {}: {e}", src.display()))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        done += n as u64;
        on_progress(done, total);
    }
    writer.sync_all().ok();
    std::fs::rename(&tmp, dest).map_err(|e| format!("rename into {}: {e}", dest.display()))?;
    on_progress(done, total);
    Ok(())
}

/// Ensure the model is available: use app-data copy, repo bundle, or copy bundle → app data.
pub fn ensure_model_downloaded(app: &AppHandle, cfg: &AppConfig) -> Result<PathBuf, String> {
    if !cfg.asr_model_path.is_empty() {
        let custom = PathBuf::from(&cfg.asr_model_path);
        if model_exists_at(&custom) {
            mark_ready(app, &custom);
            return Ok(custom);
        }
        return Err(format!(
            "Custom ASR model not found at {}",
            custom.display()
        ));
    }

    let dest = default_model_dest(app)?;
    if model_exists_at(&dest) {
        mark_ready(app, &dest);
        return Ok(dest);
    }

    let bundled = bundled_model_path().ok_or_else(|| {
        "Bundled Nemotron model not found. From the repo root run: git lfs install && git lfs pull"
            .to_string()
    })?;

    // Use the repo copy directly when auto-install is off (no duplicate on disk).
    if !cfg.asr_auto_download_model {
        mark_ready(app, &bundled);
        return Ok(bundled);
    }

    if INSTALL_BUSY.swap(true, Ordering::SeqCst) {
        return Err("Model install already in progress".into());
    }

    let model_path = dest.to_string_lossy().into();
    let install_result = (|| {
        set_status(|s| {
            s.state = "downloading".into();
            s.progress = 0.0;
            s.bytes_downloaded = 0;
            s.bytes_total = None;
            s.model_path = model_path.clone();
            s.error = None;
        });
        emit_progress(app, &download_status_snapshot());

        eprintln!("[asr] installing bundled model into app data …");
        let app_for_progress = app.clone();
        copy_file_with_progress(&bundled, &dest, |done, total| {
            let progress = if total > 0 {
                (done as f64 / total as f64) * 100.0
            } else {
                0.0
            };
            set_status(|s| {
                s.state = "downloading".into();
                s.progress = progress;
                s.bytes_downloaded = done;
                s.bytes_total = Some(total);
                s.model_path = model_path.clone();
            });
            emit_progress(&app_for_progress, &download_status_snapshot());
        })?;

        eprintln!("[asr] model installed at {}", dest.display());
        mark_ready(app, &dest);
        Ok(dest)
    })();

    INSTALL_BUSY.store(false, Ordering::SeqCst);
    install_result
}
