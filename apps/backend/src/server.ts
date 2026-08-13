// M2 dev bridge — ROBUST model:
//  - LIVE preview: forward Hear's CURRENT window as-is (rolling, no reconstruction),
//    so the input never stacks/duplicates.
//  - FINAL output: on stop, batch-transcribe the full buffered audio (one clean
//    transcript), then run cleanup (diff) + formatting. The authoritative result
//    never depends on reconstructing the messy live stream.
// `mode:"demo"` uses fixture STT + mock correction (no key, no mic); its "batch"
// falls back to the last streamed window (the fixture is a clean single utterance).
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { getSTTProvider, getCorrectionProvider, TranscriptAccumulator, localFormat, type STTSession, type STTProvider, type CorrectionProvider } from "@verbatim/core";

// ── Complete PyAI error log ───────────────────────────────────────────────────
// The widget's banner truncates long responses (e.g. a 401 HTML body), so every raw
// PyAI/provider error is appended here IN FULL — status, message, stack, any extra
// fields — for easy copy-paste reporting. Path is printed at startup and sent to the
// widget; override with PYAI_LOG_FILE.
const LOG_FILE = process.env.PYAI_LOG_FILE ?? resolve(process.cwd(), "logs", "pyai-errors.log");

function serializeErr(e: any): Record<string, unknown> {
  if (e instanceof Error) {
    const o: Record<string, unknown> = { name: e.name, message: e.message, stack: e.stack };
    // Capture non-standard fields adapters may attach (status, body, response, cause…).
    for (const k of Object.getOwnPropertyNames(e)) if (!(k in o)) o[k] = (e as any)[k];
    return o;
  }
  try { return { message: String(e), value: JSON.parse(JSON.stringify(e)) }; }
  catch { return { message: String(e) }; }
}

function logPyaiError(phase: string, e: any, extra: Record<string, unknown> = {}) {
  const ts = new Date().toISOString();
  const det = serializeErr(e);
  const block =
    `\n──────── ${ts} · ${phase} ────────\n` +
    `message: ${det.message ?? ""}\n` +
    (Object.keys(extra).length ? `context: ${JSON.stringify(extra)}\n` : "") +
    `detail: ${JSON.stringify(det, null, 2)}\n`;
  // Logging must never crash a dictation session.
  try { mkdirSync(dirname(LOG_FILE), { recursive: true }); appendFileSync(LOG_FILE, block); } catch { /* ignore */ }
  console.error(`[backend] PyAI error (${phase}) — full detail logged to ${LOG_FILE}\n  ${det.message ?? det}`);
}

