// Verbatim — main app shell. Real navigation targets: Settings → settings.html.
// The rest are tagged "Not in use".
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type HistoryEntry = { id: string; text: string; timestamp: number };

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

// ---- dictation history — real entries from history.rs, replacing the old sample rows.
// Re-renders on "history-changed" (new dictation, delete, clear) and "config-changed"
// (historyLimit edited in Settings). ----
const dayLabel = (ts: number) => {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yest)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};
const timeLabel = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

async function renderHistory() {
  const groupsEl = document.getElementById("histGroups");
  const emptyEl = document.getElementById("histEmpty");
  const wordsEl = document.getElementById("wordsDictated");
  if (!groupsEl) return;

  let entries: HistoryEntry[] = [];
  try { entries = await invoke<HistoryEntry[]>("history_list"); } catch { entries = []; }

  if (wordsEl) {
    const words = entries.reduce((n, e) => n + e.text.trim().split(/\s+/).filter(Boolean).length, 0);
    wordsEl.textContent = words.toLocaleString();
  }

  emptyEl?.classList.toggle("hidden", entries.length > 0);
  groupsEl.innerHTML = "";

  let lastDay = "";
  let list: HTMLDivElement | null = null;
  for (const entry of entries) {
    const day = dayLabel(entry.timestamp);
    if (day !== lastDay) {
      lastDay = day;
      const group = document.createElement("div");
      group.className = "hist-group";
      const heading = document.createElement("p");
      heading.className = "hist-day";
      heading.textContent = day;
      list = document.createElement("div");
      list.className = "card hist-list";
      group.append(heading, list);
      groupsEl.appendChild(group);
    }
    const row = document.createElement("div");
    row.className = "hist-row";
    const time = document.createElement("span");
    time.className = "hist-time";
    time.textContent = timeLabel(entry.timestamp);
    const text = document.createElement("span");
    text.className = "hist-text";
    text.textContent = entry.text;
    const actions = document.createElement("span");
    actions.className = "hist-actions";
    const copy = document.createElement("button");
    copy.className = "btn ghost";
    copy.textContent = "Copy";
    copy.onclick = async () => {
      try {
        await invoke("copy_text", { text: entry.text });
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 1200);
      } catch {}
    };
    const saveNote = document.createElement("button");
    saveNote.className = "btn ghost";
    saveNote.textContent = "Save as note";
    saveNote.onclick = async () => {
      try {
        await invoke("note_add", { text: entry.text });
        saveNote.textContent = "Saved ✓";
        setTimeout(() => { saveNote.textContent = "Save as note"; }, 1200);
      } catch {}
    };
    const del = document.createElement("button");
    del.className = "btn ghost";
    del.textContent = "Delete";
    del.onclick = async () => {
      try { await invoke("history_delete", { id: entry.id }); } catch {}
      void renderHistory();
    };
    actions.append(copy, saveNote, del);
    row.append(time, text, actions);
    list?.appendChild(row);
  }
}

document.getElementById("histClear")?.addEventListener("click", async () => {
  if (!confirm("Clear all dictation history? This can't be undone.")) return;
  try { await invoke("history_clear"); } catch {}
  void renderHistory();
});

void listen("history-changed", () => void renderHistory());
void listen("config-changed", () => void renderHistory()); // historyLimit may have changed
// Fallback in case an event is missed (window wasn't mounted yet, etc.) — refresh whenever
// this window regains focus (e.g. switching back from the overlay after dictating).
window.addEventListener("focus", () => void renderHistory());
void renderHistory();
