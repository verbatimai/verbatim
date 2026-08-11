import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

// Start the backend on an isolated port (demo mode needs no key). Detached so we
// can kill the whole process group in teardown — no broad pkill.
export default async function globalSetup() {
  const port = process.env.E2E_BACKEND_PORT ?? "8801";
  const be = spawn("npm", ["run", "backend"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, PORT: port, HOST: "127.0.0.1" },
    detached: true,
  });
  writeFileSync(".e2e-backend.pid", String(be.pid ?? ""));
  await new Promise((r) => setTimeout(r, 4000)); // let it bind
}
