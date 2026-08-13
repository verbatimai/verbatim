// One command to run the M3 widget end to end: backend (WS bridge) + the Tauri
// widget (tauri dev, which itself starts the widget's Vite server).
// Usage: npm run widget   (from the repo root)
//
// Demo mode needs no mic/key. For live dictation, put PYAI_API_KEY in a .env at the
// repo root first (the backend loads it). Grant Accessibility on first inject.
import { spawn } from "node:child_process";

function start(name, args, env) {
  const child = spawn("npm", args, { stdio: "inherit", env });
  child.on("exit", (code) => console.log(`[widget] ${name} exited (${code})`));
  return child;
}

const children = [
  start("backend", ["run", "start", "--workspace", "@verbatim/backend"], process.env),
  // `tauri dev` runs the widget's Vite server (beforeDevCommand) then the Rust shell.
  start("widget", ["run", "start", "--workspace", "@verbatim/widget"], process.env),
];

console.log("[widget] backend + Tauri widget starting. ⌥Space toggles the overlay; focus a field in another app before Stop.");

const shutdown = () => {
  children.forEach((c) => c.kill());
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
