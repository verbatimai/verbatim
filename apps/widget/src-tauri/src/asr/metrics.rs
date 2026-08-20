//! ASR performance metrics — collected for profiling and optimization baselines.

use serde::Serialize;
use std::sync::Mutex;
use std::time::Instant;

/// Internal performance metrics structure (required instrumentation).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrMetrics {
    // Model lifecycle
    pub model_load_ms: Option<u64>,
    pub model_peak_memory_mb: Option<f64>,
    pub model_steady_memory_mb: Option<f64>,

    // Process memory
    pub idle_process_memory_mb: Option<f64>,
    pub active_process_memory_mb: Option<f64>,
    pub peak_process_memory_mb: Option<f64>,

    // Streaming inference
    pub audio_chunk_duration_ms: Option<f64>,
    pub chunk_inference_ms: Option<f64>,
    pub real_time_factor: Option<f64>,

    // End-to-end latency
    pub first_partial_latency_ms: Option<u64>,
    pub finalization_latency_ms: Option<u64>,

    // Utilization (best-effort on macOS)
    pub cpu_utilization: Option<f64>,
    pub gpu_utilization: Option<f64>,

    // Queue health
    pub dropped_audio_chunks: u64,
    pub audio_queue_depth: u64,

    // Transcript churn
    pub number_of_partial_updates: u64,

    // Runtime identity (logged at startup)
    pub backend: String,
    pub device: String,
    pub metal_available: bool,
    pub model_type: String,
    pub quantization: String,
    pub streaming_ms: u32,
    pub model_path: String,
    pub linked: bool,
}

pub struct MetricsCollector {
    inner: Mutex<AsrMetrics>,
    load_start: Mutex<Option<Instant>>,
    session_start: Mutex<Option<Instant>>,
    first_audio_at: Mutex<Option<Instant>>,
    first_partial_recorded: Mutex<bool>,
    peak_process_mb: Mutex<f64>,
    chunk_audio_ms_sum: Mutex<f64>,
    chunk_infer_ms_sum: Mutex<f64>,
    chunk_count: Mutex<u64>,
}

impl MetricsCollector {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(AsrMetrics::default()),
            load_start: Mutex::new(None),
            session_start: Mutex::new(None),
            first_audio_at: Mutex::new(None),
            first_partial_recorded: Mutex::new(false),
            peak_process_mb: Mutex::new(0.0),
            chunk_audio_ms_sum: Mutex::new(0.0),
            chunk_infer_ms_sum: Mutex::new(0.0),
            chunk_count: Mutex::new(0),
        }
    }

    pub fn snapshot(&self) -> AsrMetrics {
        self.inner.lock().unwrap().clone()
    }

    pub fn set_runtime_info(
        &self,
        backend: &str,
        device: &str,
        metal_available: bool,
        model_type: &str,
        quantization: &str,
        streaming_ms: u32,
        model_path: &str,
        linked: bool,
    ) {
        let mut m = self.inner.lock().unwrap();
        m.backend = backend.into();
        m.device = device.into();
        m.metal_available = metal_available;
        m.model_type = model_type.into();
        m.quantization = quantization.into();
        m.streaming_ms = streaming_ms;
        m.model_path = model_path.into();
        m.linked = linked;
    }

    pub fn begin_model_load(&self) {
        *self.load_start.lock().unwrap() = Some(Instant::now());
    }

    pub fn end_model_load(&self, peak_mb: f64, steady_mb: f64) {
        if let Some(t0) = self.load_start.lock().unwrap().take() {
            let mut m = self.inner.lock().unwrap();
            m.model_load_ms = Some(t0.elapsed().as_millis() as u64);
            m.model_peak_memory_mb = Some(peak_mb);
            m.model_steady_memory_mb = Some(steady_mb);
            m.idle_process_memory_mb = Some(steady_mb);
        }
    }

    pub fn begin_session(&self) {
        *self.session_start.lock().unwrap() = Some(Instant::now());
        *self.first_audio_at.lock().unwrap() = None;
        *self.first_partial_recorded.lock().unwrap() = false;
        if let Ok(mb) = super::memory::resident_mb() {
            self.inner.lock().unwrap().active_process_memory_mb = Some(mb);
            let mut peak = self.peak_process_mb.lock().unwrap();
            if mb > *peak {
                *peak = mb;
                self.inner.lock().unwrap().peak_process_memory_mb = Some(mb);
            }
        }
    }

    pub fn note_audio_chunk(&self, duration_ms: f64) {
        if self.first_audio_at.lock().unwrap().is_none() {
            *self.first_audio_at.lock().unwrap() = Some(Instant::now());
        }
        *self.chunk_audio_ms_sum.lock().unwrap() += duration_ms;
    }

    pub fn note_inference(&self, infer_ms: f64, audio_ms: f64) {
        *self.chunk_infer_ms_sum.lock().unwrap() += infer_ms;
        *self.chunk_count.lock().unwrap() += 1;
        let mut m = self.inner.lock().unwrap();
        m.chunk_inference_ms = Some(infer_ms);
        m.audio_chunk_duration_ms = Some(audio_ms);
        if audio_ms > 0.0 {
            m.real_time_factor = Some(infer_ms / audio_ms);
        }
        let total_audio = *self.chunk_audio_ms_sum.lock().unwrap();
        let total_infer = *self.chunk_infer_ms_sum.lock().unwrap();
        if total_audio > 0.0 {
            m.real_time_factor = Some(total_infer / total_audio);
        }
    }

    pub fn note_partial(&self) {
        let mut m = self.inner.lock().unwrap();
        m.number_of_partial_updates += 1;
        if !*self.first_partial_recorded.lock().unwrap() {
            *self.first_partial_recorded.lock().unwrap() = true;
            if let (Some(t0), Some(audio_t)) = (
                *self.session_start.lock().unwrap(),
                *self.first_audio_at.lock().unwrap(),
            ) {
                // End-to-end: first audio captured → visible partial
                let e2e = audio_t.elapsed().as_millis().max(t0.elapsed().as_millis());
                m.first_partial_latency_ms = Some(e2e as u64);
            }
        }
    }

    pub fn note_finalize(&self, ms: u64) {
        self.inner.lock().unwrap().finalization_latency_ms = Some(ms);
    }

    pub fn set_queue_depth(&self, depth: u64) {
        self.inner.lock().unwrap().audio_queue_depth = depth;
    }

    pub fn inc_dropped(&self) {
        self.inner.lock().unwrap().dropped_audio_chunks += 1;
    }

    pub fn update_process_memory(&self) {
        if let Ok(mb) = super::memory::resident_mb() {
            let mut m = self.inner.lock().unwrap();
            m.active_process_memory_mb = Some(mb);
            let mut peak = self.peak_process_mb.lock().unwrap();
            if mb > *peak {
                *peak = mb;
                m.peak_process_memory_mb = Some(mb);
            }
        }
    }

    pub fn log_startup(&self) {
        let m = self.snapshot();
        eprintln!(
            "[asr] backend={} device={} metal={} model={} quant={} stream={}ms linked={} path={}",
            m.backend,
            m.device,
            m.metal_available,
            m.model_type,
            m.quantization,
            m.streaming_ms,
            m.linked,
            m.model_path
        );
        if let Some(load) = m.model_load_ms {
            eprintln!(
                "[asr] model_load_ms={load} peak_mb={:?} steady_mb={:?}",
                m.model_peak_memory_mb, m.model_steady_memory_mb
            );
        }
    }
}

impl Default for MetricsCollector {
    fn default() -> Self {
        Self::new()
    }
}
