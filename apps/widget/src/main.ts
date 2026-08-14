// Verbatim widget frontend (M3 Phase 3.1, redesigned as a pill/waveform + bubble — see
// docs/product/claude/widget-ui-redesign.md). Reuses the M2 experience: the transcript
// streams as ONE clean growing line (locked text + volatile tail); on Stop the backend
// batch-transcribes, runs cleanup (the "what was removed" diff) and formatting, and
// returns the final text.
//
// Widget-specific seam: when the `formatted` message arrives, we hand the text to
// the Rust `inject_text` command, which pastes it into whatever field is focused in
// the app underneath (the panel is non-activating + non-key, so focus never left it).
//
// UI shape: no titlebar (Settings/Quit/Show-Last-Result live on the menu-bar tray) and
// no separate "final output" box (Copy lives in the bubble; the clean text is injected
// directly). Idle = a bare orb. Click it or fire the hotkey and it nudges left while a
// real waveform (driven by the same AnalyserNode as the old level meter) grows beside
// it, plus a Stop button — ALWAYS shown while listening, tap/toggle, push-to-talk, or
// hands-free/wake-word alike (hiding it conditionally on the tap-vs-hold ambiguity
// wasn't worth the complexity — Rust can't even tell which one it is until either
// HOLD_MS has passed or the key is released, so it was flickering/wrong more than it
// helped). "Show live transcript" (config) gates a
// bubble above the pill: streaming text while listening, then the correction reveal
// (strike → fade/collapse) on Stop, auto-folding back to the bare orb after ~2s. With
// it off, the pill stays waveform-only and the corrected text is still injected — just
// quietly, with a brief "done" flash instead of the reveal.
//
// Pipeline + vendor key stay in the M2 backend (WS). Demo mode needs no mic/key (no UI
// trigger currently — the redesign dropped the Demo button; `connect("demo")` still
// works if someone wants to wire it back in, e.g. from the tray).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";

const WS_URL = (import.meta as any).env?.VITE_WS_URL ?? "ws://127.0.0.1:8787";
const TARGET_RATE = 16000;

// ---- theme (1.5): the overlay/orb follows the config store, live via config-changed.
// style.css defines the light/dark/system tokens; here we just set body[data-theme]. ----
function applyOverlayTheme(t?: string) {
  document.body.dataset.theme = t === "light" || t === "dark" ? t : "system";
}
void invoke<{ theme?: string }>("get_config")
  .then((c) => applyOverlayTheme(c?.theme))
  .catch(() => applyOverlayTheme("system"));
void listen<{ theme?: string }>("config-changed", (e) => applyOverlayTheme(e.payload?.theme));

// ---- widget-redesign prefs: whether to show the live-transcript/correction bubble at
// all, and whether removed spans fade before disappearing vs cut immediately. Both are
// real config fields (config.rs), default true — read once at boot + kept live via the
// same config-changed event. ----
let cfgShowTranscript = true;
let cfgShowRemoved = true;
function applyPrefs(c: any) {
  if (!c) return;
  cfgShowTranscript = c.showTranscript !== false;
  cfgShowRemoved = c.showRemoved !== false;
}
void invoke<any>("get_config").then(applyPrefs).catch(() => {});
void listen<any>("config-changed", (e) => applyPrefs(e.payload));

type Op = { type: "keep" | "remove" | "replace"; text: string; replacement?: string; reason?: string };
type ServerMsg =
  | { type: "ready"; stt: string; correction: string }
  | { type: "live"; transcript: string; active: string }
  | { type: "correction"; raw: string; cleanText: string; ops: Op[]; valid: boolean }
  | { type: "formatted"; text: string }
  // Platform P1 — command mode: the backend classifies the utterance into ONE structured
  // editing intent (the CommandIntent union in @verbatim/core); the Rust run_command
  // executor performs it. Typed `any` here to avoid a cross-package type import in the widget.
  | { type: "intent"; intent: any; transcript: string }
  | { type: "error"; message: string; file?: string }
  | { type: "done" };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const transcriptEl = $("transcript");
const root = $("root"), orb = $<HTMLButtonElement>("orb"), pill = $("pill");
const wave = $("level"); // reused id from the old titlebar meter — now the main waveform
const stopBtn = $<HTMLButtonElement>("stop");
const errBadge = $("errBadge");
const collapseBtn = $<HTMLButtonElement>("collapseBtn"); // now the pill's small cancel-x
const bubble = $("bubble"), bubbleTag = $("bubbleTag"), bubbleClose = $<HTMLButtonElement>("bubbleClose");
const foldRing = $("foldRing");
const banner = $("banner"), bannerMsg = $("bannerMsg"), bannerActions = $("bannerActions");
const openMicBtn = $<HTMLButtonElement>("openMic"), retryMicBtn = $<HTMLButtonElement>("retryMic");
const openAxBtn = $<HTMLButtonElement>("openAx");
const copyErr = $<HTMLButtonElement>("copyErr"), bannerLog = $("bannerLog");
const copyBtn = $<HTMLButtonElement>("copyBtn");
// Settings/Quit/Show-Last-Result all live on the menu-bar tray now (tray.rs) — Phase 4.9
// already removed the overlay's inline settings panel; this redesign removes the
// titlebar's gear/✕ too, since the tray already covers both.

