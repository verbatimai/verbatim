//! Phase 4.8: the app owns the backend (sidecar).
//!
//! Rust spawns and supervises the Node backend, injecting the vendor API keys from the
//! secret store into its ENV — so the secret never travels through the webview, and there's
//! no manual `npm run backend`. The webview only streams mic PCM + provider/language over
//! loopback. All present keys are injected so switching vendors needs no restart; adding a
//! NEW key (`keys::set_key` / `keys::key_save_clipboard`) triggers a restart.
//! See docs/product/m4.8-sidecar-plan.md.

use std::sync::Mutex;

static BACKEND: Mutex<Option<std::process::Child>> = Mutex::new(None);

const VENDOR_KEYS: [&str; 4] = [
    "PYAI_API_KEY",
    "DEEPGRAM_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
];

/// Inject the backend sidecar's env: loopback host/port, the verbose-log flag when Debug
/// is on (Settings §1.4 — the sidecar gates on HEAR_DEBUG==="1"), and every present vendor
/// key from the storage adapter (Settings §1.6 — local file or keychain). Secret VALUES are
/// never logged here.
fn inject_keys(app: &tauri::AppHandle, cmd: &mut std::process::Command) {
    cmd.env("HOST", "127.0.0.1").env("PORT", "8787");
    if crate::config::read_config(app).debug {
        cmd.env("HEAR_DEBUG", "1");
    }
    for k in VENDOR_KEYS {
        if let Some(secret) = crate::secrets::secret_get(app, k) {
            cmd.env(k, secret);
        }
    }
    // Release only: a Finder-launched .app inherits cwd "/", so the sidecar's default
    // LOG_FILE (resolve(cwd, "logs", "errors.log")) becomes an unwritable "/logs/errors.log".
    // The write is swallowed by a try/catch, so nothing crashes — but every error banner
    // would cite a path that was never written. Point it at the app's own log dir instead.
    #[cfg(not(debug_assertions))]
    {
        use tauri::Manager;
        if let Ok(dir) = app.path().app_log_dir() {
            let _ = std::fs::create_dir_all(&dir);
            cmd.env("PYAI_LOG_FILE", dir.join("errors.log"));
        }
    }
}

pub fn spawn_backend(app: &tauri::AppHandle) {
    kill_backend();
    #[cfg(debug_assertions)]
    kill_processes_on_port(8787);

    #[cfg(debug_assertions)]
    let spawned: Result<std::process::Child, String> = {
        // Dev: run the workspace backend via npm from the repo root
        // (…/apps/widget/src-tauri → up 3 = repo root).
        match std::path::Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(3) {
            Some(root) => {
                let mut cmd = std::process::Command::new("npm");
                cmd.args(["run", "start", "--workspace", "@verbatim/backend"])
                    .current_dir(root);
                inject_keys(app, &mut cmd);
                cmd.spawn().map_err(|e| e.to_string())
            }
            None => Err("can't locate repo root".to_string()),
        }
    };
    #[cfg(not(debug_assertions))]
    let spawned: Result<std::process::Child, String> = {
        // Release: spawn the bundled sidecar (externalBin), which Tauri places next to the
        // app executable with the target-triple stripped. Keys injected from the store.
        match std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|d| d.join("verbatim-backend")))
        {
            Some(bin) => {
                let mut cmd = std::process::Command::new(bin);
                inject_keys(app, &mut cmd);
                cmd.spawn().map_err(|e| e.to_string())
            }
            None => Err("can't locate app dir for sidecar".to_string()),
        }
    };
    match spawned {
        Ok(child) => {
            *BACKEND.lock().unwrap() = Some(child);
            println!("[backend] spawned + keyed from local secret store");
        }
        Err(e) => eprintln!("[backend] spawn failed: {e}"),
    }
}

pub fn kill_backend() {
    if let Some(mut c) = BACKEND.lock().unwrap().take() {
        let _ = c.kill();
    }
}

pub fn restart_backend(app: &tauri::AppHandle) {
    kill_backend();
    spawn_backend(app);
}

/// Dev-only: orphaned backend sidecars often keep :8787 after `tauri dev` reloads.
#[cfg(debug_assertions)]
fn kill_processes_on_port(port: u16) {
    let Ok(out) = std::process::Command::new("lsof")
        .args(["-ti", &format!(":{port}")])
        .output()
    else {
        return;
    };
    let pids = String::from_utf8_lossy(&out.stdout);
    for line in pids.lines() {
        let pid = line.trim();
        if pid.is_empty() {
            continue;
        }
        if let Ok(n) = pid.parse::<i32>() {
            if n == std::process::id() as i32 {
                continue;
            }
            let _ = std::process::Command::new("kill")
                .args(["-TERM", pid])
                .status();
            eprintln!("[backend] cleared stale process on :{port} (pid {pid})");
        }
    }
}
