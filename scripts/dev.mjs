// One command to run the whole M2 demo: backend (WS bridge) + web (Vite).
// Usage: npm run dev   (from the repo root)
// For live mode, put PYAI_API_KEY in a .env at the repo root first.
import { spawn } from "node:child_process";

const procs = [
  ["backend", ["run", "start", "--workspace", "@open-dictation/backend"]],
  ["web", ["run", "dev", "--workspace", "@open-dictation/web"]],
];

const children = procs.map(([name, args]) => {
  const c = spawn("npm", args, { stdio: "inherit", env: process.env });
  c.on("exit", (code) => console.log(`[dev] ${name} exited (${code})`));
  return c;
});

const shutdown = () => {
  children.forEach((c) => c.kill());
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
