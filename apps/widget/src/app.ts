// Verbatim — main app shell. History is presented from sample data for now
// (no live dictation-history store is wired yet — see the "Sample" tags in the UI).
// Real navigation targets: Settings → settings.html. The rest are tagged "Not in use".
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---- theme: light / dark / system. Config store is the source of truth (1.5); localStorage
// is a synchronous fast-path so the shell doesn't flash the wrong theme before get_config. ----
const order = ["system", "light", "dark"] as const;
type Theme = (typeof order)[number];
const isTheme = (t: unknown): t is Theme => (order as readonly unknown[]).includes(t);

function applyTheme(t: Theme) {
  document.body.dataset.theme = t;
  const label = document.getElementById("themeLabel");
  if (label) label.textContent = t[0].toUpperCase() + t.slice(1);
  try { localStorage.setItem("verbatim.theme", t); } catch {}
}

let current: Theme = (() => {
  try { return (localStorage.getItem("verbatim.theme") as Theme) || "system"; } catch { return "system"; }
})();
applyTheme(current);

// Reconcile with the config store, then follow live config-changed events.
void invoke<{ theme?: string }>("get_config")
  .then((cfg) => { if (isTheme(cfg?.theme)) { current = cfg.theme; applyTheme(current); } })
  .catch(() => {});
void listen<{ theme?: string }>("config-changed", (e) => {
  const t = e.payload?.theme;
  if (isTheme(t)) { current = t; applyTheme(t); }
});

document.getElementById("themeToggle")?.addEventListener("click", () => {
  current = order[(order.indexOf(current) + 1) % order.length];
  applyTheme(current);
  void invoke("set_config", { patch: { theme: current } }).catch(() => {}); // persist (source of truth)
});
