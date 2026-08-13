// Meetings view — dual-stream capture in the webview, no new Rust.
//
// Mic (Me) and the system-audio loopback device (Them) are captured as two
// independent getUserMedia streams, downsampled to the PCM16 mono format Hear
// expects, and pushed over ONE socket with a 1-byte stream tag. The backend runs
// two Hear sessions and, on stop, muxes the pair to stereo for PyAI's
// channel-separated batch pass.
//
// Runs unchanged in the Tauri window and in Chrome (ws://127.0.0.1:8788).

const WS_URL = `ws://127.0.0.1:${(import.meta as any).env?.VITE_MEETING_PORT ?? 8788}`;
const SAMPLE_RATE = 16000;
const TAG: Record<Stream, number> = { me: 0x00, them: 0x01 };

type Stream = "me" | "them";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  micSel: $<HTMLSelectElement>("micDevice"),
  sysSel: $<HTMLSelectElement>("sysDevice"),
  tpl: $<HTMLSelectElement>("template"),
  start: $<HTMLButtonElement>("startBtn"),
  stop: $<HTMLButtonElement>("stopBtn"),
  test: $<HTMLButtonElement>("testBtn"),
  status: $("status"),
  timer: $("timer"),
  meterMe: $("meterMe"),
  meterThem: $("meterThem"),
  transcript: $("transcript"),
  liveMe: $("liveMe"),
  liveThem: $("liveThem"),
  notes: $<HTMLTextAreaElement>("notes"),
  note: $("note"),
  saved: $("saved"),
  savedPath: $("savedPath"),
  reveal: $<HTMLButtonElement>("revealBtn"),
  badge: $("exactBadge"),
};

let ws: WebSocket | null = null;
let recording = false;
let startedAt = 0;
let timerId: number | undefined;
let savedDir = "";
const capture: Partial<Record<Stream, { ctx: AudioContext; stream: MediaStream; node: ScriptProcessorNode }>> = {};

// ── helpers ──────────────────────────────────────────────────────────────────
const setStatus = (t: string, tone: "" | "live" | "warn" | "err" = "") => {
  els.status.textContent = t;
  els.status.className = `status ${tone}`;
};

const mmss = (ms: number) => {
  const t = Math.floor(ms / 1000);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

// ── devices ──────────────────────────────────────────────────────────────────
async function listDevices() {
  // Labels are hidden until permission is granted once.
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch {
    setStatus("Microphone permission denied — grant it in System Settings › Privacy › Microphone.", "err");
  }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  const fill = (sel: HTMLSelectElement, prefer?: RegExp) => {
    sel.innerHTML = "";
    devices.forEach((d) => {
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || `Input ${sel.length + 1}`;
      sel.appendChild(o);
    });
    if (prefer) {
      const hit = devices.find((d) => prefer.test(d.label));
      if (hit) sel.value = hit.deviceId;
    }
  };
  fill(els.micSel, /macbook|built-in|internal|airpods|headset/i);
  fill(els.sysSel, /blackhole|loopback|soundflower|multi-output|aggregate/i);

  if (!devices.some((d) => /blackhole|loopback|soundflower|aggregate/i.test(d.label))) {
    setStatus("No loopback input found — install BlackHole and set output to a Multi-Output Device.", "warn");
  } else {
    setStatus("Ready.");
  }
}

// ── capture ──────────────────────────────────────────────────────────────────
async function openCapture(which: Stream, deviceId: string, onPcm: (b: Uint8Array) => void) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      // All DSP off: AGC/NS/AEC are tuned for a human listener and measurably hurt
      // transcription — and on the loopback device they would mangle the far end.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const src = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but universally available and needs no worklet
  // module — the right trade for a one-file capture path.
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const meter = which === "me" ? els.meterMe : els.meterThem;

  node.onaudioprocess = (ev) => {
    const input = ev.inputBuffer.getChannelData(0);
    const out = new Uint8Array(1 + input.length * 2);
    out[0] = TAG[which];
    const dv = new DataView(out.buffer, 1);
    let peak = 0;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      if (Math.abs(s) > peak) peak = Math.abs(s);
      dv.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    meter.style.width = `${Math.min(100, Math.round(peak * 140))}%`;
    onPcm(out);
  };

  // Route through a silent gain node: the processor only runs when connected, and
  // zero gain guarantees we never feed the loopback back into the speakers.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);

  capture[which] = { ctx, stream, node };
}

