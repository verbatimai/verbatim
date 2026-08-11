import { readFileSync, existsSync, unlinkSync } from "node:fs";

export default async function globalTeardown() {
  if (!existsSync(".e2e-backend.pid")) return;
  const pid = Number(readFileSync(".e2e-backend.pid", "utf8"));
  if (pid) {
    try { process.kill(-pid); } catch {} // kill the detached process group
    try { process.kill(pid); } catch {}
  }
  try { unlinkSync(".e2e-backend.pid"); } catch {}
}
