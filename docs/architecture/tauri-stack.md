# Tauri widget stack: hotkey, overlay, keychain, audio, WS (M3/M4 research)

Build sheet for a floating, non-activating dictation widget in Tauri v2 (macOS-first).

## 1. Global hotkey — `tauri-plugin-global-shortcut`
- Register in Rust `setup` with `.with_handler(...)` so it fires even when the webview isn't focused; `Pressed`/`Released` states enable push-to-talk.
- Capabilities: `global-shortcut:allow-register|allow-unregister|allow-is-registered`.
- **Limitation (important):** cannot bind a bare modifier or the **`fn`** key as a hold trigger — accelerators need a real `Code`. macOS-style `fn` push-to-talk requires a **native `CGEventTap`/`NSEvent` global monitor**, not this plugin. Debounce `Pressed` yourself.

## 2. Non-activating overlay
- Native Tauri config: `alwaysOnTop`, `decorations:false`, `transparent:true` (also set `app.macOSPrivateApi:true`), `focus:false`, `skipTaskbar:true`, `visibleOnAllWorkspaces:true`, `shadow:false`, `resizable:false`.
- `focus:false` only means "don't focus on show" — a plain NSWindow still activates the app on click and steals the caret. **Use `tauri-nspanel`** to reclass to a non-activating `NSPanel` (`NONACTIVATING_PANEL`, `can_become_key_window:false`, `PanelLevel::Floating`, joins all Spaces + full-screen). macOS-only; `#[cfg]` per-OS elsewhere.
- Caret positioning: no Tauri API for the OS caret — use AX (`AXBoundsForRange`/focused element bounds, permission-gated) or fall back to mouse location; convert Cocoa bottom-left origin → Tauri top-left via `current_monitor()` + `scale_factor()`.

## 3. Key storage (BYOK)
- **Recommended: `keyring` crate** (OS keychain). One `service` (`com.you.dictation`), one `account` per vendor. Features: `apple-native` / `windows-native` / `sync-secret-service`. Real OS-backed, no master password. Linux needs a Secret Service daemon.
- Alternative: `tauri-plugin-stronghold` (Argon2-encrypted vault) — portable, but you must supply/derive the vault password (friction, or store it in keyring anyway). Never use localStorage/plain config/bundled resources.

## 4. Mic capture → 16 kHz mono PCM s16le
- **Recommended: `cpal` in Rust** (lowest latency, no IPC on the hot path). Handle both f32 and i16 input callbacks (device-dependent). Downmix to mono (average channels). Resample native (44.1/48k) → 16k with **`rubato`** (quality) or a simple linear resampler. Convert f32→i16 LE. Frame to ~20–100 ms (3200 bytes = 100 ms @16k). Push frames via `tokio::sync::mpsc`; keep the audio callback non-blocking.
- Alternative: webview `getUserMedia` + `AudioWorklet` (browser handles AEC/permissions) → send PCM to Rust via the binary-friendly **`tauri::ipc::Channel`** (not `emit`). Prefer cpal for real-time.

## 5. Stream to vendor STT WS (`tokio-tungstenite`)
- Build request via `IntoClientRequest`, insert `Authorization` header, `connect_async` (handles wss/TLS; enable `rustls-tls-webpki-roots` or `native-tls`). Send `Message::Binary(pcm)` frames; some vendors want base64 in `Message::Text`.
- Forward transcripts to the webview via the **`Emitter`** trait: `app.emit_to("overlay", "stt:transcript", payload)` with a `#[serde(rename_all="camelCase")]` struct. Transcript events are low-rate → `emit` is fine; use `Channel` for high-rate streams. Handle Ping/Pong keepalive; close with `Message::Close` on hotkey-release to flush the final.

## Assembled deps
`tauri` v2, `tauri-plugin-global-shortcut`, `tauri-nspanel` (macOS), `keyring`, optional `tauri-plugin-stronghold`; `cpal`, `rubato`, `tokio`, `tokio-tungstenite`, `futures-util`, `serde`; native `core-graphics`/`objc2` for the `fn` event tap + NSPanel tweaks.

**Top risks:** (1) `fn`/push-to-talk needs a native event tap; (2) true non-activation needs `tauri-nspanel`; (3) caret positioning needs AX (permission) + mouse fallback; (4) keep the cpal callback lock-free.

Sources: Tauri v2 global-shortcut & config & calling-frontend docs; Stronghold plugin; keyring/cpal/tokio-tungstenite docs.rs; ahkohd/tauri-nspanel.
