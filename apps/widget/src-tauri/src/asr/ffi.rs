//! FFI bindings to NeMo-Speech.cpp C ABI (nemo_speech/asr.h).

use std::ffi::CStr;
use std::path::Path;

pub const SAMPLE_RATE: i32 = 16_000;

pub fn streaming_preset_ms(ms: u32) -> (f32, i32) {
    match ms {
        160 => (0.16, 1),
        560 => (0.56, 6),
        1120 => (1.12, 13),
        _ => (0.56, 6),
    }
}

pub struct RuntimeInfo {
    pub backend: String,
    pub device: String,
    pub metal_available: bool,
    pub version: String,
}

#[derive(Debug)]
pub enum AsrError {
    NotLinked,
    InvalidPath(String),
    CreateFailed(String),
    StreamFailed(String),
    PushFailed(String),
    InferFailed(String),
}

impl std::fmt::Display for AsrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotLinked => write!(f, "NeMo-Speech.cpp not linked"),
            Self::InvalidPath(p) => write!(f, "invalid model path: {p}"),
            Self::CreateFailed(e) => write!(f, "create failed: {e}"),
            Self::StreamFailed(e) => write!(f, "stream failed: {e}"),
            Self::PushFailed(e) => write!(f, "push failed: {e}"),
            Self::InferFailed(e) => write!(f, "infer failed: {e}"),
        }
    }
}

impl std::error::Error for AsrError {}

pub fn is_linked() -> bool {
    cfg!(nemo_speech_linked)
}

pub fn detect_runtime(use_metal: bool) -> RuntimeInfo {
    RuntimeInfo {
        backend: if use_metal && cfg!(target_os = "macos") {
            "metal".into()
        } else {
            "cpu".into()
        },
        device: if use_metal && cfg!(target_os = "macos") {
            "Apple GPU (Metal)".into()
        } else {
            "CPU".into()
        },
        metal_available: cfg!(target_os = "macos") && use_metal && is_linked(),
        version: linked_version(),
    }
}

#[cfg(nemo_speech_linked)]
fn linked_version() -> String {
    unsafe { CStr::from_ptr(linked::nemo_speech_asr_version()).to_string_lossy().into() }
}

#[cfg(not(nemo_speech_linked))]
fn linked_version() -> String {
    "stub".into()
}

