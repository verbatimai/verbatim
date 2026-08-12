// Open Dictation widget frontend (M3 Phase 3.1).
// Reuses the M2 experience: the transcript streams as ONE clean growing line
// (locked text + volatile tail); on Stop the backend batch-transcribes, runs
// cleanup (the "what was removed" diff) and formatting, and returns the final text.
//
// Widget-specific seam: when the `formatted` message arrives, we hand the text to
// the Rust `inject_text` command, which pastes it into whatever field is focused in
// the app underneath (the panel is non-activating + non-key, so focus never left it).
//
// Pipeline + vendor key stay in the M2 backend (WS). Demo mode needs no mic/key.
// The client-side core pipeline + BYOK/keychain is Phase 3.5.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";

const WS_URL = (import.meta as any).env?.VITE_WS_URL ?? "ws://127.0.0.1:8787";
const TARGET_RATE = 16000;

type Op = { type: "keep" | "remove" | "replace"; text: string; replacement?: string; reason?: string };
type ServerMsg =
  | { type: "ready"; stt: string; correction: string }
  | { type: "live"; transcript: string; active: string }
  | { type: "correction"; raw: string; cleanText: string; ops: Op[]; valid: boolean }
  | { type: "formatted"; text: string }
  | { type: "error"; message: string }
  | { type: "done" };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dot = $("dot"), statusText = $("statusText"), transcriptEl = $("transcript"), finalOut = $("finalOut");
const demoBtn = $<HTMLButtonElement>("demo"), startBtn = $<HTMLButtonElement>("start"), stopBtn = $<HTMLButtonElement>("stop");
const showRemoved = $<HTMLInputElement>("showRemoved");
const banner = $("banner"), bannerMsg = $("bannerMsg"), bannerActions = $("bannerActions");
const bannerClose = $<HTMLButtonElement>("bannerClose");
const openMicBtn = $<HTMLButtonElement>("openMic"), retryMicBtn = $<HTMLButtonElement>("retryMic");
const openAxBtn = $<HTMLButtonElement>("openAx");
const copyBtn = $<HTMLButtonElement>("copyBtn");
const root = $("root"), orb = $<HTMLButtonElement>("orb");
const collapseBtn = $<HTMLButtonElement>("collapseBtn");

// Two views: idle "orb" (small floating dot) and active "card" (full streaming UI).
// Both sit bottom-center; resize + reposition on switch.
const appWin = getCurrentWindow();
const ORB = 74, CARD_W = 440, CARD_H = 360;
let orbPos: { x: number; y: number } | null = null; // logical top-left where the orb lives

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
async function monitorLogical() {
  try {
    const mon = await currentMonitor();
    if (!mon) return null;
    const s = mon.scaleFactor || 1;
    return { ox: mon.position.x / s, oy: mon.position.y / s, w: mon.size.width / s, h: mon.size.height / s };
  } catch { return null; }
}

async function setView(v: "orb" | "card") {
  const card = v === "card";
  root.classList.toggle("card-view", card);
  root.classList.toggle("orb-view", !card);
  const w = card ? CARD_W : ORB, h = card ? CARD_H : ORB;
  try {
    await appWin.setSize(new LogicalSize(w, h));
    if (card) {
      // Open the card anchored on the orb's spot (centred on it), clamped on-screen.
      const a = orbPos ?? { x: 0, y: 0 };
      let x = a.x + ORB / 2 - w / 2;
      let y = a.y + ORB / 2 - h / 2;
      const m = await monitorLogical();
      if (m) {
        x = clampN(x, m.ox + 8, m.ox + m.w - w - 8);
        y = clampN(y, m.oy + 8, m.oy + m.h - h - 8);
      }
      await appWin.setPosition(new LogicalPosition(x, y));
    } else if (orbPos) {
      // Restore the orb to exactly where the user left it.
      await appWin.setPosition(new LogicalPosition(orbPos.x, orbPos.y));
    }
  } catch {}
}

// First launch: park the orb bottom-centre, then remember that as its position.
async function initOrbPosition() {
  const m = await monitorLogical();
  orbPos = m ? { x: m.ox + (m.w - ORB) / 2, y: m.oy + m.h - ORB - 96 } : { x: 120, y: 120 };
  await setView("orb");
}