// ---- window sizing: idle orb / listening pill (no bubble) / expanded (bubble showing).
// Every resize keeps the window's current BOTTOM-CENTER point fixed, so the pill (which
// always sits at the bottom of the flex column — see style.css #root) stays visually
// anchored while the window grows upward/outward for the bubble, and the existing
// monitor clamp below naturally makes it grow toward whichever side has room rather than
// always the same direction. ----
const appWin = getCurrentWindow();
const SIZES = {
  idle: { w: 78, h: 78 },
  pill: { w: 300, h: 78 },
  expanded: { w: 400, h: 260 },
} as const;
type ViewMode = keyof typeof SIZES;

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
async function monitorLogical() {
  try {
    const mon = await currentMonitor();
    if (!mon) return null;
    const s = mon.scaleFactor || 1;
    return { ox: mon.position.x / s, oy: mon.position.y / s, w: mon.size.width / s, h: mon.size.height / s };
  } catch { return null; }
}

async function resizeAnchored(w: number, h: number) {
  try {
    const s = await appWin.scaleFactor();
    const p = await appWin.outerPosition();
    const cur = await appWin.outerSize();
    const curW = cur.width / s, curH = cur.height / s;
    const cx = p.x / s + curW / 2;      // current horizontal center
    const bottomY = p.y / s + curH;     // current bottom edge
    let x = cx - w / 2;
    let y = bottomY - h;
    const m = await monitorLogical();
    if (m) {
      x = clampN(x, m.ox + 8, m.ox + m.w - w - 8);
      y = clampN(y, m.oy + 8, m.oy + m.h - h - 8);
    }
    await appWin.setSize(new LogicalSize(w, h));
    await appWin.setPosition(new LogicalPosition(x, y));
  } catch {}
}
async function setViewMode(v: ViewMode) {
  const s = SIZES[v];
  await resizeAnchored(s.w, s.h);
}
function desiredMode(): ViewMode {
  if (!bubble.hidden) return "expanded";
  if (pill.classList.contains("listening")) return "pill";
  return "idle";
}
async function syncViewMode() { await setViewMode(desiredMode()); }

// First launch: park the orb bottom-centre. Later transitions never need this — they
// all anchor off the window's OWN current position (resizeAnchored above), so wherever
// the user last dragged the pill to is exactly where the next state grows from.
async function initOrbPosition() {
  const m = await monitorLogical();
  const s = SIZES.idle;
  const x = m ? m.ox + (m.w - s.w) / 2 : 120;
  const y = m ? m.oy + m.h - s.h - 96 : 120;
  try {
    await appWin.setSize(new LogicalSize(s.w, s.h));
    await appWin.setPosition(new LogicalPosition(x, y));
  } catch {}
}

// ---- bubble: live transcript / correction reveal / last-result / error — one surface,
// shown/hidden as a unit. `hidden` is the authoritative visibility flag (desiredMode()
// above reads it); `.show` just drives the fade transition. ----
function showBubble() {
  bubble.hidden = false;
  requestAnimationFrame(() => bubble.classList.add("show"));
  void syncViewMode();
}
function hideBubble() {
  bubble.classList.remove("show", "tagged");
  bubbleTag.hidden = true;
  bubbleClose.hidden = true;
  cancelFold();
  setTimeout(() => {
    if (!bubble.classList.contains("show")) bubble.hidden = true;
    void syncViewMode();
  }, 190);
}
function setBubbleTag(text: string | null) {
  if (text) { bubbleTag.hidden = false; bubbleTag.textContent = text; bubble.classList.add("tagged"); }
  else { bubbleTag.hidden = true; bubble.classList.remove("tagged"); }
}