function closeCapture() {
  for (const which of ["me", "them"] as Stream[]) {
    const c = capture[which];
    if (!c) continue;
    try { c.node.onaudioprocess = null; c.node.disconnect(); } catch { /* noop */ }
    try { c.stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    try { void c.ctx.close(); } catch { /* noop */ }
    delete capture[which];
  }
  els.meterMe.style.width = "0%";
  els.meterThem.style.width = "0%";
}

// ── transcript rendering ─────────────────────────────────────────────────────
const rows: Array<{ stream: Stream; text: string; atMs: number; speaker?: string }> = [];

function label(r: { stream: Stream; speaker?: string }) {
  if (r.stream === "me") return "Me";
  return r.speaker ? `Speaker ${r.speaker.replace(/^spk_?/i, "")}` : "Them";
}

function renderRows() {
  els.transcript.innerHTML = rows
    .map(
      (r) =>
        `<div class="turn ${r.stream}"><span class="who">${esc(label(r))}</span>` +
        `<span class="at">${mmss(r.atMs)}</span><p>${esc(r.text)}</p></div>`,
    )
    .join("");
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function renderNote(n: any) {
  const list = (title: string, items: string[]) =>
    items?.length ? `<h4>${title}</h4><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "";
  const actions = n.actionItems?.length
    ? `<h4>Action items</h4><ul class="actions">${n.actionItems
        .map(
          (a: any) =>
            `<li><input type="checkbox" disabled />${a.owner ? `<b>${esc(a.owner)}</b> — ` : ""}${esc(a.text)}` +
            `<span class="cite" title="${esc(a.quote)}">${mmss(a.atMs)}</span></li>`,
        )
        .join("")}</ul>`
    : "";
  els.note.innerHTML =
    `<h3>${esc(n.title)}</h3><p class="lede">${esc(n.summary)}</p>` +
    list("Key points", n.keyPoints) +
    list("Decisions", n.decisions) +
    actions +
    list("Open questions", n.openQuestions) +
    list("From your notes", n.fromUserNotes);
  els.note.hidden = false;
}

// ── session ──────────────────────────────────────────────────────────────────
async function start() {
  rows.length = 0;
  renderRows();
  els.note.hidden = true;
  els.saved.hidden = true;
  els.badge.hidden = true;
  els.liveMe.textContent = "";
  els.liveThem.textContent = "";

  ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";

  ws.onopen = async () => {
    ws!.send(JSON.stringify({ type: "start", template: els.tpl.value, language: "en" }));
    try {
      const push = (b: Uint8Array) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(b);
      };
      await openCapture("me", els.micSel.value, push);
      await openCapture("them", els.sysSel.value, push);
    } catch (e: any) {
      setStatus(`Could not open audio: ${e?.message ?? e}`, "err");
      await stop();
      return;
    }
    recording = true;
    startedAt = Date.now();
    els.start.hidden = true;
    els.stop.hidden = false;
    els.test.disabled = true;
    setStatus("Recording", "live");
    timerId = window.setInterval(() => (els.timer.textContent = mmss(Date.now() - startedAt)), 500);
  };

  ws.onmessage = (ev) => {
    let m: any;
    try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case "live": {
        const el = m.stream === "me" ? els.liveMe : els.liveThem;
        el.innerHTML = `<b>${esc(m.stableText ?? "")}</b> <i>${esc(m.activeText ?? "")}</i>`;
        break;
      }
      case "segment":
        rows.push(m.segment);
        renderRows();
        els.liveMe.textContent = "";
        els.liveThem.textContent = "";
        break;
      case "transcript":
        rows.length = 0;
        rows.push(...m.segments);
        renderRows();
        els.badge.hidden = false;
        els.badge.textContent = m.exact ? "Exact speaker separation (per channel)" : "Live transcript (fallback)";
        els.badge.className = `badge ${m.exact ? "ok" : "warn"}`;
        break;
      case "status":
        setStatus(m.detail ? `${m.phase} — ${m.detail}` : `${m.phase}…`);
        break;
      case "note":
        renderNote(m.note);
        break;
      case "saved":
        savedDir = m.dir;
        els.savedPath.textContent = m.dir;
        els.saved.hidden = false;
        break;
      case "error":
        setStatus(m.message, "err");
        break;
      case "done":
        setStatus("Done — saved locally.");
        break;
    }
  };

  ws.onerror = () => setStatus("Backend not reachable on :8788 — is the meetings server running?", "err");
  ws.onclose = () => { if (recording) setStatus("Connection closed.", "warn"); };
}

async function stop() {
  recording = false;
  if (timerId) window.clearInterval(timerId);
  closeCapture();
  els.stop.hidden = true;
  els.start.hidden = false;
  els.test.disabled = false;
  setStatus("Transcribing…");
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop", notes: els.notes.value }));
  }
}

/** Pre-flight: 4 seconds of levels on both streams, nothing sent anywhere. */
async function testLevels() {
  els.test.disabled = true;
  setStatus("Testing levels — talk, and play audio in the call…");
  try {
    await openCapture("me", els.micSel.value, () => {});
    await openCapture("them", els.sysSel.value, () => {});
    setTimeout(() => {
      closeCapture();
      els.test.disabled = false;
      setStatus("Level test finished. Both bars should have moved.");
    }, 4000);
  } catch (e: any) {
    closeCapture();
    els.test.disabled = false;
    setStatus(`Level test failed: ${e?.message ?? e}`, "err");
  }
}

// Keep the backend's copy of the notes current, so a crash mid-meeting still has them.
let noteTimer: number | undefined;
els.notes.addEventListener("input", () => {
  if (noteTimer) window.clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "note", notes: els.notes.value }));
  }, 600);
});

els.start.addEventListener("click", () => void start());
els.stop.addEventListener("click", () => void stop());
els.test.addEventListener("click", () => void testLevels());
els.reveal.addEventListener("click", () => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "reveal", dir: savedDir }));
});

void listDevices();
