// Verbatim — Notes (notes.html). Plain-text, unbounded, sorted by most-recently-updated.
// Backed by notes.rs (own notes.json store, note_list/note_add/note_update/note_delete).
//
// Edits save silently in the background (debounced note_update, no re-render) — reordering
// by updatedAt mid-keystroke would yank the card the user is typing in out from under them.
// The grid re-sorts on the next full render() (new note, delete, page load) instead.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Note = { id: string; text: string; createdAt: number; updatedAt: number };

// ---- theme: light / dark / system — same pattern as app.ts, kept in sync via config-changed
// so the toggle behaves identically across every page. ----
const themeOrder = ["system", "light", "dark"] as const;
type Theme = (typeof themeOrder)[number];
const isTheme = (t: unknown): t is Theme => (themeOrder as readonly unknown[]).includes(t);

function applyTheme(t: Theme) {
  document.body.dataset.theme = t;
  const label = document.getElementById("themeLabel");
  if (label) label.textContent = t[0].toUpperCase() + t.slice(1);
  try { localStorage.setItem("verbatim.theme", t); } catch {}
}

let currentTheme: Theme = (() => {
  try { return (localStorage.getItem("verbatim.theme") as Theme) || "system"; } catch { return "system"; }
})();
applyTheme(currentTheme);

void invoke<{ theme?: string }>("get_config")
  .then((cfg) => { if (isTheme(cfg?.theme)) { currentTheme = cfg.theme; applyTheme(currentTheme); } })
  .catch(() => {});
void listen<{ theme?: string }>("config-changed", (e) => {
  const t = e.payload?.theme;
  if (isTheme(t)) { currentTheme = t; applyTheme(t); }
});

document.getElementById("themeToggle")?.addEventListener("click", () => {
  currentTheme = themeOrder[(themeOrder.indexOf(currentTheme) + 1) % themeOrder.length];
  applyTheme(currentTheme);
  void invoke("set_config", { patch: { theme: currentTheme } }).catch(() => {});
});

const timeLabel = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// Debounce edits per-note so we don't hit the store on every keystroke.
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleSave(id: string, text: string) {
  clearTimeout(saveTimers.get(id));
  saveTimers.set(id, setTimeout(() => {
    void invoke("note_update", { id, text }).catch(() => {});
    saveTimers.delete(id);
  }, 500));
}

// This is a dictation app — typing is the fallback, not the point. A note's textarea is
// just another focusable text field: click it, hit ⌥Space, and the same paste-based
// injection every other app gets lands your dictation right here.
async function render(focusId?: string) {
  const gridEl = document.getElementById("notesGrid");
  const emptyEl = document.getElementById("notesEmpty");
  if (!gridEl) return;

  let notes: Note[] = [];
  try { notes = await invoke<Note[]>("note_list"); } catch { notes = []; }

  emptyEl?.classList.toggle("hidden", notes.length > 0);
  gridEl.innerHTML = "";

  for (const note of notes) {
    const card = document.createElement("div");
    card.className = "note-card";

    const text = document.createElement("textarea");
    text.className = "note-text";
    text.value = note.text;
    text.placeholder = "Click here, then ⌥Space to dictate — or type";
    text.oninput = () => scheduleSave(note.id, text.value);
    if (note.id === focusId) queueMicrotask(() => text.focus());

    const foot = document.createElement("div");
    foot.className = "note-foot";
    const time = document.createElement("span");
    time.className = "note-time";
    time.textContent = timeLabel(note.updatedAt);
    const del = document.createElement("button");
    del.className = "btn ghost";
    del.textContent = "Delete";
    del.onclick = async () => {
      clearTimeout(saveTimers.get(note.id));
      try { await invoke("note_delete", { id: note.id }); } catch {}
      void render();
    };
    foot.append(time, del);

    card.append(text, foot);
    gridEl.appendChild(card);
  }
}

async function createNote() {
  try {
    const note = await invoke<Note>("note_add", { text: "" });
    void render(note.id); // focus it immediately — ready for ⌥Space, no click needed
  } catch { void render(); }
}
document.getElementById("newNote")?.addEventListener("click", () => void createNote());
document.getElementById("sidebarNewNote")?.addEventListener("click", () => void createNote());

// "notes-changed" fires from ANY window — the overlay's "Save as Note", a History row's
// "Save as note", another Notes window, etc. Skip the refresh only while a note textarea in
// THIS window has focus, so an in-flight edit here never gets yanked out from under the user;
// everything else (switching back to this window, a save from elsewhere) refreshes live.
void listen("notes-changed", () => {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement && active.classList.contains("note-text")) return;
  void render();
});
// Fallback in case an event is missed (window wasn't mounted yet, etc.) — refresh whenever
// this window regains focus.
window.addEventListener("focus", () => void render());

void render();
