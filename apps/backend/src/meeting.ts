// Meetings backend — a SEPARATE WebSocket server (default :8788) so the dictation
// path in server.ts is untouched. If anything here misbehaves during the demo,
// dictation keeps working; the two share nothing but @verbatim/core.
//
// Wire protocol
//   client -> server
//     text   {"type":"start", template?, language?, summaryModel?}
//     binary <1 byte stream tag><PCM16LE frame>     tag 0x00 = me (mic), 0x01 = them (system)
//     text   {"type":"note", notes}                 live note sync (kept for finalize)
//     text   {"type":"stop", notes?}
//   server -> client
//     {type:"ready"}
//     {type:"live", stream, text, stableText, activeText}
//     {type:"segment", segment}                     a finalized utterance was appended
//     {type:"status", phase, detail?}
//     {type:"transcript", segments, exact}          final transcript (exact = channel-separated)
//     {type:"note", note}
//     {type:"saved", dir, markdown, json}
//     {type:"error", message}
//     {type:"done"}

import { WebSocketServer, WebSocket } from "ws";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  getSTTProvider,
  getSummarizer,
  MeetingTranscript,
  PyAiTranscriptionJobs,
  concatPcm,
  interleaveStereo,
  renderMarkdown,
  templateById,
  type MeetingSession,
  type SpeakerStream,
  type STTSession,
  type TranscriptSegment,
} from "@verbatim/core";

const PORT = Number(process.env.MEETING_PORT ?? 8788);
const HOST = process.env.HOST ?? "127.0.0.1";
const DEBUG = process.env.HEAR_DEBUG === "1";
const dbg = (...a: unknown[]) => { if (DEBUG) console.log("[meeting]", ...a); };

const send = (ws: WebSocket, o: unknown) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
};

