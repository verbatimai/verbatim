// M2 dev bridge — ROBUST model:
//  - LIVE preview: forward Hear's CURRENT window as-is (rolling, no reconstruction),
//    so the input never stacks/duplicates.
//  - FINAL output: on stop, batch-transcribe the full buffered audio (one clean
//    transcript), then run cleanup (diff) + formatting. The authoritative result
//    never depends on reconstructing the messy live stream.
// `mode:"demo"` uses fixture STT + mock correction (no key, no mic); its "batch"
// falls back to the last streamed window (the fixture is a clean single utterance).
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { getSTTProvider, getCorrectionProvider, TranscriptAccumulator, localFormat, type STTSession, type STTProvider, type CorrectionProvider } from "@open-dictation/core";

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
        send(ws, { type: "error", message: "batch transcribe: " + (e?.message ?? e) });
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
        send(ws, { type: "error", message: "cleanup failed: " + (e?.message ?? String(e)) });
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
          send(ws, { type: "error", message: "format failed (used local fallback): " + (e?.message ?? String(e)) });
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
      const sttId = demo ? "fixture" : DEFAULT_STT;
      const corrId = demo ? "mock" : DEFAULT_CORR;
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
        session.onError((err) => send(ws, { type: "error", message: err.message }));
        session.onClose(() => { void finalize(); }); // demo/fixture self-closes -> finalize
      } catch (e: any) {
        send(ws, { type: "error", message: e?.message ?? String(e) });
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
