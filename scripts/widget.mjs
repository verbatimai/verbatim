// Run the Verbatim widget end to end. As of Phase 4.8 the Tauri app OWNS the backend:
// Rust spawns + supervises it and injects the vendor keys from the Keychain, so we only
// launch the widget here (no separate backend process, no key in the renderer).
// Usage: npm run widget   (from the repo root)
//
// Demo mode needs no mic/key. For live dictation, enter a key in Settings (⚙) — or, for
// standalone dev, put PYAI_API_KEY in a .env at the repo root (the backend loads it).
import { spawn } from "node:child_process";

// `tauri dev` runs the widget's Vite server (beforeDevCommand) then the Rust shell,
// which spawns the backend sidecar itself.
const child = spawn("npm", ["run", "start", "--workspace", "@verbatim/widget"], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => {
  console.log(`[widget] exited (${code})`);
  process.exit(code ?? 0);
});

console.log("[widget] Tauri widget starting (it owns the backend). ⌥Space toggles the overlay; focus a field in another app before Stop.");

const shutdown = () => { child.kill(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