/** Where meetings live on disk. Local-first: nothing else ever sees these. */
export function meetingsRoot(): string {
  return process.env.VERBATIM_MEETINGS_DIR ?? join(homedir(), "Documents", "Verbatim", "Meetings");
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "meeting";

interface StreamState {
  session?: STTSession;
  pcm: Uint8Array[];
  /** Latest partial, so a stream that never emits `final` still contributes on stop. */
  pending: string;
  pendingAt: number;
}

export function startMeetingServer(): WebSocketServer {
  const wss = new WebSocketServer({ host: HOST, port: PORT });
  console.log(`[meeting] ws://${HOST}:${PORT}  → ${meetingsRoot()}`);

  wss.on("connection", (ws) => {
    const startedAtMs = Date.now();
    const transcript = new MeetingTranscript(startedAtMs);
    const streams: Record<SpeakerStream, StreamState> = {
      me: { pcm: [], pending: "", pendingAt: 0 },
      them: { pcm: [], pending: "", pendingAt: 0 },
    };
    let notes = "";
    let templateId = "general";
    let language = "en";
    let summaryModel: string | undefined;
    let sampleRate = 16000;
    let finished = false;

    const openStream = async (which: SpeakerStream, apiKey: string) => {
      const stt = getSTTProvider("pyai");
      sampleRate = stt.audio.sampleRate;
      const s = await stt.startSession({ apiKey, language });
      s.onTranscript((e) => {
        const st = streams[which];
        if (e.type === "final" || e.endpoint) {
          const seg = transcript.push(which, e.text, { atMs: e.tMs ?? Date.now() - startedAtMs });
          st.pending = "";
          if (seg) send(ws, { type: "segment", segment: seg });
        } else {
          st.pending = e.text;
          st.pendingAt = e.tMs ?? Date.now() - startedAtMs;
        }
        send(ws, {
          type: "live",
          stream: which,
          text: e.text,
          stableText: e.stableText,
          activeText: e.activeText,
        });
      });
      s.onError((err) => {
        console.error(`[meeting] ${which} stt error:`, err?.message ?? err);
        send(ws, { type: "error", message: `${which} transcription: ${err?.message ?? err}` });
      });
      streams[which].session = s;
    };

    /**
     * Flush any un-finalized partial so a stream that never emitted `final` (short
     * clip, no VAD endpoint) still lands in the transcript.
     */
    const drainPending = () => {
      for (const which of ["me", "them"] as SpeakerStream[]) {
        const st = streams[which];
        if (st.pending.trim()) {
          const seg = transcript.push(which, st.pending, { atMs: st.pendingAt });
          if (seg) send(ws, { type: "segment", segment: seg });
          st.pending = "";
        }
      }
    };

    const finalize = async () => {
      if (finished) return;
      finished = true;

      for (const which of ["me", "them"] as SpeakerStream[]) {
        try { await streams[which].session?.finalize(); } catch { /* F10: close also flushes */ }
      }
      await new Promise((r) => setTimeout(r, 400)); // let trailing finals arrive
      for (const which of ["me", "them"] as SpeakerStream[]) {
        try { streams[which].session?.close(); } catch { /* already gone */ }
      }
      drainPending();

      // ── Authoritative transcript: stereo → PyAI jobs with channel:true ──
      // Exact, model-free Me/Them separation. If it fails for ANY reason we keep the
      // live transcript — degraded (stream-level labels) but never empty.
      let segments: TranscriptSegment[] = transcript.all();
      let exact = false;
      const key = process.env.PYAI_API_KEY;
      const haveAudio = streams.me.pcm.length > 0 || streams.them.pcm.length > 0;
      if (key && haveAudio) {
        try {
          send(ws, { type: "status", phase: "transcribing", detail: "speaker separation" });
          const stereo = interleaveStereo(concatPcm(streams.me.pcm), concatPcm(streams.them.pcm));
          const res = await new PyAiTranscriptionJobs(key).transcribeStereo(stereo, {
            sampleRate,
            numerals: true,
            model: process.env.PYAI_JOBS_MODEL || undefined,
          });
          if (res.segments.length) {
            segments = res.segments;
            exact = true;
            dbg(`jobs ok: ${res.segments.length} segments, ${res.speakers} speakers, ${res.latencyMs}ms`);
          }
        } catch (e: any) {
          console.warn("[meeting] jobs pass failed, using live transcript:", e?.message ?? e);
          send(ws, { type: "status", phase: "transcribing", detail: "fell back to live transcript" });
        }
      }
      send(ws, { type: "transcript", segments, exact });

      // ── The note ──
      const session: MeetingSession = {
        id: `${startedAtMs}`,
        startedAt: new Date(startedAtMs).toISOString(),
        durationMs: Date.now() - startedAtMs,
        title: "Meeting",
        segments,
        notes,
        templateId,
        sttProvider: exact ? "pyai (channel-separated)" : "pyai (live)",
        summaryProvider: "openai",
      };
      if (!segments.length && !notes.trim()) {
        send(ws, { type: "error", message: "Nothing was captured — no audio reached either stream." });
      } else {
        try {
          send(ws, { type: "status", phase: "summarizing" });
          session.note = await getSummarizer("openai").summarize(
            { segments, notes },
            { template: templateById(templateId), language, model: summaryModel },
          );
          session.title = session.note.title;
          send(ws, { type: "note", note: session.note });
        } catch (e: any) {
          console.error("[meeting] summarize failed:", e?.message ?? e);
          send(ws, { type: "error", message: `Note generation failed: ${e?.message ?? e}` });
        }
      }

      // ── Local-first: write it to disk, always, even if the note failed ──
      try {
        const stampDir = new Date(startedAtMs).toISOString().slice(0, 16).replace(/[:T]/g, "-");
        const dir = join(meetingsRoot(), `${stampDir}-${slug(session.title)}`);
        mkdirSync(dir, { recursive: true });
        const md = join(dir, "note.md");
        const js = join(dir, "session.json");
        writeFileSync(md, renderMarkdown(session), "utf8");
        writeFileSync(js, JSON.stringify(session, null, 2), "utf8");
        console.log(`[meeting] saved → ${dir}`);
        send(ws, { type: "saved", dir, markdown: md, json: js });
      } catch (e: any) {
        send(ws, { type: "error", message: `Could not save to disk: ${e?.message ?? e}` });
      }

      send(ws, { type: "done" });
    };

    ws.on("message", async (data: Buffer, isBinary: boolean) => {
      // Binary: <1 byte stream tag><PCM frame>
      if (isBinary) {
        if (data.length < 2) return;
        const which: SpeakerStream = data[0] === 1 ? "them" : "me";
        const frame = new Uint8Array(data.subarray(1));
        streams[which].pcm.push(frame);
        try { streams[which].session?.sendAudio(frame); } catch { /* reconnecting */ }
        return;
      }

      let msg: any;
      try { msg = JSON.parse(data.toString("utf8")); } catch { return; }

      if (msg.type === "start") {
        templateId = typeof msg.template === "string" ? msg.template : "general";
        language = typeof msg.language === "string" && msg.language ? msg.language : "en";
        summaryModel = typeof msg.summaryModel === "string" && msg.summaryModel.trim() ? msg.summaryModel : undefined;
        const key = process.env.PYAI_API_KEY;
        if (!key) {
          send(ws, { type: "error", message: "PYAI_API_KEY missing — add it in Settings or the repo .env." });
          return;
        }
        if (!process.env.OPENAI_API_KEY) {
          send(ws, { type: "error", message: "OPENAI_API_KEY missing — the note pass needs it." });
        }
        try {
          await Promise.all([openStream("me", key), openStream("them", key)]);
          send(ws, { type: "ready" });
          console.log(`[meeting] start: template=${templateId} lang=${language}`);
        } catch (e: any) {
          send(ws, { type: "error", message: `Could not open transcription: ${e?.message ?? e}` });
        }
        return;
      }

      if (msg.type === "note") {
        if (typeof msg.notes === "string") notes = msg.notes;
        return;
      }

      // Open the meeting folder in Finder — the local-first proof point.
      if (msg.type === "reveal") {
        const dir = typeof msg.dir === "string" ? msg.dir : meetingsRoot();
        try {
          mkdirSync(dir, { recursive: true });
          spawn("open", [dir], { detached: true, stdio: "ignore" }).unref();
        } catch (e: any) {
          send(ws, { type: "error", message: `Could not open folder: ${e?.message ?? e}` });
        }
        return;
      }

      if (msg.type === "stop") {
        if (typeof msg.notes === "string") notes = msg.notes;
        await finalize();
        return;
      }
    });

    ws.on("close", () => {
      for (const which of ["me", "them"] as SpeakerStream[]) {
        try { streams[which].session?.close(); } catch { /* noop */ }
      }
    });
  });

  return wss;
}

// Run standalone: `node --import tsx apps/backend/src/meeting.ts`
if (process.argv[1] && process.argv[1].endsWith("meeting.ts")) startMeetingServer();
