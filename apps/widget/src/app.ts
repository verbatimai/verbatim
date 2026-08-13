// Verbatim — main app shell. History is presented from sample data for now
// (no live dictation-history store is wired yet — see the "Sample" tags in the UI).
// Real navigation targets: Settings → settings.html. The rest are tagged "Not in use".

// ---- theme: light / dark / system, persisted (shared with the Settings screen) ----
const order = ["system", "light", "dark"] as const;
type Theme = (typeof order)[number];

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

document.getElementById("themeToggle")?.addEventListener("click", () => {
  current = order[(order.indexOf(current) + 1) % order.length];
  applyTheme(current);
});