// Open the full card and start a fresh dictation session (streaming visible throughout).
function beginDictation() {
  clearBanner();
  void setView("card");
  reset();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  void startLive();
}

let finalText = ""; // the last formatted output — always copyable, even if injection had no target

let ws: WebSocket | null = null;
let audioCtx: AudioContext | null = null;
let processor: ScriptProcessorNode | null = null;
let micStream: MediaStream | null = null;
let analyser: AnalyserNode | null = null;
let levelRAF = 0;

// Live mic-level meter (5 bars in the titlebar), driven by an AnalyserNode.
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
      const avg = sum / band / 255; // 0..1
      levelBars[i].style.height = (3 + Math.pow(avg, 0.7) * 13).toFixed(1) + "px";
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
function setStatus(cls: string, text: string) { dot.className = "dot " + cls; statusText.textContent = text; }

// Single notification banner under the title bar. Explicitly shown/cleared so it can
// never go stale (e.g. a mic-permission notice must vanish the moment the mic works).
type BannerActions = "none" | "mic" | "ax";
function showBanner(kind: "err" | "warn" | "info", msg: string, actions: BannerActions = "none") {
  banner.className = "banner " + kind;
  bannerMsg.textContent = msg;
  openMicBtn.hidden = actions !== "mic";
  retryMicBtn.hidden = actions !== "mic";
  openAxBtn.hidden = actions !== "ax";
  bannerActions.hidden = actions === "none";
  banner.hidden = false;
}
function clearBanner() { banner.hidden = true; bannerActions.hidden = true; }

// Turn raw backend errors into a short, human line (the status pill is small, and
// dumping vendor JSON reads as broken).
function friendlyError(msg: string): string {
  if (/DAILY_CAP_EXCEEDED|cap reached|requests_too_many|\b429\b/i.test(msg))
    return "PyAI daily cap reached (resets 00:00 UTC) — use Demo or another key";
  if (/microphone|getusermedia/i.test(msg)) return "microphone error";
  const m = msg.replace(/\s+/g, " ").trim();
  return m.length > 110 ? m.slice(0, 110) + "…" : m;
}

function resetCopy() {
  finalText = "";
  copyBtn.disabled = true;
  copyBtn.classList.remove("copied");
  copyBtn.textContent = "Copy";
}

function reset() {
  transcriptEl.innerHTML = `<span class="hint">Listening…</span>`;
  finalOut.textContent = "";
  resetCopy();
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
  transcriptEl.querySelectorAll<HTMLElement>(".op.rm").forEach((s) => s.classList.add(showRemoved.checked ? "faded" : "collapsed"));
}

// The widget seam: paste the finalized text into the focused field of the app
// underneath, via the Rust inject_text (clipboard + synthetic ⌘V) command.
async function injectFinal(text: string) {
  if (!text.trim()) return;
  try {
    // Rust returns where the text went; the fallback cases already put it on the clipboard.
    const result = await invoke<string>("inject_text", { text });
    if (result === "no_access") {
      setStatus("err", "grant Accessibility");
      showBanner("err", "Grant Accessibility so the widget can insert text (also needed for pasting). Enable Open Dictation (or your terminal, in dev), then quit & relaunch. Text is copied — press ⌘V meanwhile.", "ax");
    } else if (result === "secure") {
      setStatus("err", "secure field");
      showBanner("warn", "That looks like a password / secure field — not inserting. The text is on your clipboard (⌘V) if you need it elsewhere.");
    } else if (result === "no_field") {
      setStatus("done", "copied");
      showBanner("info", "No text field was focused — copied to your clipboard. Press ⌘V where you want it.");
    } else {
      setStatus("done", "inserted ✓");
    }
  } catch (e) {
    // Text stays visible in the Final Output box + the Copy button, so nothing is lost.
    setStatus("err", "inject failed");
    showBanner("err", "Injection failed — grant Accessibility (System Settings → Privacy → Accessibility), then retry. Use Copy above meanwhile.");
  }
}

