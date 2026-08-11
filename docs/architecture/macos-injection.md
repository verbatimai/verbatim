# macOS text injection & non-activating widget (M3 research)

How a Wispr-style widget injects into the focused field and floats without stealing focus.

## 1. Capture the focused element (Accessibility API)
- `AXUIElementCreateSystemWide()` → `AXUIElementCopyAttributeValue(sw, kAXFocusedUIElementAttribute)` = the focused control in the frontmost app.
- Read/write attrs: `kAXValueAttribute` (whole text), `kAXSelectedTextAttribute` (write = replace selection / insert at caret), `kAXSelectedTextRangeAttribute` (CFRange in an AXValue; zero-length = caret), `kAXRoleAttribute` (detect `AXSecureTextField`).
- Writes are **advisory** — read back to confirm they took.

## 2. Permission (runtime TCC, not an entitlement)
- **System Settings → Privacy & Security → Accessibility.** Check: `AXIsProcessTrusted()`; prompt+deep-link: `AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: true})`.
- No programmatic grant. App must be a signed `.app` with stable identity (ad-hoc/unsigned dev builds re-prompt). Assume relaunch needed to pick up the grant. Same grant covers CGEvent posting; Screen Recording is NOT needed.

## 3. Injection: AX-first, paste-fallback
- **(a) AX insert:** read `kAXSelectedTextRangeAttribute`, set `kAXSelectedTextAttribute` = text. Clean, no clipboard churn, preserves undo. Fails on Electron/Chromium web fields, Java/Swing, some Qt, terminals (no settable AXValue).
- **(b) Synthetic paste:** snapshot `NSPasteboard.general` (all types + changeCount) → set string → post ⌘V via `CGEventCreateKeyboardEvent` (vk `0x09`='v', flags `.maskCommand`, `.post(.cghidEventTap)`) → restore pasteboard after ~120 ms. Works almost everywhere ⌘V works; races the clipboard; fires paste side effects.
- **Secure/password fields:** `EnableSecureEventInput` blocks synthetic keys AND AX hides the value → **cannot and must not inject.** Detect `AXSecureTextField` and no-op/warn.
- **Recommended:** try AX; if not settable or read-back unchanged, fall back to paste. (This is what Wispr/Espanso-style tools do.)

## 4. Non-activating widget
- Native: `NSPanel` with `.nonactivatingPanel` style mask, override `canBecomeKey → false` / `canBecomeMain → false`, `level = .floating`, `collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]`. App as `LSUIElement`/`.accessory` (no Dock icon, never frontmost).
- **Tauri:** `focusable:false` + `alwaysOnTop` + `decorations:false` + `transparent` is **not enough** for true non-activation (tao makes an NSWindow, not NSPanel). Use **`tauri-nspanel`** (or `ns_window()` + native reclass) to get the NSPanel behavior. `#[cfg(macos)]` this; Windows uses `WS_EX_NOACTIVATE` + `WM_MOUSEACTIVATE`→`MA_NOACTIVATE`.

## 5. Rust crates / references
- `accessibility-sys` (raw AX FFI), `accessibility` (wrapper), `core-foundation` (CFString/CFRange/AXValue), `core-graphics` (CGEvent for ⌘V), `objc2`+`objc2-app-kit` (NSPasteboard, NSPanel). `enigo` for cross-platform key simulation. Study **Hammerspoon** (`hs.axuielement`, `hs.eventtap`) and **Espanso** for the AX-then-paste pattern. macOS-only: `tauri-nspanel`.

## 6. Windows (later)
- Focused element via UI Automation (`IUIAutomation::GetFocusedElement`); insert via `ValuePattern::SetValue` (TextPattern caret is mostly read-only → paste more common); `SendInput` (Ctrl+V or `KEYEVENTF_UNICODE`). Non-activating: `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST`. UIPI blocks injecting into elevated targets unless app manifest has `uiAccess=true`.

Sources: Apple AXUIElement.h; Hammerspoon hs.axuielement; Apple CGEvent; accessibility-sys/enigo docs.rs; Tauri v2 config; Electron BrowserWindow; MS Learn UIA.
