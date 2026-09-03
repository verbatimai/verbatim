//! Shared blocking HTTP downloads (rustls via `ureq`).
//! Used by wake-word model fetch and Nemotron ASR model fetch.

use std::io::{Read, Write};
use std::path::Path;

/// Blocking download to a `.part` temp file then atomic rename.
pub fn download_file(url: &str, dest: &Path) -> Result<(), String> {
    download_file_with_progress(url, dest, |_, _| {})
}

/// Like [`download_file`], but reports `(bytes_done, content_length)` as chunks arrive.
pub fn download_file_with_progress(
    url: &str,
    dest: &Path,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<(), String> {
    let resp = ureq::get(url).call().map_err(|e| format!("GET {url}: {e}"))?;
    let total = resp
        .header("Content-Length")
        .and_then(|s| s.parse::<u64>().ok());

    let tmp = dest.with_extension("part");
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }

    let mut reader = resp.into_reader();
    let mut file =
        std::fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;

    let mut buf = [0u8; 64 * 1024];
    let mut done: u64 = 0;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("read {url}: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        done += n as u64;
        on_progress(done, total);
    }

    file.sync_all().ok();
    std::fs::rename(&tmp, dest).map_err(|e| format!("rename into {}: {e}", dest.display()))?;
    on_progress(done, total);
    Ok(())
}
