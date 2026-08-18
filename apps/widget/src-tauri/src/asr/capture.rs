//! cpal audio capture for native dictation (16 kHz mono PCM s16le).
//!
//! Runs on a dedicated thread; the callback only enqueues samples — never inference.

use super::worker::AsrWorker;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

const SAMPLE_RATE: u32 = 16_000;

pub struct DictationCapture {
    stop: Arc<AtomicBool>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl DictationCapture {
    pub fn new() -> Self {
        Self {
            stop: Arc::new(AtomicBool::new(true)),
            handle: Mutex::new(None),
        }
    }

    pub fn is_running(&self) -> bool {
        !self.stop.load(Ordering::SeqCst)
    }

    pub fn start(&self, worker: Arc<AsrWorker>, device_name: Option<String>) -> Result<(), String> {
        self.stop.store(false, Ordering::SeqCst);
        let stop = self.stop.clone();
        let handle = thread::Builder::new()
            .name("verbatim-asr-capture".into())
            .spawn(move || capture_loop(worker, device_name, stop))
            .map_err(|e| e.to_string())?;
        *self.handle.lock().unwrap() = Some(handle);
        Ok(())
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.lock().unwrap().take() {
            let _ = h.join();
        }
    }
}

impl Default for DictationCapture {
    fn default() -> Self {
        Self::new()
    }
}

fn capture_loop(worker: Arc<AsrWorker>, device_name: Option<String>, stop: Arc<AtomicBool>) {
    let host = cpal::default_host();
    let device = select_device(&host, device_name.as_deref());
    let device = match device {
        Some(d) => d,
        None => {
            eprintln!("[asr-capture] no input device");
            return;
        }
    };

    let config = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[asr-capture] default_input_config: {e}");
            return;
        }
    };

    let sample_rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let err_fn = |e| eprintln!("[asr-capture] stream error: {e}");
    let stop_f32 = stop.clone();
    let stop_i16 = stop.clone();

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            move |data: &[f32], _| {
                if stop_f32.load(Ordering::Relaxed) {
                    return;
                }
                let mono: Vec<f32> = if channels == 1 {
                    data.to_vec()
                } else {
                    data.chunks(channels).map(|c| c[0]).collect()
                };
                let pcm = resample_to_i16(&mono, sample_rate);
                let _ = worker.push_pcm(pcm);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.into(),
            move |data: &[i16], _| {
                if stop_i16.load(Ordering::Relaxed) {
                    return;
                }
                let mono: Vec<i16> = if channels == 1 {
                    data.to_vec()
                } else {
                    data.chunks(channels).map(|c| c[0]).collect()
                };
                let f32: Vec<f32> = mono.iter().map(|s| *s as f32 / 32768.0).collect();
                let pcm = resample_to_i16(&f32, sample_rate);
                let _ = worker.push_pcm(pcm);
            },
            err_fn,
            None,
        ),
        _ => {
            eprintln!("[asr-capture] unsupported sample format");
            return;
        }
    };

    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[asr-capture] build_input_stream: {e}");
            return;
        }
    };

    if let Err(e) = stream.play() {
        eprintln!("[asr-capture] play: {e}");
        return;
    }

    eprintln!("[asr-capture] started @ {} Hz", sample_rate);
    while !stop.load(Ordering::SeqCst) {
        thread::sleep(std::time::Duration::from_millis(20));
    }
    drop(stream);
    eprintln!("[asr-capture] stopped");
}

fn select_device(host: &cpal::Host, name: Option<&str>) -> Option<cpal::Device> {
    if let Some(n) = name.filter(|s| !s.is_empty()) {
        if let Ok(devs) = host.input_devices() {
            for d in devs {
                if d.name().ok().as_deref() == Some(n) {
                    return Some(d);
                }
            }
        }
    }
    host.default_input_device()
}

fn resample_to_i16(input: &[f32], src_rate: u32) -> Vec<i16> {
    if src_rate == SAMPLE_RATE {
        return input
            .iter()
            .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect();
    }
    let ratio = src_rate as f64 / SAMPLE_RATE as f64;
    let out_len = (input.len() as f64 / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let idx = i as f64 * ratio;
        let lo = idx.floor() as usize;
        let hi = (lo + 1).min(input.len().saturating_sub(1));
        let frac = (idx - lo as f64) as f32;
        let s = input[lo] + (input[hi] - input[lo]) * frac;
        out.push((s.clamp(-1.0, 1.0) * 32767.0) as i16);
    }
    out
}
