//! Local TCP IPC server for the Node nemotron.stt.ts provider.

use super::metrics::MetricsCollector;
use super::worker::{AsrWorker, IpcEvent, TranscriptUpdate};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread;

const IPC_HOST: &str = "127.0.0.1";
const IPC_PORT: u16 = 8788;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum IpcIn {
    Ping,
    SessionStart {
        language: Option<String>,
    },
    SessionStop,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum IpcOut {
    Pong {
        ready: bool,
        port: u16,
        linked: bool,
    },
    Ready,
    Live {
        transcript: String,
        active: String,
    },
    Transcript {
        event: TranscriptUpdate,
    },
    Final {
        text: String,
    },
    Error {
        message: String,
    },
    Metrics {
        data: super::metrics::AsrMetrics,
    },
}

pub fn spawn_ipc_server(_app: tauri::AppHandle, worker: Arc<AsrWorker>, metrics: Arc<MetricsCollector>) {
    thread::Builder::new()
        .name("verbatim-asr-ipc".into())
        .spawn(move || {
            let listener = match TcpListener::bind(format!("{IPC_HOST}:{IPC_PORT}")) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[asr-ipc] bind failed: {e}");
                    return;
                }
            };
            eprintln!("[asr-ipc] listening on {IPC_HOST}:{IPC_PORT}");
            for stream in listener.incoming().flatten() {
                let worker = worker.clone();
                let metrics = metrics.clone();
                thread::spawn(move || handle_client(worker, metrics, stream));
            }
        })
        .expect("spawn ipc server");
}

fn handle_client(worker: Arc<AsrWorker>, metrics: Arc<MetricsCollector>, mut stream: TcpStream) {
    let _ = stream.set_nonblocking(true);
    let (event_tx, event_rx) = mpsc::channel::<IpcEvent>();

    let mut buf = vec![0u8; 4096];
    let mut acc = Vec::new();
    let mut session_active = false;

    loop {
        while let Ok(ev) = event_rx.try_recv() {
            let out = match ev {
                IpcEvent::Live { transcript, active } => IpcOut::Live { transcript, active },
                IpcEvent::Transcript(event) => IpcOut::Transcript { event },
            };
            if write_json(&mut stream, &out).is_err() {
                worker.set_event_sink(None);
                return;
            }
        }

        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => acc.extend_from_slice(&buf[..n]),
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(std::time::Duration::from_millis(5));
            }
            Err(_) => break,
        }

        while let Some(frame) = take_frame(&mut acc) {
            match frame {
                Frame::Json(line) => {
                    let msg: IpcIn = match serde_json::from_str(&line) {
                        Ok(m) => m,
                        Err(e) => {
                            let _ = write_json(&mut stream, &IpcOut::Error { message: e.to_string() });
                            continue;
                        }
                    };
                    match msg {
                        IpcIn::Ping => {
                            let _ = write_json(
                                &mut stream,
                                &IpcOut::Pong {
                                    ready: true,
                                    port: IPC_PORT,
                                    linked: super::ffi::is_linked(),
                                },
                            );
                        }
                        IpcIn::SessionStart { language } => {
                            worker.set_event_sink(Some(event_tx.clone()));
                            let lang = language.unwrap_or_else(|| "en".into());
                            match worker.start_session(&lang) {
                                Ok(()) => {
                                    session_active = true;
                                    let _ = write_json(&mut stream, &IpcOut::Ready);
                                }
                                Err(e) => {
                                    worker.set_event_sink(None);
                                    let _ = write_json(&mut stream, &IpcOut::Error { message: e });
                                }
                            }
                        }
                        IpcIn::SessionStop => {
                            match worker.stop_session() {
                                Ok(text) => {
                                    session_active = false;
                                    let _ = write_json(&mut stream, &IpcOut::Final { text });
                                }
                                Err(e) => {
                                    let _ = write_json(&mut stream, &IpcOut::Error { message: e });
                                }
                            }
                            worker.set_event_sink(None);
                            let _ = write_json(
                                &mut stream,
                                &IpcOut::Metrics {
                                    data: metrics.snapshot(),
                                },
                            );
                        }
                    }
                }
                Frame::Binary(pcm) if session_active => {
                    let samples: Vec<i16> = pcm
                        .chunks_exact(2)
                        .map(|c| i16::from_le_bytes([c[0], c[1]]))
                        .collect();
                    if let Err(e) = worker.push_pcm(samples) {
                        let _ = write_json(&mut stream, &IpcOut::Error { message: e });
                    }
                }
                Frame::Binary(_) => {}
            }
        }
    }
    worker.set_event_sink(None);
}

enum Frame {
    Json(String),
    Binary(Vec<u8>),
}

fn take_frame(acc: &mut Vec<u8>) -> Option<Frame> {
    if acc.is_empty() {
        return None;
    }
    if acc[0] == b'{' {
        if let Some(i) = acc.iter().position(|&b| b == b'\n') {
            let line = String::from_utf8_lossy(&acc[..i]).to_string();
            acc.drain(..=i);
            return Some(Frame::Json(line));
        }
        return None;
    }
    if acc.len() >= 4 {
        let len = u32::from_le_bytes([acc[0], acc[1], acc[2], acc[3]]) as usize;
        if acc.len() >= 4 + len {
            let data = acc[4..4 + len].to_vec();
            acc.drain(..4 + len);
            return Some(Frame::Binary(data));
        }
    }
    None
}

fn write_json(stream: &mut TcpStream, msg: &IpcOut) -> std::io::Result<()> {
    let line = serde_json::to_string(msg).unwrap_or_else(|_| "{}".into());
    stream.write_all(line.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()
}

pub fn ipc_port() -> u16 {
    IPC_PORT
}

pub fn install_event_bridge(_app: &tauri::AppHandle) {}