// Auto fold-back: a small ring in the bubble's corner counts down ~2s (correction reveal
// only — last-result/error never auto-close) before collapsing everything to the orb.
let foldRAF = 0;
function cancelFold() {
  if (foldRAF) cancelAnimationFrame(foldRAF);
  foldRAF = 0;
  foldRing.hidden = true;
  foldRing.classList.remove("show");
  foldRing.style.setProperty("--p", "0");
}
function startFold(afterMs = 2000) {
  cancelFold();
  foldRing.hidden = false;
  requestAnimationFrame(() => foldRing.classList.add("show"));
  const start = performance.now();
  const step = (t: number) => {
    const p = Math.min(1, (t - start) / afterMs);
    foldRing.style.setProperty("--p", String(Math.round(p * 100)));
    if (p < 1) { foldRAF = requestAnimationFrame(step); }
    else { foldRAF = 0; closeToIdle(); }
  };
  foldRAF = requestAnimationFrame(step);
}
// Post-Stop "processing" treatment (breathing wave + Stop spinner — the design reviewed
// and approved before implementing). Set by stop() the moment Stop is clicked; cleared
// here on either a successful settle (settleAfterSuccess) or a banner/error (showBanner) —
// nothing left mid-spin either way. closeToIdle()/enterListening() also clear it
// defensively, in case a stray processing session is torn down some other way.
function stopProcessingAnim() {
  pill.classList.remove("processing");
  wave.classList.remove("breathing");
  stopBtn.classList.remove("processing");
}

function closeToIdle() {
  cancelFold();
  hideBubble();
  stopProcessingAnim();
  pill.classList.remove("listening", "done");
  root.classList.remove("command-mode");
  void setViewMode("idle");
}

function enterListening() {
  pill.classList.remove("done");
  stopProcessingAnim();
  // Stop is always shown while .listening (see style.css) — tap, hold, or hands-free
  // alike. No tap-vs-hold branching here on purpose (see the header comment).
  pill.classList.add("listening");
  errBadge.classList.remove("show");
  void syncViewMode();
}

// Which kind of session the SAME audio path (startLive) is capturing: normal dictation
// ("live") or P1 command mode ("command"). startLive reads this to pick the connect mode;
// only the terminal handler differs (formatted→inject vs intent→run_command).
let captureMode: "live" | "command" = "live";

// Open the pill and start a fresh dictation session (streaming visible throughout, if
// the "show live transcript" setting is on).
function beginDictation() {
  clearBanner();
  captureMode = "live";
  root.classList.remove("command-mode");
  enterListening();
  reset();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  void startLive();
}

// P1 — command mode: identical audio session to dictation (getUserMedia → PCM stream →
// stop/finalize), differing only in mode:"command" on the start frame and the terminal
// `intent` handler. A distinct root class flags command mode in the UI (violet accent).
function beginCommand() {
  clearBanner();
  captureMode = "command";
  root.classList.add("command-mode");
  enterListening();
  reset();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  void startLive();
}

let finalText = ""; // the last formatted output — always copyable, even if injection had no target
let lastResult = ""; // survives reset(): the last dictation, recallable via the tray "Show Last Result"

let ws: WebSocket | null = null;
let audioCtx: AudioContext | null = null;
let processor: ScriptProcessorNode | null = null;
let micStream: MediaStream | null = null;
let analyser: AnalyserNode | null = null;
let levelRAF = 0;

// The waveform — real mic-level bars (18 of them, see index.html), driven by an
// AnalyserNode. This IS the "does it react to your voice" bar: near-silent input keeps
// every bar close to its resting height; speaking pushes them up in real time. Same
// mechanism as the old 5-bar titlebar meter, just bigger and re-themed.
const levelBars = Array.from(document.querySelectorAll<HTMLElement>("#level i"));
function startLevelMeter() {
  if (!analyser) return;
  const buf = new Uint8Array(analyser.frequencyBinCount);
  const n = Math.max(1, levelBars.length);
  const band = Math.max(1, Math.floor(buf.length / n));
  const tick = () => {
    if (!analyser) return;
    analyser.getByteFrequencyData(buf);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < band; j++) sum += buf[i * band + j] || 0;
      let avg = sum / band / 255; // 0..1
      if (avg < 0.02) avg = 0; // noise floor — true silence reads as a flat line, not a jitter
      levelBars[i].style.height = (3 + Math.pow(avg, 0.7) * 27).toFixed(1) + "px";
    }
    levelRAF = requestAnimationFrame(tick);
  };
  tick();
}
function stopLevelMeter() {
  if (levelRAF) cancelAnimationFrame(levelRAF);
  levelRAF = 0;
  levelBars.forEach((b) => (b.style.height = "3px"));
}

const TYPING = `<span class="typing"><i></i><i></i><i></i></span>`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Presentational only now (no titlebar dot/status text) — "err" lights the small red
// badge on the pill's corner; the orb's tooltip carries the text for anyone hovering.
function setStatus(cls: string, text: string) {
  if (cls === "err") { errBadge.hidden = false; requestAnimationFrame(() => errBadge.classList.add("show")); }
  else errBadge.classList.remove("show");
  orb.title = text ? `Dictate  (⌥Space) — ${text}` : "Dictate  (⌥Space)";
}