function handle(m: ServerMsg) {
  if (m.type === "ready") { setStatus("live", `listening (${m.stt} + ${m.correction})`); }
  else if (m.type === "live") renderLive(m);
  else if (m.type === "correction") {
    void animateCorrection(m);
    setStatus("fix", "polishing…");
    // Show the cleaned text immediately (before the formatter finishes) so the output
    // isn't a long blank spinner — the polished version replaces it on `formatted`.
    if (m.cleanText && m.cleanText.trim()) finalOut.textContent = m.cleanText;
  }
  else if (m.type === "formatted") {
    finalText = m.text;
    finalOut.textContent = m.text;
    copyBtn.disabled = !m.text.trim(); // always copyable, even if injection lands nowhere
    void injectFinal(m.text);
  }
  else if (m.type === "error") { setStatus("err", "error"); showBanner("err", friendlyError(m.message)); }
  else if (m.type === "done") {
    teardownAudio();
    if (ws) { try { ws.close(); } catch {} ws = null; } // next session starts fresh
    resetButtons();
    // Show the final result briefly, then collapse back to the floating orb.
    setTimeout(() => { void setView("orb"); }, 1400);
  }
}

function connect(mode: "demo" | "live"): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => { ws!.send(JSON.stringify({ type: "start", mode })); resolve(); };
    ws.onmessage = (e) => handle(JSON.parse(e.data) as ServerMsg);
    ws.onerror = () => { setStatus("err", "no backend"); showBanner("err", "Can't reach the backend at " + WS_URL + " — run `npm run widget` (or `npm run backend`)."); reject(new Error("ws")); };
    ws.onclose = () => { ws = null; };
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
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    // Only show the "access needed" banner for a REAL permission denial — otherwise we
    // were wrongly claiming the mic was blocked when it wasn't.
    const name = (e as any)?.name ?? "";
    if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
      setStatus("err", "mic blocked");
      showBanner("err", "Microphone access needed — enable Open Dictation (or your terminal, in dev) under Microphone, then quit & relaunch. Demo works without a mic.", "mic");
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
  reset();
  buttonsBusy();
  await connect("live");
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
}

function stop() {
  setStatus("fix", "finishing up…");
  resetCopy();
  finalOut.innerHTML = TYPING; // loading indicator on the OUTPUT while it computes
  demoBtn.disabled = true; startBtn.disabled = true; stopBtn.disabled = true;
  teardownAudio();
  ws?.send(JSON.stringify({ type: "stop" }));
}

function buttonsBusy() { demoBtn.disabled = true; startBtn.disabled = true; stopBtn.disabled = false; }
function resetButtons() { demoBtn.disabled = false; startBtn.disabled = false; stopBtn.disabled = true; }

demoBtn.onclick = async () => { clearBanner(); reset(); finalOut.innerHTML = TYPING; buttonsBusy(); stopBtn.disabled = true; await connect("demo"); };
startBtn.onclick = () => void startLive();
stopBtn.onclick = () => stop();
bannerClose.onclick = () => clearBanner();

// Orb: click to dictate, drag to reposition. Distinguish the two by movement.
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
    orbPos = { x: orbWinLX + dx, y: orbWinLY + dy }; // remember where the orb is dragged to
    void appWin.setPosition(new LogicalPosition(orbPos.x, orbPos.y)).catch(() => {});
  }
});
orb.addEventListener("pointerup", (e) => {
  if (!orbDown) return;
  orbDown = false;
  try { orb.releasePointerCapture(e.pointerId); } catch {}
  if (!orbMoved) beginDictation(); // a click, not a drag
});
collapseBtn.onclick = () => {
  // Dismiss / cancel — drop the session without inserting, return to the orb.
  if (ws) { try { ws.close(); } catch {} ws = null; }
  teardownAudio();
  resetButtons();
  clearBanner();
  void setView("orb");
};
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

// ⌥Space drives dictation from Rust: hold = push-to-talk, tap = toggle.
void listen<string>("dictation", (e) => {
  if (e.payload === "start") beginDictation();
  else if (e.payload === "stop") { if (ws) stop(); }
});

reset();
void initOrbPosition(); // start as the floating orb, bottom-centre; drag to move