function loadEnv() {
  for (const dir of [".", "..", "../..", "../../.."]) {
    const p = resolve(process.cwd(), dir, ".env");
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
      if (m && process.env[m[1]] === undefined) {
        let val = m[2].trim();
        if (!/^["']/.test(val)) val = val.replace(/\s+#.*$/, "").trim();
        process.env[m[1]] = val.replace(/^["']|["']$/g, "");
      }
    }
    console.log(`[backend] loaded env from ${p}`);
    return;
  }
}
loadEnv();

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const DEFAULT_STT = process.env.STT_PROVIDER ?? "pyai";
const DEFAULT_CORR = process.env.CORRECTION_PROVIDER ?? "pyai";
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const send = (ws: WebSocket, obj: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

let wss: WebSocketServer;
try {
  wss = new WebSocketServer({ port: PORT, host: HOST });
} catch (e: any) {
  console.error(`[backend] failed to start: ${e?.message ?? e}`);
  process.exit(1);
}
wss.on("error", (e: any) => {
  console.error(e?.code === "EADDRINUSE" ? `[backend] port ${PORT} already in use. Stop it or set PORT.` : `[backend] ${e?.message ?? e}`);
  process.exit(1);
});

wss.on("connection", (ws) => {
  let session: STTSession | null = null;
  let stt: STTProvider | null = null;
  let correction: CorrectionProvider | null = null;
  let apiKey: string | undefined;
  let demo = false;
  let sttId = "";   // remembered on start so finalize()/error logs know the providers
  let corrId = "";
  const audio: Uint8Array[] = []; // buffered PCM (live only)
  let acc = new TranscriptAccumulator(); // growing live-display transcript
  let finalizing = false;

  const finalize = async () => {
    if (finalizing) return;
    finalizing = true;
    // Authoritative final = batch transcription of the full audio (live). Demo /
    // no-batch falls back to the accumulated display transcript.
    let raw = acc.final();
    if (!demo && stt?.transcribeBatch && audio.length) {
      try {
        const pcm = concat(audio);
        raw = norm(await stt.transcribeBatch(pcm, { apiKey: apiKey ?? "", sampleRate: 16000 }));
      } catch (e: any) {
        logPyaiError("stt.transcribeBatch", e, { sttId, bytes: audio.reduce((n, c) => n + c.length, 0) });
        send(ws, { type: "error", message: "batch transcribe: " + (e?.message ?? e), file: LOG_FILE });
      }
    }
    raw = norm(raw);
    if (raw && correction) {
      // 1) Cleanup -> drives the "what was removed" diff. If it fails, we keep
      //    going with the raw transcript as the clean text (no diff shown).
      let cleanText = raw;
      try {
        const result = await correction.correct(raw);
        cleanText = norm(result.cleanText) || raw;
        send(ws, { type: "correction", raw, cleanText, ops: result.ops, valid: result.valid });
      } catch (e: any) {
        logPyaiError("correction.cleanup", e, { corrId, rawLen: raw.length });
        send(ws, { type: "error", message: "cleanup failed: " + (e?.message ?? String(e)), file: LOG_FILE });
      }
      // 2) Formatting -> the final inserted text. GUARANTEED to be at least the
      //    cleaned text: if the LLM formatter fails (PyAI flaky under load), fall
      //    back to a deterministic local formatter — never to the raw transcript.
      //    Do NOT norm() here: formatted output may contain intentional newlines.
      let finalText = cleanText;
      if (correction.format) {
        try {
          finalText = (await correction.format(cleanText)).text.trim() || cleanText;
        } catch (e: any) {
          logPyaiError("correction.format", e, { corrId, cleanLen: cleanText.length });
          send(ws, { type: "error", message: "format failed (used local fallback): " + (e?.message ?? String(e)), file: LOG_FILE });
          finalText = localFormat(cleanText);
        }
      } else {
        finalText = localFormat(cleanText);
      }
      send(ws, { type: "formatted", text: finalText });
    }
    try { session?.close(); } catch {}
    send(ws, { type: "done" });
  };

  ws.on("message", async (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      session?.sendAudio(data);
      if (!demo) audio.push(new Uint8Array(data));
      return;
    }
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === "start") {
      finalizing = false;
      audio.length = 0;
      acc = new TranscriptAccumulator();
      demo = msg.mode === "demo";
      sttId = demo ? "fixture" : DEFAULT_STT;
      corrId = demo ? "mock" : DEFAULT_CORR;
      try {
        stt = getSTTProvider(sttId);
        correction = getCorrectionProvider(corrId);
        // BYOK: a key sent by the widget (from the OS keychain) takes precedence over .env.
        // Set it into the process env so every provider/adapter that reads env picks it up.
        if (!demo && msg.apiKey && stt.requiredKeys[0]) {
          process.env[stt.requiredKeys[0]] = String(msg.apiKey);
        }
        apiKey = stt.requiredKeys[0] ? process.env[stt.requiredKeys[0]] : undefined;
        if (stt.requiredKeys.length && !apiKey) {
          send(ws, { type: "error", message: `Live mode needs ${stt.requiredKeys.join(", ")}. Add it in the widget's Settings (⚙), or a repo .env, or use Demo mode.` });
          return;
        }
        send(ws, { type: "ready", stt: sttId, correction: corrId });
        console.log(`[backend] session start: stt=${sttId} correction=${corrId} demo=${demo}`);
        session = await stt.startSession({ apiKey: apiKey ?? "" });
        session.onTranscript((e) => {
          // Growing live display via the accumulator (utterance-scoped: committed
          // finals + current utterance's live text). Authoritative final still
          // comes from batch transcription on stop (below).
          const { transcript, active } = acc.push(e);
          send(ws, { type: "live", transcript, active });
        });
        session.onError((err) => {
          logPyaiError("stt.stream", err, { sttId });
          send(ws, { type: "error", message: err.message, file: LOG_FILE });
        });
        session.onClose(() => { void finalize(); }); // demo/fixture self-closes -> finalize
      } catch (e: any) {
        logPyaiError("session.start", e, { sttId, corrId });
        send(ws, { type: "error", message: e?.message ?? String(e), file: LOG_FILE });
      }
    } else if (msg.type === "stop") {
      await session?.finalize().catch(() => {});
      await finalize();
    }
  });

  ws.on("close", () => { try { session?.close(); } catch {} });
});

function concat(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

console.log(`[backend] listening on ws://${HOST}:${PORT}  (browser connects via the web app's /ws proxy)`);
console.log(`[backend] live defaults: stt=${DEFAULT_STT} correction=${DEFAULT_CORR}`);
console.log(`[backend] PYAI_API_KEY=${process.env.PYAI_API_KEY ? "set" : "MISSING"}  (Demo mode needs no key)`);
console.log(`[backend] PyAI error log: ${LOG_FILE}`);