// Single notification banner, now living inside the bubble (no separate titlebar strip).
// Explicitly shown/cleared so it can never go stale (e.g. a mic-permission notice must
// vanish the moment the mic works).
type BannerActions = "none" | "mic" | "ax";
function showBanner(kind: "err" | "warn" | "info", msg: string, actions: BannerActions = "none") {
  cancelFold();
  stopProcessingAnim(); // an error/notice means we're not just "wrapping up" anymore — stop spinning
  banner.className = "banner " + kind;
  bannerMsg.textContent = msg;
  openMicBtn.hidden = actions !== "mic";
  retryMicBtn.hidden = actions !== "mic";
  openAxBtn.hidden = actions !== "ax";
  copyErr.hidden = true;      // only shown for backend/PyAI errors (set in handle())
  bannerLog.hidden = true;
  bannerActions.hidden = actions === "none";
  banner.hidden = false;
  setBubbleTag(null);
  bubbleClose.hidden = false;
  bubbleClose.onclick = () => clearBanner();
  showBubble();
}
function clearBanner() {
  const wasShown = !banner.hidden;
  banner.hidden = true;
  bannerActions.hidden = true;
  copyErr.hidden = true;
  bannerLog.hidden = true;
  errBadge.classList.remove("show");
  // Only close the bubble if the banner was actually the thing showing — a defensive
  // clearBanner() at the top of beginDictation()/startLive() must never stomp on an
  // unrelated live-transcript or last-result bubble that's already open.
  if (wasShown) { bubbleClose.hidden = true; hideBubble(); }
}

// Full text of the last backend error + the log-file path (both untruncated), so the
// user can copy the complete detail for reporting even though the banner is short.
let lastErrorFull = "";
let lastErrorFile = "";

// Turn raw backend errors into a short, human line (the bubble is small, and dumping
// vendor JSON reads as broken).
function friendlyError(msg: string): string {
  if (/DAILY_CAP_EXCEEDED|cap reached|requests_too_many|\b429\b/i.test(msg))
    return "PyAI daily cap reached (resets 00:00 UTC) — try again later or use another key";
  if (/microphone|getusermedia/i.test(msg)) return "microphone error";
  const m = msg.replace(/\s+/g, " ").trim();
  return m.length > 110 ? m.slice(0, 110) + "…" : m;
}

function resetCopy() {
  finalText = "";
  copyBtn.disabled = true;
  copyBtn.classList.remove("copied", "visible");
  copyBtn.textContent = "Copy";
}

function reset() {
  resetCopy();
  if (cfgShowTranscript) {
    setBubbleTag(null);
    transcriptEl.innerHTML = `<span class="hint">Listening…</span>`;
    showBubble();
  }
}

function renderLive(m: Extract<ServerMsg, { type: "live" }>) {
  transcriptEl.innerHTML =
    `<span class="stable">${esc(m.transcript)}</span>` +
    (m.active ? ` <span class="active">${esc(m.active)}</span>` : "") +
    `<span class="caret"></span>`;
}

// One-time diff over the finished transcript: strike what cleanup removed.
async function animateCorrection(m: Extract<ServerMsg, { type: "correction" }>) {
  if (!m.ops.some((o) => o.type !== "keep")) return; // nothing removed -> leave clean transcript as-is
  setBubbleTag("what we removed");
  transcriptEl.innerHTML = "";
  m.ops.forEach((o, i) => {
    if (o.type === "keep") {
      const s = document.createElement("span");
      s.className = "stable";
      s.textContent = o.text;
      transcriptEl.appendChild(s);
    } else {
      const s = document.createElement("span");
      s.className = `op rm r-${o.reason}`;
      s.dataset.i = String(i);
      s.textContent = o.text;
      transcriptEl.appendChild(s);
      if (o.type === "replace") {
        const n = document.createElement("span");
        n.className = "repl-new hidden";
        n.dataset.new = String(i);
        n.textContent = o.replacement ?? "";
        transcriptEl.appendChild(n);
      }
    }
  });
  await sleep(150);
  for (let i = 0; i < m.ops.length; i++) {
    const o = m.ops[i];
    if (o.type === "keep") continue;
    transcriptEl.querySelector<HTMLElement>(`.op[data-i="${i}"]`)?.classList.add("striking");
    await sleep(140);
    if (o.type === "replace") transcriptEl.querySelector(`.repl-new[data-new="${i}"]`)?.classList.replace("hidden", "show");
  }
  await sleep(250);
  transcriptEl.querySelectorAll<HTMLElement>(".op.rm").forEach((s) => s.classList.add(cfgShowRemoved ? "faded" : "collapsed"));
}

function isBubbleShown() { return !bubble.hidden; }

