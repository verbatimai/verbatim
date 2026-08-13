//! macOS system integration: privacy-pane deep links, permission status, output muting.
//! Every command here is a no-op (or a benign default) off macOS.

/// Open System Settings to a specific Privacy pane so the user can grant access.
#[cfg(target_os = "macos")]
fn open_privacy_pane(anchor: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(format!("x-apple.systempreferences:com.apple.preference.security?{anchor}"))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_mic_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        open_privacy_pane("Privacy_Microphone")
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

#[tauri::command]
pub fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        open_privacy_pane("Privacy_Accessibility")
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

/// Is the app trusted for Accessibility? Powers the proactive permission indicator in
/// Settings (so the user isn't surprised by the first injection banner).
#[tauri::command]
pub fn ax_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        crate::axinject::is_trusted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

// Wave 4 — Input Monitoring (TCC kTCCServiceListenEvent) permission. Separate service from
// Accessibility; gates the session-level CGEventTap that Fn/PTT relies on. These mirror the
// ax_trusted / open_accessibility_settings pattern above.
#[tauri::command]
pub fn input_monitoring_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        crate::fnkey::input_monitoring_status()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
pub fn open_input_monitoring_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        open_privacy_pane("Privacy_ListenEvent")
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

/// Proactively prompt for / add Verbatim to the Input Monitoring list when PTT is first
/// enabled (friendlier than a silent tap-create failure).
#[tauri::command]
pub fn request_input_monitoring() {
    #[cfg(target_os = "macos")]
    {
        crate::fnkey::request_input_monitoring();
    }
}

// ── Mute other audio while dictating ──────────────────────────────────────────
// When enabled (config.muteOthers), the webview mutes the system output at the start
// of a dictation and restores the prior state on stop — so music/video doesn't bleed
// into the mic. We toggle the *muted* flag only (never the volume level), so unmuting
// returns to exactly the level the user had. macOS-only via AppleScript; no-op else.

/// Is the system audio OUTPUT currently muted? Read before muting so we can restore it.
#[tauri::command]
pub fn get_output_muted() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("osascript")
            .args(["-e", "output muted of (get volume settings)"])
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().eq_ignore_ascii_case("true"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub fn set_output_muted(muted: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let val = if muted { "true" } else { "false" };
        std::process::Command::new("osascript")
            .args(["-e", &format!("set volume output muted {val}")])
            .status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = muted;
        Ok(())
    }
}
