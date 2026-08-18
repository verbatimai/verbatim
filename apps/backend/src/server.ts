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
import { getSTTProvider, getCorrectionProvider, getIntentProvider, assertIntentKeys, getTtsProvider, TranscriptAccumulator, localFormat, expandSnippets, Telemetry, startReconnectingSession, type STTSession, type STTProvider, type CorrectionProvider, type Snippet, type FormatMode } from "@verbatim/core";

// ── Complete PyAI error log ───────────────────────────────────────────────────
// The widget's banner truncates long responses (e.g. a 401 HTML body), so every raw
// PyAI/provider error is appended here IN FULL — status, message, stack, any extra
// fields — for easy copy-paste reporting. Path is printed at startup and sent to the
// widget; override with PYAI_LOG_FILE.
const LOG_FILE = process.env.PYAI_LOG_FILE ?? resolve(process.cwd(), "logs", "errors.log");

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
// PyAI was removed as a correction vendor (packages/core/src/correction/registry.ts) —
// it stays the STT + TTS default, but correction now defaults to openai.
const DEFAULT_CORR = process.env.CORRECTION_PROVIDER ?? "openai";
// P3 — wake-word spoken greeting. TTS is its own vendor-agnostic role (text -> audio),
// independent of the correction vendor; PyAI stays the default (it already offers STT +
// TTS — see packages/core/src/tts/pyai.ts's [verify] note on the exact endpoint).
const DEFAULT_TTS = process.env.TTS_PROVIDER ?? "pyai";
// Settings §1.4 — Debug mode. The Rust host injects HEAR_DEBUG=1 into this sidecar's env
// when the Settings "Debug mode" toggle is on (and restarts us so it takes effect). Gate
// the verbose lines below on it. NEVER log a secret/API-key value, even in debug.
const DEBUG = process.env.HEAR_DEBUG === "1";
const dbg = (...args: unknown[]) => { if (DEBUG) console.log("[hear]", ...args); };
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
  dbg("ws connection opened");
  let session: STTSession | null = null;
  let stt: STTProvider | null = null;
  let correction: CorrectionProvider | null = null;
  let apiKey: string | undefined;
  let demo = false;
  let sttId = "";   // remembered on start so finalize()/error logs know the providers
  let corrId = "";
  // Platform P1 — command mode. `isCommand` gates finalize() onto the intent branch (skip
  // correction/format entirely); `cmdId` is the resolved classifier vendor; `commandModel`
  // is the optional per-session model override ("" ⇒ undefined ⇒ adapter default).
  let isCommand = false;
  let cmdId = "";
  let commandModel: string | undefined;
  let doCorrect = true; // 2.2 — self-correction toggle (parsed on `start`; !== false => on)
  let doFormat = true;  // 2.3 — formatting toggle (parsed on `start`; !== false => on)
  let langTag = "en";   // 3.4 — language tag, forwarded into the format prompt
  let autoDetect = false; // 3.2 — auto-detect language (Deepgram/OpenAI streaming)
  let vocabulary: string[] = []; // 3.4 — custom terms → format prompt (+ Deepgram keyword boost)
  let sttModel: string | undefined;  // Phase 7 — STT model override ("" ⇒ undefined ⇒ default)
  let corrModel: string | undefined; // Phase 7 — correction model override ("" ⇒ undefined ⇒ default)
  let snippets: Snippet[] = [];  // 3.5 — deterministic trigger→expansion on the final text
  let formatMode: FormatMode | undefined; // 5.3 — prose | message | code | raw ("raw" skips format)
  // 5.6 — per-session latency capture (ms) for the telemetry session_finalize event.
  let sttLatencyMs: number | undefined;
  let correctionLatencyMs: number | undefined;
  let formatLatencyMs: number | undefined;
  // 3.3 — one telemetry emitter per connection. Default NoopSink (transport PARKED),
  // enabled from the start frame. METADATA ONLY — never transcript/audio content.
  let telemetry = new Telemetry({ enabled: false });
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
        dbg("batch transcribe:", pcm.length, "bytes");
        // Phase 7 — thread the STT model override + (Fix 2) the vocabulary as the
        // Deepgram keyword boost on the AUTHORITATIVE batch path (other adapters ignore both).
        const tBatch = Date.now();
        raw = norm(await stt.transcribeBatch(pcm, { apiKey: apiKey ?? "", sampleRate: 16000, language: langTag, detectLanguage: autoDetect, model: sttModel, keywords: vocabulary }));
        sttLatencyMs = Date.now() - tBatch; // 5.6 — batch STT latency
      } catch (e: any) {
        logPyaiError("stt.transcribeBatch", e, { sttId, bytes: audio.reduce((n, c) => n + c.length, 0) });
        telemetry.emit({ type: "error", errorPhase: "stt.transcribeBatch", sttProvider: sttId });
        send(ws, { type: "error", kind: "terminal", message: "batch transcribe: " + (e?.message ?? e), file: LOG_FILE });
      }
    }
    raw = norm(raw);
    // Platform P1 — command mode: classify the utterance into ONE structured editing
    // intent and hand it back. No cleanup/format pass (correction was never constructed).
    // Runs BEFORE the correction block; the deterministic Rust executor performs the edit.
    if (isCommand) {
      let intent: any = { action: "noop", reason: "classify failed" };
      try {
        const provider = getIntentProvider(cmdId);
        assertIntentKeys(provider); // missing key → clear error, no network round-trip
        ({ intent } = await provider.interpret(raw, { model: commandModel }));
        send(ws, { type: "intent", intent, transcript: raw });
      } catch (e: any) {
        logPyaiError("command.interpret", e, { cmdId, rawLen: raw.length });
        telemetry.emit({ type: "error", errorPhase: "command.interpret", correctionProvider: cmdId });
        send(ws, { type: "error", kind: "terminal", message: "command classify failed: " + (e?.message ?? String(e)), file: LOG_FILE });
      }
      try { session?.close(); } catch {}
      // P1c — "rewrite" needs the FOCUSED FIELD'S SELECTED TEXT, which only the Rust/AX
      // side can read. Keep this connection open (skip "done") and wait for the client's
      // "rewrite" message below instead of closing the loop here; the client closes the
      // socket itself if it can't get a selection to rewrite (see main.ts runRewriteIntent).
      if (intent.action === "rewrite") return;
      send(ws, { type: "done" });
      return;
    }
    if (raw && correction) {
      // 1) Cleanup -> drives the "what was removed" diff. If it fails, we keep
      //    going with the raw transcript as the clean text (no diff shown).
      //    2.2 — when self-correction is toggled off, skip the pass entirely: no
      //    correct() call, no `correction` message, cleanText = raw (STT-only).
      let cleanText = raw;
      if (doCorrect) {
        try {
          // 3.4 — vocabulary carried for parity (correction forbids re-spelling; harmless).
          const result = await correction.correct(raw, { language: langTag, vocabulary, model: corrModel });
          correctionLatencyMs = result.latencyMs; // 5.6 — correction pass latency
          cleanText = norm(result.cleanText) || raw;
          send(ws, { type: "correction", raw, cleanText, ops: result.ops, valid: result.valid });
        } catch (e: any) {
          logPyaiError("correction.cleanup", e, { corrId, rawLen: raw.length });
          telemetry.emit({ type: "error", errorPhase: "correction.cleanup", correctionProvider: corrId });
          send(ws, { type: "error", kind: "terminal", message: "cleanup failed: " + (e?.message ?? String(e)), file: LOG_FILE });
        }
      }
      // 2) Formatting -> the final inserted text. GUARANTEED to be at least the
      //    cleaned text: if the LLM formatter fails (PyAI flaky under load), fall
      //    back to a deterministic local formatter — never to the raw transcript.
      //    Do NOT norm() here: formatted output may contain intentional newlines.
      //    2.3 — when formatting is toggled off, skip BOTH the LLM formatter AND the
      //    localFormat fallback: finalText = cleanText (unformatted / raw-clean).
      // 5.3 — "raw" mode skips the format pass entirely (cleanup-only), like doFormat off.
      const doFormatEff = doFormat && formatMode !== "raw";
      let finalText = cleanText;
      if (doFormatEff) {
        if (correction.format) {
          try {
            // 3.4 — vocabulary is the effective prompt-side lever; 5.3 — mode selects the prompt.
            const tFmt = Date.now();
            finalText = (await correction.format(cleanText, langTag, vocabulary, corrModel, formatMode)).text.trim() || cleanText;
            formatLatencyMs = Date.now() - tFmt; // 5.6 — format pass latency
          } catch (e: any) {
            logPyaiError("correction.format", e, { corrId, cleanLen: cleanText.length });
            telemetry.emit({ type: "error", errorPhase: "correction.format", correctionProvider: corrId });
            send(ws, { type: "error", kind: "transient", message: "format failed (used local fallback): " + (e?.message ?? String(e)), file: LOG_FILE });
            finalText = localFormat(cleanText);
          }
        } else {
          finalText = localFormat(cleanText);
        }
      }
      // 3.5 — deterministic snippet expansion on the FINAL text (after formatting), so the
      // expansion is inserted verbatim and isn't re-punctuated. No-op when the list is empty.
      if (snippets.length) finalText = expandSnippets(finalText, snippets);
      dbg("formatted:", finalText.length, "chars");
      // 3.3 — metadata only (character COUNTS, never text): provider ids + lengths.
      telemetry.emit({
        type: "session_finalize",
        sttProvider: sttId,
        correctionProvider: corrId,
        language: langTag,
        autoDetect,
        correct: doCorrect,
        format: doFormat,
        rawLen: raw.length,
        cleanLen: finalText.length,
        // 5.6 — latency metadata (ms), only when measured this session.
        ...(sttLatencyMs !== undefined ? { sttLatencyMs } : {}),
        ...(correctionLatencyMs !== undefined ? { correctionLatencyMs } : {}),
        ...(formatLatencyMs !== undefined ? { formatLatencyMs } : {}),
      });
      send(ws, { type: "formatted", text: finalText });
    }
    try { session?.close(); } catch {}
    send(ws, { type: "done" });
  };

  ws.on("message", async (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      if (finalizing) return; // 5.5 — audio after stop/during finalize is ignored, not buffered
      session?.sendAudio(data);
      if (!demo) audio.push(new Uint8Array(data));
      return;
    }
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === "start") {
      // 5.5 — concurrency contract: never interleave two sessions on one connection.
      // A start arriving mid-finalize is rejected (transient) rather than racing.
      if (finalizing) { send(ws, { type: "error", kind: "transient", message: "Still finalizing the previous dictation — try again in a moment." }); return; }
      finalizing = false;
      sttLatencyMs = correctionLatencyMs = formatLatencyMs = undefined; // 5.6 — reset per session
      audio.length = 0;
      acc = new TranscriptAccumulator();
      demo = msg.mode === "demo";
      // Platform P1 — command mode is a full audio-capture session (live preview + batch
      // STT on stop), differing from dictation only in the finalize branch.
      isCommand = msg.mode === "command";
      // Provider selection comes from the widget's config (Phase 4.8); env is the fallback.
      sttId = demo ? "fixture" : (msg.sttProvider ?? DEFAULT_STT);
      corrId = demo ? "mock" : (msg.correctionProvider ?? DEFAULT_CORR);
      // P1 (finding 4) — resolve the classifier vendor: explicit commandProvider, else
      // follow the correction vendor, else the env default. "" ("follow correction") must
      // NOT reach getIntentProvider("") (which throws), so resolve it to a real id here.
      cmdId = (msg.commandProvider && String(msg.commandProvider).trim()) || msg.correctionProvider || DEFAULT_CORR;
      commandModel = typeof msg.commandModel === "string" && msg.commandModel.trim() ? msg.commandModel : undefined;
      const language = typeof msg.language === "string" && msg.language ? msg.language : "en";
      langTag = language;
      // 2.2 / 2.3 — behaviour toggles from the widget config; undefined (old/demo client) => on.
      doCorrect = msg.correct !== false;
      doFormat = msg.format !== false;
      // 3.2 / 3.4 / 3.5 — new runtime data on the start frame (store-agnostic backend).
      autoDetect = msg.autoDetect === true;
      vocabulary = Array.isArray(msg.vocabulary) ? msg.vocabulary.filter((t: unknown) => typeof t === "string") : [];
      // Phase 7 — per-session model overrides. Empty/whitespace ⇒ undefined so the
      // adapter falls through to its env var then its default (empty never overrides).
      sttModel  = typeof msg.sttModel === "string"        && msg.sttModel.trim()        ? msg.sttModel        : undefined;
      corrModel = typeof msg.correctionModel === "string" && msg.correctionModel.trim() ? msg.correctionModel : undefined;
      snippets = Array.isArray(msg.snippets)
        ? msg.snippets.filter((s: any) => s && typeof s.trigger === "string" && typeof s.expansion === "string")
        : [];
      // 5.3 — formatting mode from the widget config; unknown/undefined ⇒ default (prose).
      formatMode = (["prose", "message", "code", "raw"] as const).includes(msg.formatMode) ? msg.formatMode : undefined;
      // 3.3 — telemetry gate: NoopSink default (transport PARKED), enabled only when the
      // config flag rode the start frame. Never emit before this is read.
      telemetry = new Telemetry({ enabled: msg.telemetry === true });
      try {
        stt = getSTTProvider(sttId);
        // P1 — command mode skips the correction pass entirely: don't construct a
        // correction provider (the classifier runs in finalize()). The STT session still
        // opens below exactly as dictation, so live capture + batch-on-stop are identical.
        if (isCommand) {
          correction = null;
        } else {
          // A bad correction vendor in the config must NOT kill the STT/live session —
          // fall back to the default and warn, so the live input preview still works even
          // if the selected correction provider is invalid (e.g. a stale "deepgram").
          try {
            correction = getCorrectionProvider(corrId);
          } catch (e: any) {
            send(ws, { type: "error", message: `Correction '${corrId}' is invalid — using ${DEFAULT_CORR}. Fix it in Settings (⚙). (${e?.message ?? e})` });
            corrId = DEFAULT_CORR;
            correction = getCorrectionProvider(corrId);
          }
        }
        // Keys come ONLY from process.env — injected by the Rust host from the OS Keychain
        // (Phase 4.8), or a repo .env in standalone dev. The webview never sends a secret.
        apiKey = stt.requiredKeys[0] ? process.env[stt.requiredKeys[0]] : undefined;
        if (stt.requiredKeys.length && !apiKey) {
          send(ws, { type: "error", message: `Live mode needs ${stt.requiredKeys.join(", ")}. Add it in Settings (⚙), or a repo .env, or use Demo mode.` });
          return;
        }
        if (sttId === "nemotron") {
          send(ws, { type: "status", phase: "stt", state: "local-asr" });
        }
        send(ws, { type: "ready", stt: sttId, correction: corrId });
        // 3.3 — session_start metadata (no content). NoopSink unless telemetry enabled.
        telemetry.emit({ type: "session_start", sttProvider: sttId, correctionProvider: corrId, language, autoDetect, correct: doCorrect, format: doFormat });
        console.log(`[backend] session start: stt=${sttId} correction=${corrId} lang=${language} demo=${demo} mode=${msg.mode}`);
        // 3.2 — forward auto-detect to the streaming adapter; 3.4 — vocabulary as the
        // Deepgram-only keyword boost (other adapters ignore `keywords`).
        const sttCfg = { apiKey: apiKey ?? "", language, detectLanguage: autoDetect, keywords: vocabulary, model: sttModel };
        // 5.1 — live sessions auto-reconnect on a dropped socket (preview stays alive; the
        // backend keeps buffering audio for the authoritative batch-on-stop). Demo/fixture
        // keeps the direct session (it self-closes at end-of-fixture to trigger finalize).
        session = demo
          ? await stt.startSession(sttCfg)
          : await startReconnectingSession(stt, sttCfg, {
              onStatus: (state) => send(ws, { type: "status", phase: "stt", state }),
            });
        session.onTranscript((e) => {
          // Growing live display via the accumulator (utterance-scoped: committed
          // finals + current utterance's live text). Authoritative final still
          // comes from batch transcription on stop (below).
          const { transcript, active } = acc.push(e);
          dbg("live:", JSON.stringify({ active, len: transcript.length }));
          send(ws, { type: "live", transcript, active });
        });
        session.onError((err) => {
          logPyaiError("stt.stream", err, { sttId });
          telemetry.emit({ type: "error", errorPhase: "stt.stream", sttProvider: sttId });
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
    } else if (msg.type === "rewrite") {
      // P1c — the second half of the "rewrite" round trip: the client read the field's
      // current SELECTION via Rust/AX and sends it here with the classified instruction.
      // Runs ONE LLM call using the SAME correction vendor/model already selected for
      // dictation (corrId/corrModel, resolved on "start") — no separate provider concept,
      // per the design: "use the model that is selected as the correction provider".
      const text = typeof msg.text === "string" ? msg.text : "";
      const instruction = typeof msg.instruction === "string" ? msg.instruction : "";
      let rewritten = "";
      if (text.trim() && instruction.trim()) {
        try {
          const rewriter = getCorrectionProvider(corrId);
          if (!rewriter.rewrite) throw new Error(`correction provider '${corrId}' does not support rewrite`);
          const tRw = Date.now();
          const result = await rewriter.rewrite(text, instruction, corrModel);
          rewritten = norm(result.text) ? result.text : text; // never hand back an empty rewrite
          telemetry.emit({ type: "session_finalize", sttProvider: sttId, correctionProvider: corrId, language: langTag, autoDetect, correct: false, format: false, rawLen: text.length, cleanLen: rewritten.length, correctionLatencyMs: Date.now() - tRw });
        } catch (e: any) {
          logPyaiError("command.rewrite", e, { corrId, textLen: text.length });
          telemetry.emit({ type: "error", errorPhase: "command.rewrite", correctionProvider: corrId });
          send(ws, { type: "error", kind: "terminal", message: "rewrite failed: " + (e?.message ?? String(e)), file: LOG_FILE });
        }
      }
      send(ws, { type: "rewritten", text: rewritten });
      send(ws, { type: "done" });
    } else if (msg.type === "speak") {
      // P3 — wake-word spoken reply (hardcoded greeting for now, see main.ts's
      // playWakeGreeting). STANDALONE: unlike every other branch above, this never
      // requires a prior "start" — the greeting fires on its own short-lived connection,
      // separate from the dictation/command session's socket, so `session`/`correction`
      // may still be null here. TTS is its OWN vendor-agnostic role (text -> audio), not
      // folded into the correction provider — "which vendor cleans up text" and "which
      // vendor can speak" are independent choices, mirroring the STT/correction split.
      const text = typeof msg.text === "string" ? msg.text.trim() : "";
      const ttsId = (typeof msg.provider === "string" && msg.provider.trim()) || DEFAULT_TTS;
      if (!text) {
        send(ws, { type: "error", kind: "terminal", message: "speak: no text given" });
        return;
      }
      try {
        const tts = getTtsProvider(ttsId);
        const key = tts.requiredKeys[0] ? process.env[tts.requiredKeys[0]] : undefined;
        if (tts.requiredKeys.length && !key) {
          send(ws, { type: "error", kind: "terminal", message: `Speak needs ${tts.requiredKeys.join(", ")}. Add it in Settings (⚙).` });
          return;
        }
        const result = await tts.synthesize(text);
        send(ws, { type: "spoken", audio: Buffer.from(result.audio).toString("base64"), mime: result.mime });
      } catch (e: any) {
        logPyaiError("tts.speak", e, { ttsId, textLen: text.length });
        send(ws, { type: "error", kind: "terminal", message: "speak failed: " + (e?.message ?? String(e)), file: LOG_FILE });
      }
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
console.log(`[backend] live defaults: stt=${DEFAULT_STT} correction=${DEFAULT_CORR} tts=${DEFAULT_TTS}`);
console.log(`[backend] PYAI_API_KEY=${process.env.PYAI_API_KEY ? "set" : "MISSING"}  (Demo mode needs no key)`);
console.log(`[backend] PyAI error log: ${LOG_FILE}`);
if (DEBUG) console.log(`[backend] HEAR_DEBUG=1 — verbose [hear] logging ON`);