// The widget seam: paste the finalized text into the focused field of the app
// underneath, via the Rust inject_text (clipboard + synthetic ⌘V) command. Returns a
// discriminated outcome so the caller can tell "done, safe to auto-fold" from "a banner
// is now showing and needs the user to read/dismiss it".
async function injectFinal(text: string): Promise<"ok" | "no_access" | "secure" | "no_field" | "failed"> {
  if (!text.trim()) return "ok";
  try {
    // Rust returns where the text went; the fallback cases already put it on the clipboard.
    const result = await invoke<string>("inject_text", { text });
    if (result === "no_access") {
      setStatus("err", "grant Accessibility");
      showBanner("err", "Grant Accessibility so the widget can insert text (also needed for pasting). Enable Verbatim (or your terminal, in dev), then quit & relaunch. Text is copied — press ⌘V meanwhile.", "ax");
      return "no_access";
    } else if (result === "secure") {
      setStatus("err", "secure field");
      showBanner("warn", "That looks like a password / secure field — not inserting. The text is on your clipboard (⌘V) if you need it elsewhere.");
      return "secure";
    } else if (result === "no_field") {
      setStatus("done", "copied");
      showBanner("info", "No text field was focused — copied to your clipboard. Press ⌘V where you want it.");
      return "no_field";
    } else {
      setStatus("done", "inserted ✓");
      return "ok";
    }
  } catch (e) {
    // Text stays copyable via the bubble's Copy button, so nothing is lost.
    setStatus("err", "inject failed");
    showBanner("err", "Injection failed — grant Accessibility (System Settings → Privacy → Accessibility), then retry. Use Copy above meanwhile.");
    return "failed";
  }
}

// P1 — the command-mode seam: hand the classified intent to Rust's run_command executor,
// which performs one editing action on the focused field via synthetic keystrokes. Routes
// the returned status like injectFinal (same secure / no_field / no_access banners), and
// returns the same "ok" sentinel so the intent handler can auto-fold identically.
async function runCommandIntent(intent: any): Promise<"ok" | "blocked"> {
  try {
    const result = await invoke<string>("run_command", { intent });
    if (result === "no_access") {
      setStatus("err", "grant Accessibility");
      showBanner("err", "Grant Accessibility so Verbatim can run commands (System Settings → Privacy → Accessibility). Enable Verbatim (or your terminal, in dev), then quit & relaunch.", "ax");
      return "blocked";
    } else if (result === "secure") {
      setStatus("err", "secure field");
      showBanner("warn", "That looks like a password / secure field — the command wasn't run.");
      return "blocked";
    } else if (result === "no_field") {
      setStatus("done", "no field");
      showBanner("info", "No editable text field was focused — nothing to run the command on.");
      return "blocked";
    } else if (result === "noop") {
      setStatus("done", "no action");
      return "ok";
    } else if (result === "disabled") {
      // P2 — a system command arrived while the opt-in flag is off.
      setStatus("done", "commands off");
      showBanner("info", "System commands are turned off — enable “Allow system commands” in Settings to run “open Slack”, volume, or a Shortcut.");
      return "blocked";
    } else if (result === "unavailable") {
      // P2 — the macOS facility is missing (e.g. no `shortcuts` CLI pre-Monterey).
      setStatus("err", "unavailable");
      showBanner("warn", "That needs macOS 12+ Shortcuts — the “shortcuts” command isn’t available on this Mac.");
      return "blocked";
    } else {
      setStatus("done", "done ✓");
      return "ok";
    }
  } catch (e) {
    setStatus("err", "command failed");
    showBanner("err", "Running the command failed — grant Accessibility (System Settings → Privacy → Accessibility), then retry.");
    return "blocked";
  }
}

// After a successful outcome (no banner now showing), flash the pill briefly, then either
// hold the correction reveal open for ~2s (transcript setting on) or drop straight back
// to the idle orb (off) — shared by both the dictation and command-mode terminal paths.
function settleAfterSuccess() {
  stopProcessingAnim(); // drop the breathing wave / Stop spinner in favor of the done flash
  pill.classList.add("done");
  setTimeout(() => {
    pill.classList.remove("done");
    if (cfgShowTranscript && isBubbleShown()) startFold(2000);
    else closeToIdle();
  }, 650);
}

