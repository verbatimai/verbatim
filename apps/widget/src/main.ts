import { invoke } from "@tauri-apps/api/core";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = byId<HTMLInputElement>("text");
const status = byId<HTMLDivElement>("status");
const focusDot = byId<HTMLSpanElement>("focusDot");
const focusLabel = byId<HTMLSpanElement>("focusLabel");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Spike A signal: reflect whether the widget's webview has focus. When you click
// into another app, this should read "not focused"; the goal is that clicking the
// widget itself does NOT pull focus away from the app you were typing in.
function setFocused(on: boolean) {
  focusDot.classList.toggle("on", on);
  focusLabel.textContent = on ? "widget: FOCUSED" : "widget: not focused";
}
window.addEventListener("focus", () => setFocused(true));
window.addEventListener("blur", () => setFocused(false));
setFocused(document.hasFocus());

async function runInject(delaySec: number) {
  const text = input.value;
  for (let i = delaySec; i > 0; i--) {
    status.textContent = `Injecting in ${i}s — click into another app (Notes/Chrome) now…`;
    await sleep(1000);
  }
  status.textContent = "Injecting…";
  try {
    await invoke("inject_text", { text });
    status.textContent = "Injected. Check the app you focused.";
  } catch (e) {
    status.textContent = "Error: " + String(e);
  }
}

byId<HTMLButtonElement>("inject3").onclick = () => runInject(3);
byId<HTMLButtonElement>("inject").onclick = () => runInject(0);
