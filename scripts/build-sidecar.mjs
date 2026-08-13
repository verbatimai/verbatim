#!/usr/bin/env node
// Phase 4.8 — compile the Node backend into a self-contained sidecar binary that Tauri
// bundles as an externalBin. Run automatically by tauri's beforeBuildCommand (and safe to
// run by hand). Output: apps/widget/src-tauri/binaries/verbatim-backend-<target-triple>.
//
// Requires `bun` (fast, native ESM, single command):
//   curl -fsSL https://bun.sh/install | bash      # or: brew install bun
// (Alternative if you'd rather not add bun: `npx @yao-pkg/pkg` — see m4.8-sidecar-plan.md.)
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "apps/backend/src/server.ts");
const outDir = resolve(root, "apps/widget/src-tauri/binaries");

const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();

// Tauri expects the host target triple as the filename suffix (it strips it at bundle time).
let triple;
try {
  triple = sh("rustc -vV").match(/host:\s*(\S+)/)?.[1];
  if (!triple) throw new Error("no host triple in `rustc -vV`");
} catch {
  console.error("[sidecar] rustc not found — install Rust (https://rustup.rs) so we can read the target triple.");
  process.exit(1);
}

try {
  sh("bun --version");
} catch {
  console.error("[sidecar] `bun` not found. Install it:");
  console.error("           curl -fsSL https://bun.sh/install | bash   (or: brew install bun)");
  console.error("         …or swap this script for `npx @yao-pkg/pkg` (see docs/product/m4.8-sidecar-plan.md).");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, `verbatim-backend-${triple}`);
console.log(`[sidecar] bun build ${entry}\n          → ${out}`);
execSync(`bun build "${entry}" --compile --outfile "${out}"`, { stdio: "inherit", cwd: root });
console.log("[sidecar] done.");