function handle(m: ServerMsg) {
  if (m.type === "ready") { setStatus("live", `listening (${m.stt} + ${m.correction})`); }
  else if (m.type === "live") { if (cfgShowTranscript) renderLive(m); }
  else if (m.type === "correction") {
    if (cfgShowTranscript) void animateCorrection(m);
    void invoke("set_last_raw", { text: m.raw }).catch(() => {}); // 5.4 — remember raw for revert-to-raw
    setStatus("fix", "polishing…");
  }
  else if (m.type === "formatted") {
    finalText = m.text;
    if (m.text.trim()) lastResult = m.text; // remember for "Show Last Result"
    copyBtn.disabled = !m.text.trim();
    copyBtn.classList.toggle("visible", !!m.text.trim()); // always copyable, even if injection lands nowhere
    void injectFinal(m.text).then((outcome) => { if (outcome === "ok") settleAfterSuccess(); });
  }
  else if (m.type === "intent") {
    // P1 — command mode: hand the classified intent to the Rust executor. It runs ONE
    // editing action on the focused field and returns where it went (like inject_text).
    void runCommandIntent(m.intent).then((outcome) => { if (outcome === "ok") settleAfterSuccess(); });
  }
  else if (m.type === "error") {
    setStatus("err", "error");
    lastErrorFull = m.message;               // keep the FULL message (banner shows a short form)
    if (m.file) lastErrorFile = m.file;
    showBanner("err", friendlyError(m.message));
    copyErr.hidden = false;                   // offer one-click copy of the complete detail
    bannerActions.hidden = false;
    if (lastErrorFile) { bannerLog.hidden = false; bannerLog.textContent = "Full error logged to " + lastErrorFile; }
  }
  else if (m.type === "done") {
    teardownAudio();
    if (ws) { try { ws.close(); } catch {} ws = null; } // next session starts fresh
    resetButtons();
    // Deliberately NOT force-closing here — the fold-back timer (or the immediate
    // close for "show transcript" off) started from settleAfterSuccess() above is what
    // ends the session visually; `done` may well arrive mid-reveal.
  }
}

// Phase 4.8: the start frame carries only the provider/language SELECTION (from the
// config store) — never a key. The Rust host injects the Keychain keys into the backend
// sidecar's env, and owns the sidecar's lifecycle, so on a cold start the loopback port
// may not be up yet → retry briefly before giving up.
async function connect(mode: "demo" | "live" | "command", tries = 6): Promise<void> {
  // Live: fetch config + the vocabulary/snippet stores IN PARALLEL (no serial start
  // latency). Demo mode uses no config/lists. (3.4/3.5 ride the WS start frame.)
  const [cfg, vocabulary, snippets] = mode !== "demo"
    ? await Promise.all([
        invoke<any>("get_config").catch(() => ({})),
        invoke<string[]>("vocab_list").catch(() => [] as string[]),
        invoke<Array<{ trigger: string; expansion: string }>>("snip_list").catch(() => []),
      ])
    : [{} as any, [] as string[], [] as Array<{ trigger: string; expansion: string }>];
  return new Promise((resolve, reject) => {
    let opened = false;
    const attempt = (left: number) => {
      ws = new WebSocket(WS_URL);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        opened = true;
        ws!.send(JSON.stringify({
          type: "start",
          mode,
          sttProvider: cfg.sttProvider,
          correctionProvider: cfg.correctionProvider,
          language: cfg.language,
          correct: cfg.correct, // 2.2 — undefined in demo (cfg={}) => backend defaults on
          format: cfg.format,   // 2.3 — undefined in demo => backend defaults on
          formatMode: cfg.formatMode, // 5.3 — prose|message|code|raw (undefined in demo => prose)
          autoDetect: cfg.autoDetectLanguage, // 3.2 — undefined in demo => backend defaults off
          vocabulary, // 3.4 — custom terms (format prompt + Deepgram keyword boost)
          snippets,   // 3.5 — deterministic trigger→expansion on the final text
          telemetry: cfg.telemetry, // 3.3 — undefined in demo => backend defaults off (NoopSink)
          sttModel: cfg.sttModel,               // Phase 7 — STT model override ("" = provider default)
          correctionModel: cfg.correctionModel, // Phase 7 — correction model override ("" = default)
          commandProvider: cfg.commandProvider, // P1 — command-mode classifier ("" ⇒ backend follows correction)
          commandModel: cfg.commandModel,       // P1 — optional command-mode model override
        }));
        resolve();
      };
      ws.onmessage = (e) => handle(JSON.parse(e.data) as ServerMsg);
      ws.onerror = () => {
        if (!opened && left > 0) { try { ws?.close(); } catch {} setTimeout(() => attempt(left - 1), 250); return; }
        if (!opened) { setStatus("err", "no backend"); showBanner("err", "Can't reach the backend at " + WS_URL + " — quit & relaunch Verbatim."); reject(new Error("ws")); }
      };
      ws.onclose = () => { ws = null; };
    };
    attempt(tries);
  });
}

// ---- audio ----
function downsample(input: Float32Array, srcRate: number): Float32Array {
  if (srcRate === TARGET_RATE) return input;
  const ratio = srcRate / TARGET_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const idx = i * ratio;
    const lo = Math.floor(idx), hi = Math.min(lo + 1, input.length - 1);
    out[i] = input[lo] + (input[hi] - input[lo]) * (idx - lo);
  }
  return out;
}
function toInt16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); out[i] = s * 32767; }
  return out;
}

