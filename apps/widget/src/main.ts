import { invoke } from "@tauri-apps/api/core";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = byId<HTMLInputElement>("text");
const status = byId<HTMLDivElement>("status");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