pub fn infer_quantization(model_path: &str) -> String {
    let name = Path::new(model_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if name.contains("q8") {
        "q8_0".into()
    } else if name.contains("f16") {
        "f16".into()
    } else {
        "unknown".into()
    }
}

#[cfg(nemo_speech_linked)]
mod linked {
    use super::*;
    use std::ffi::CString;
    use std::os::raw::{c_char, c_float, c_int, c_void};

    #[repr(C)]
    pub struct BackendConfig {
        pub size: usize,
        pub gpu: c_int,
    }

    #[repr(C)]
    pub struct ModelConfig {
        pub size: usize,
        pub path: *const c_char,
        pub name: *const c_char,
    }

    #[repr(C)]
    pub struct StreamingConfig {
        pub size: usize,
        pub chunk_size: c_float,
        pub ctc_left_padding: c_float,
        pub ctc_right_padding: c_float,
        pub rnnt_right_context: c_int,
    }

    #[repr(C)]
    pub struct VadConfig {
        pub size: usize,
        pub model_path: *const c_char,
        pub enable_masking: bool,
        pub onset: c_float,
        pub offset: c_float,
    }

    #[repr(C)]
    pub struct EndpointingConfig {
        pub size: usize,
        pub enable: bool,
        pub vad_based: bool,
        pub stop_history_eou_ms: c_int,
    }

    #[repr(C)]
    pub struct RecognizerConfig {
        pub size: usize,
        pub backend: *const BackendConfig,
        pub model: *const ModelConfig,
        pub streaming: *const StreamingConfig,
        pub decoder: *const c_void,
        pub vad: *const VadConfig,
        pub endpointing: *const EndpointingConfig,
        pub postproc: *const c_void,
        pub diar: *const c_void,
        pub batching: *const c_void,
    }

    #[repr(C)]
    pub struct RecognitionOptions {
        pub size: usize,
        pub request_id: *const c_char,
        pub language_code: *const c_char,
        pub interim_results: bool,
        pub enable_word_time_offsets: bool,
        pub enable_automatic_punctuation: bool,
        pub verbatim_transcripts: bool,
        pub profanity_filter: bool,
        pub stop_history_eou_ms: c_int,
        pub speech_contexts: *const c_void,
        pub speech_context_count: usize,
        pub max_alternatives: c_int,
        pub enable_speaker_diarization: bool,
        pub max_speaker_count: c_int,
    }

    pub type Recognizer = c_void;
    pub type Stream = c_void;
    pub type AsrResultHandle = c_void;

    const OK: c_int = 0;

    extern "C" {
        pub fn nemo_speech_asr_version() -> *const c_char;
        pub fn nemo_speech_asr_last_error() -> *const c_char;
        pub fn nemo_speech_asr_recognition_options_default() -> RecognitionOptions;
        pub fn nemo_speech_asr_create(cfg: *const RecognizerConfig, out: *mut *mut Recognizer) -> c_int;
        pub fn nemo_speech_asr_destroy(recognizer: *mut Recognizer);
        pub fn nemo_speech_asr_streaming_recognize(
            recognizer: *mut Recognizer,
            options: *const RecognitionOptions,
            out: *mut *mut Stream,
        ) -> c_int;
        pub fn nemo_speech_asr_stream_push_f32(
            stream: *mut Stream,
            samples: *const c_float,
            n_samples: usize,
            sample_rate: c_int,
        ) -> c_int;
        pub fn nemo_speech_asr_stream_finish(stream: *mut Stream) -> c_int;
        pub fn nemo_speech_asr_stream_force_endpoint(stream: *mut Stream) -> c_int;
        pub fn nemo_speech_asr_stream_next(stream: *mut Stream, out: *mut *mut AsrResultHandle) -> c_int;
        pub fn nemo_speech_asr_stream_close(stream: *mut Stream);
        pub fn nemo_speech_asr_result_is_final(result: *const AsrResultHandle) -> bool;
        pub fn nemo_speech_asr_result_transcript(result: *const AsrResultHandle, alt: usize) -> *const c_char;
        pub fn nemo_speech_asr_result_destroy(result: *mut AsrResultHandle);
        pub fn nemo_speech_asr_recognize_f32(
            recognizer: *mut Recognizer,
            options: *const RecognitionOptions,
            samples: *const c_float,
            n_samples: usize,
            sample_rate: c_int,
            out: *mut *mut AsrResultHandle,
        ) -> c_int;
    }

    fn last_error() -> String {
        unsafe { CStr::from_ptr(nemo_speech_asr_last_error()).to_string_lossy().into() }
    }

    pub struct RecognizerHandle {
        ptr: *mut Recognizer,
    }

    unsafe impl Send for RecognizerHandle {}
    unsafe impl Sync for RecognizerHandle {}

    impl RecognizerHandle {
        pub fn load(
            model_path: &str,
            streaming_ms: u32,
            use_metal: bool,
            vad_path: Option<&str>,
            vad_onset: f32,
            vad_offset: f32,
        ) -> Result<Self, AsrError> {
            if !Path::new(model_path).exists() {
                return Err(AsrError::InvalidPath(model_path.into()));
            }
            let c_path = CString::new(model_path).map_err(|e| AsrError::InvalidPath(e.to_string()))?;
            let (chunk_size, right_ctx) = streaming_preset_ms(streaming_ms);

            let backend = BackendConfig {
                size: std::mem::size_of::<BackendConfig>(),
                gpu: if use_metal { 0 } else { -1 },
            };
            let model = ModelConfig {
                size: std::mem::size_of::<ModelConfig>(),
                path: c_path.as_ptr(),
                name: std::ptr::null(),
            };
            let streaming = StreamingConfig {
                size: std::mem::size_of::<StreamingConfig>(),
                chunk_size,
                ctc_left_padding: 1.92,
                ctc_right_padding: 1.92,
                rnnt_right_context: right_ctx,
            };

            let vad_c = vad_path.and_then(|p| CString::new(p).ok());
            let vad = vad_path.map(|p| VadConfig {
                size: std::mem::size_of::<VadConfig>(),
                model_path: vad_c.as_ref().map(|c| c.as_ptr()).unwrap_or(p.as_ptr() as *const c_char),
                enable_masking: true,
                onset: vad_onset,
                offset: vad_offset,
            });
            let endpointing = EndpointingConfig {
                size: std::mem::size_of::<EndpointingConfig>(),
                enable: true,
                vad_based: vad_path.is_some(),
                stop_history_eou_ms: 800,
            };

            let cfg = RecognizerConfig {
                size: std::mem::size_of::<RecognizerConfig>(),
                backend: &backend,
                model: &model,
                streaming: &streaming,
                decoder: std::ptr::null(),
                vad: vad.as_ref().map(|v| v as *const VadConfig).unwrap_or(std::ptr::null()),
                endpointing: &endpointing,
                postproc: std::ptr::null(),
                diar: std::ptr::null(),
                batching: std::ptr::null(),
            };

            let mut out: *mut Recognizer = std::ptr::null_mut();
            let st = unsafe { nemo_speech_asr_create(&cfg, &mut out) };
            if st != OK || out.is_null() {
                return Err(AsrError::CreateFailed(last_error()));
            }
            Ok(Self { ptr: out })
        }

        pub fn start_stream(&self, language: &str) -> Result<StreamHandle, AsrError> {
            let mut opts = unsafe { nemo_speech_asr_recognition_options_default() };
            opts.interim_results = true;
            opts.enable_automatic_punctuation = true;
            let lang = CString::new(language).unwrap_or_default();
            opts.language_code = lang.as_ptr();

            let mut out: *mut Stream = std::ptr::null_mut();
            let st = unsafe { nemo_speech_asr_streaming_recognize(self.ptr, &opts, &mut out) };
            if st != OK || out.is_null() {
                return Err(AsrError::StreamFailed(last_error()));
            }
            Ok(StreamHandle { ptr: out })
        }

        pub fn transcribe_offline(&self, samples: &[f32], language: &str) -> Result<String, AsrError> {
            let mut opts = unsafe { nemo_speech_asr_recognition_options_default() };
            opts.enable_automatic_punctuation = true;
            let lang = CString::new(language).unwrap_or_default();
            opts.language_code = lang.as_ptr();

            let mut out: *mut AsrResultHandle = std::ptr::null_mut();
            let st = unsafe {
                nemo_speech_asr_recognize_f32(
                    self.ptr,
                    &opts,
                    samples.as_ptr(),
                    samples.len(),
                    SAMPLE_RATE,
                    &mut out,
                )
            };
            if st != OK || out.is_null() {
                return Err(AsrError::InferFailed(last_error()));
            }
            let text = unsafe {
                let t = nemo_speech_asr_result_transcript(out, 0);
                if t.is_null() {
                    String::new()
                } else {
                    CStr::from_ptr(t).to_string_lossy().into()
                }
            };
            unsafe { nemo_speech_asr_result_destroy(out) };
            Ok(text)
        }
    }

    impl Drop for RecognizerHandle {
        fn drop(&mut self) {
            if !self.ptr.is_null() {
                unsafe { nemo_speech_asr_destroy(self.ptr) };
            }
        }
    }

    pub struct StreamHandle {
        ptr: *mut Stream,
    }

    unsafe impl Send for StreamHandle {}

    impl StreamHandle {
        pub fn push_f32(&mut self, samples: &[f32]) -> Result<(), AsrError> {
            let st = unsafe {
                nemo_speech_asr_stream_push_f32(self.ptr, samples.as_ptr(), samples.len(), SAMPLE_RATE)
            };
            if st != OK {
                return Err(AsrError::PushFailed(last_error()));
            }
            Ok(())
        }

        pub fn finish(&mut self) -> Result<(), AsrError> {
            let st = unsafe { nemo_speech_asr_stream_finish(self.ptr) };
            if st != OK {
                return Err(AsrError::StreamFailed(last_error()));
            }
            Ok(())
        }

        pub fn next_result(&mut self) -> Result<Option<(String, bool)>, AsrError> {
            let mut out: *mut AsrResultHandle = std::ptr::null_mut();
            let st = unsafe { nemo_speech_asr_stream_next(self.ptr, &mut out) };
            if st != OK {
                return Err(AsrError::InferFailed(last_error()));
            }
            if out.is_null() {
                return Ok(None);
            }
            let (text, is_final) = unsafe {
                let t = nemo_speech_asr_result_transcript(out, 0);
                let text = if t.is_null() {
                    String::new()
                } else {
                    CStr::from_ptr(t).to_string_lossy().into()
                };
                (text, nemo_speech_asr_result_is_final(out))
            };
            unsafe { nemo_speech_asr_result_destroy(out) };
            Ok(Some((text, is_final)))
        }
    }

    impl Drop for StreamHandle {
        fn drop(&mut self) {
            if !self.ptr.is_null() {
                unsafe { nemo_speech_asr_stream_close(self.ptr) };
            }
        }
    }

    pub use RecognizerHandle as Engine;
    pub use StreamHandle as LiveStream;
}

#[cfg(nemo_speech_linked)]
pub use linked::{Engine, LiveStream};

#[cfg(nemo_speech_linked)]
pub fn load_engine(
    model_path: &str,
    streaming_ms: u32,
    use_metal: bool,
    vad_path: Option<&str>,
    vad_onset: f32,
    vad_offset: f32,
) -> Result<Engine, AsrError> {
    linked::RecognizerHandle::load(model_path, streaming_ms, use_metal, vad_path, vad_onset, vad_offset)
}

#[cfg(not(nemo_speech_linked))]
pub struct Engine;

#[cfg(not(nemo_speech_linked))]
pub struct LiveStream;

#[cfg(not(nemo_speech_linked))]
pub fn load_engine(
    model_path: &str,
    _streaming_ms: u32,
    _use_metal: bool,
    _vad_path: Option<&str>,
    _vad_onset: f32,
    _vad_offset: f32,
) -> Result<Engine, AsrError> {
    if !Path::new(model_path).exists() {
        return Err(AsrError::InvalidPath(model_path.into()));
    }
    Err(AsrError::NotLinked)
}

#[cfg(not(nemo_speech_linked))]
impl Engine {
    pub fn start_stream(&self, _language: &str) -> Result<LiveStream, AsrError> {
        Err(AsrError::NotLinked)
    }
    pub fn transcribe_offline(&self, _samples: &[f32], _language: &str) -> Result<String, AsrError> {
        Err(AsrError::NotLinked)
    }
}

#[cfg(not(nemo_speech_linked))]
impl LiveStream {
    pub fn push_f32(&mut self, _samples: &[f32]) -> Result<(), AsrError> {
        Err(AsrError::NotLinked)
    }
    pub fn finish(&mut self) -> Result<(), AsrError> {
        Err(AsrError::NotLinked)
    }
    pub fn next_result(&mut self) -> Result<Option<(String, bool)>, AsrError> {
        Err(AsrError::NotLinked)
    }
}