async function startLive() {
  clearBanner();
  try {
    // 3.1 — capture from the user's chosen input device (mic_device_id; "" = system
    // default). Use `ideal` (not `exact`) so a removed/renamed device falls back to the
    // system default instead of throwing OverconstrainedError → a false "No microphone".
    const micId: string = (await invoke<any>("get_config").catch(() => ({}))).micDeviceId ?? "";
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        ...(micId ? { deviceId: { ideal: micId } } : {}),
      },
    });
  } catch (e) {
    // Only show the "access needed" banner for a REAL permission denial — otherwise we
    // were wrongly claiming the mic was blocked when it wasn't.
    pill.classList.remove("listening"); // no audio session actually started
    const name = (e as any)?.name ?? "";
    if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
      setStatus("err", "mic blocked");
      showBanner("err", "Microphone access needed — enable Verbatim (or your terminal, in dev) under Microphone, then quit & relaunch.", "mic");
    } else if (name === "NotFoundError" || name === "OverconstrainedError") {
      setStatus("err", "no mic"); showBanner("err", "No microphone found.");
    } else {
      setStatus("err", "mic error"); showBanner("err", "Microphone error: " + (name || String(e)));
    }
    resetButtons();
    return;
  }
  // Mic works — make sure no stale permission banner lingers.
  clearBanner();
  void muteOthersForSession(); // silence system output while dictating (if enabled)
  reset();
  buttonsBusy();
  // Phase 4.8: no key here — the Rust host injects the Keychain keys into the backend
  // sidecar's env; the webview only sends the provider/language selection. P1 — the same
  // audio path serves command mode; captureMode picks the start-frame mode.
  await connect(captureMode);
  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 128;
  source.connect(analyser);
  startLevelMeter();
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  source.connect(processor);
  processor.connect(audioCtx.destination);
  processor.onaudioprocess = (ev) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(toInt16(downsample(ev.inputBuffer.getChannelData(0), audioCtx!.sampleRate)).buffer);
  };
}

function teardownAudio() {
  stopLevelMeter();
  analyser = null;
  processor?.disconnect(); processor = null;
  audioCtx?.close().catch(() => {}); audioCtx = null;
  micStream?.getTracks().forEach((t) => t.stop()); micStream = null;
  void restoreOthersAudio(); // un-mute system output if we muted it for this session
}

// Mute other system audio while dictating (config.muteOthers). We remember the prior
// mute state and only mute if it wasn't already muted — restoring on teardown never
// changes the user's actual volume level.
let mutedBySession = false;
let prevOutputMuted = false;
async function muteOthersForSession() {
  try {
    const cfg = await invoke<any>("get_config");
    if (!cfg?.muteOthers) return;
    prevOutputMuted = await invoke<boolean>("get_output_muted");
    if (!prevOutputMuted) {
      await invoke("set_output_muted", { muted: true });
      mutedBySession = true;
    }
  } catch {}
}
async function restoreOthersAudio() {
  if (!mutedBySession) return;
  mutedBySession = false;
  try { await invoke("set_output_muted", { muted: prevOutputMuted }); } catch {}
}

function stop() {
  setStatus("fix", "finishing up…");
  resetCopy();
  cancelFold();
  // Keep .listening (card chrome stays up) — it reads as "still wrapping up". The
  // waveform stops reacting to voice (teardownAudio() below) and instead breathes on its
  // own via .processing/.breathing (reviewed as the "breathing wave" design candidate),
  // and Stop swaps its red square for a spinner — cleared by stopProcessingAnim() once
  // settleAfterSuccess() or showBanner() fires.
  pill.classList.add("processing");
  wave.classList.add("breathing");
  stopBtn.classList.add("processing");
  stopBtn.disabled = true;
  teardownAudio();
  // Clear the Rust recording latches (esp. the wake self-trigger gate) so a UI/auto
  // stop of a wake- or hotkey-started session lets the wake word re-fire and keeps hotkey state sane.
  void invoke("clear_recording_state").catch(() => {});
  ws?.send(JSON.stringify({ type: "stop" }));
}

function buttonsBusy() { stopBtn.disabled = false; }
function resetButtons() { stopBtn.disabled = true; }

stopBtn.onclick = () => stop();

