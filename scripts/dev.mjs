// One command to run the whole M2 demo: backend (WS bridge) + web (Vite).
// Usage: npm run dev   (from the repo root)
// For live mode, put PYAI_API_KEY in a .env at the repo root first.
//
// By default this enables PYAI_STT_DEBUG on the backend and tees the raw Hear
// stream to `hear-stream.log` (also printed to the terminal) so it's easy to
// capture for debugging. Set HEAR_DEBUG=0 to turn that off.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

const DEBUG = process.env.HEAR_DEBUG !== "0";
const LOG_PATH = "hear-stream.log";
const log = DEBUG ? createWriteStream(LOG_PATH, { flags: "w" }) : null;

const backendEnv = { ...process.env, ...(DEBUG ? { PYAI_STT_DEBUG: "1" } : {}) };

function start(name, args, env, capture) {
  const child = spawn("npm", args, { stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit", env });
  if (capture) {
    const mirror = (src, dst) => src?.on("data", (d) => { dst.write(d); log?.write(d); });
    mirror(child.stdout, process.stdout);
    mirror(child.stderr, process.stderr);
  }
  child.on("exit", (code) => console.log(`[dev] ${name} exited (${code})`));
  return child;
}

const children = [
  start("backend", ["run", "start", "--workspace", "@verbatim/backend"], backendEnv, DEBUG),
  start("web", ["run", "dev", "--workspace", "@verbatim/web"], process.env, false),
];

if (DEBUG) {
  console.log(`[dev] raw Hear stream → ${LOG_PATH}  (grep '[hear]'; run HEAR_DEBUG=0 npm run dev to disable)`);
}

const shutdown = () => {
  children.forEach((c) => c.kill());
  log?.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
