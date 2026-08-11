// Headless check: connect to the backend, run demo mode, assert we get
// live + correction + done events end-to-end (no browser, mic, or key).
import { WebSocket } from "ws";

const ws = new WebSocket("ws://localhost:8787");
const seen = { live: 0, correction: 0, ready: false, done: false, error: null };
let lastCorrection = null;

const timer = setTimeout(() => finish("TIMEOUT"), 12000);

ws.on("open", () => ws.send(JSON.stringify({ type: "start", mode: "demo" })));
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === "ready") seen.ready = true;
  else if (m.type === "live") seen.live++;
  else if (m.type === "correction") { seen.correction++; lastCorrection = m; }
  else if (m.type === "error") seen.error = m.message;
  else if (m.type === "done") { seen.done = true; finish("DONE"); }
});
ws.on("error", (e) => finish("WS_ERROR: " + e.message));

function finish(reason) {
  clearTimeout(timer);
  console.log("result:", reason);
  console.log(JSON.stringify(seen));
  if (lastCorrection) {
    console.log("clean:", JSON.stringify(lastCorrection.cleanText));
    console.log("ops:", lastCorrection.ops.length, "valid:", lastCorrection.valid);
  }
  const ok = seen.ready && seen.live > 0 && seen.correction > 0 && seen.done && !seen.error;
  console.log(ok ? "SMOKE PASS" : "SMOKE FAIL");
  try { ws.close(); } catch {}
  process.exit(ok ? 0 : 1);
}