// Orb: click to dictate (or, while already listening, to stop & insert — a second way
// to end a toggle session besides the Stop button or a second hotkey tap); drag to
// reposition. Distinguish click-vs-drag by movement. The orb is never hidden now (no
// separate card view to swap it out for), so this same handler covers both idle and
// listening states, and dragging works identically in either.
let orbDown = false, orbMoved = false, orbPosReady = false;
let orbStartX = 0, orbStartY = 0, orbWinLX = 0, orbWinLY = 0, orbScale = 1;
orb.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  orbDown = true; orbMoved = false; orbPosReady = false;
  orbStartX = e.screenX; orbStartY = e.screenY;
  try { orb.setPointerCapture(e.pointerId); } catch {}
  void (async () => {
    try {
      orbScale = await appWin.scaleFactor();
      const p = await appWin.outerPosition();
      orbWinLX = p.x / orbScale; orbWinLY = p.y / orbScale;
      orbPosReady = true;
    } catch {}
  })();
});
orb.addEventListener("pointermove", (e) => {
  if (!orbDown || !orbPosReady) return;
  const dx = e.screenX - orbStartX, dy = e.screenY - orbStartY;
  if (!orbMoved && Math.hypot(dx, dy) > 4) orbMoved = true;
  if (orbMoved) {
    void appWin.setPosition(new LogicalPosition(orbWinLX + dx, orbWinLY + dy)).catch(() => {});
  }
});
orb.addEventListener("pointerup", (e) => {
  if (!orbDown) return;
  orbDown = false;
  try { orb.releasePointerCapture(e.pointerId); } catch {}
  if (orbMoved) return; // a drag, not a click
  if (pill.classList.contains("listening")) { if (ws) stop(); }
  else beginDictation();
});

// Cancel — discard the in-progress session without inserting (only visible while
// listening; replaces the old titlebar ✕). Closes the socket WITHOUT sending {type:
// "stop"}, so the backend never runs correction/format on it.
collapseBtn.onclick = () => {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  teardownAudio();
  clearBanner();
  closeToIdle();
};

// Bubble dismiss — for content that doesn't auto-fold (an error banner, or a reopened
// last-result). Wired per-context by showBanner()/showLastResult(); a plain hideBubble()
// covers the fallback.
bubbleClose.onclick = () => hideBubble();

copyBtn.onclick = async () => {
  if (!finalText) return;
  try {
    await invoke("copy_text", { text: finalText });
    copyBtn.textContent = "Copied ✓";
    copyBtn.classList.add("copied");
    setTimeout(() => { copyBtn.textContent = "Copy"; copyBtn.classList.remove("copied"); }, 1600);
  } catch (e) {
    copyBtn.textContent = "Copy failed";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1600);
  }
};
openMicBtn.onclick = () => { void invoke("open_mic_settings").catch(() => {}); };
openAxBtn.onclick = () => { void invoke("open_accessibility_settings").catch(() => {}); };
retryMicBtn.onclick = () => { clearBanner(); void startLive(); };
// Copy the COMPLETE error (untruncated) + the log path for easy reporting.
copyErr.onclick = async () => {
  const payload = (lastErrorFile ? `Log: ${lastErrorFile}\n\n` : "") + lastErrorFull;
  try {
    await invoke("copy_text", { text: payload });
    copyErr.textContent = "Copied ✓";
  } catch { copyErr.textContent = "Copy failed"; }
  setTimeout(() => { copyErr.textContent = "Copy details"; }, 1600);
};

// ⌥Space drives dictation from Rust: hold = push-to-talk, tap = toggle. Stop is always
// shown while listening regardless of which (see enterListening()) — we deliberately
// ignore the `"hold"` payload Rust also sends (see shortcuts.rs/fnkey.rs); it exists for
// other potential uses but the widget no longer hides Stop based on it.
void listen<string>("dictation", (e) => {
  if (e.payload === "start") beginDictation();
  else if (e.payload === "stop") { if (ws) stop(); }
});

// P1 — the command-mode hotkey drives command capture from Rust (same tap/hold state
// machine as dictation, separate statics). Reuses the same stop()/finalize audio path;
// the backend replies with an `intent` frame instead of `formatted`.
void listen<string>("command", (e) => {
  if (e.payload === "start") beginCommand();
  else if (e.payload === "stop") { if (ws) stop(); }
});

// Tray "Show Last Result" → reopen the bubble with the previous dictation (no new
// session), so the user can re-copy it. Unlike the live/correction reveal, this does
// NOT auto-fold — it stays until dismissed (bubbleClose) or a new dictation starts.
// lastResult survives reset() between sessions.
async function showLastResult() {
  clearBanner();
  root.classList.remove("command-mode");
  pill.classList.remove("listening");
  if (lastResult.trim()) {
    setBubbleTag("last result");
    transcriptEl.innerHTML = `<span class="stable">${esc(lastResult)}</span>`;
    finalText = lastResult;
    copyBtn.disabled = false;
    copyBtn.classList.add("visible");
  } else {
    setBubbleTag(null);
    transcriptEl.innerHTML = `<span class="hint">Nothing dictated yet. Press ⌥Space or click the orb to start.</span>`;
    resetCopy();
  }
  bubbleClose.hidden = false;
  bubbleClose.onclick = () => hideBubble();
  showBubble();
}
void listen("show-last", () => { void showLastResult(); });

void initOrbPosition(); // start as the floating orb, bottom-centre; drag to move
