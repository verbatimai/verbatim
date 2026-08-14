import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Load repo-root `.env` into process.env (does not overwrite existing vars). */
export function loadEnv(): string | null {
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
    return p;
  }
  return null;
}
