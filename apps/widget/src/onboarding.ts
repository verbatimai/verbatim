// Verbatim — first-run onboarding (onboarding.html): three screens, Connect →
// Permissions → Try it. Opened from Rust in main.rs's setup() when
// config.setup_state is "unseen" and no vendor key is saved, and on demand from
// the tray's "Finish setup…" and the overlay's "Finish setup" button (both go
// through window.rs::open_onboarding_window / show_onboarding_window).
//
// Shape: one `state` object, one render() that rebuilds the pane's markup from
// it, and a single delegated click handler keyed on data-act. Ported from
// docs/product/onboarding-prototype.html, which is the visual spec of record;
// every user-visible string comes from there via
// docs/onboarding/implementation-plan.md §7.
//
// Three decisions that are not obvious from the code below:
//
//  * A pasted key is never interpolated into markup, logged, or put into an
//    error string. The two <input> nodes are created once and re-inserted on
//    every render (see makeField) so their values never round-trip through an
//    HTML string — which is also why masking is `input.type`, not bullet
//    characters substituted into the value.
//  * This window never hides itself from JS. Hiding a window from the webview
//    skips the CloseRequested handler that reverts the macOS activation policy,
//    which leaves the app with a Dock icon for the rest of the session even when
//    dockIcon is false. Both exits call finish_onboarding, which hides the
//    window and reverts the policy on the Rust side, in that order.
//  * What the resolver decides, this file only displays. Which provider ids get
//    written, whether self-correction can be switched on, and every headline
//    live in onboarding-resolve.ts so they can be unit-checked without a DOM.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  VENDORS,
  VENDOR_ORDER,
  combo,
  continueBlocked,
  detect,
  resolveFirst,
  sanitizeCorrection,
  secondSlot,
  slotError,
  type ConfigPatch,
  type Mode,
  type Vendor,
} from "./onboarding-resolve";

// The AppConfig fields this window reads. settings.ts holds the full type, but it
// is a page entry with top-level DOM side effects — importing from it would boot
// all of Settings inside this window. Duplicated deliberately, same as the
// PRESET_LABELS/describeHotkey pair below.
type OnboardConfig = {
  hotkey?: string;
  theme?: string;
  correctionProvider?: string;
};

/** Verdict from the key_verify command. `ok === false` is the only blocking case. */
type VerifyOutcome = { ok: boolean; reachable: boolean };

// Emitted by main.ts on every dictation (fire-and-forget, so this window is free
// to not exist). Screen 3 renders from these events rather than from AX injection
// landing in its own field, which is unproven while Verbatim is frontmost.
type Op = { type: "keep" | "remove" | "replace"; text: string; replacement?: string };
type DictationProgress =
  | { phase: "live"; transcript: string; active: string }
  | { phase: "correction"; raw: string; cleanText: string; ops: Op[] }
  | { phase: "final"; text: string };

// ---- copied from settings.ts:432-449 ----------------------------------------
// Duplicated rather than imported for the reason given above. Keep in sync with
// settings.ts and with tray.rs's hotkey_glyph, which mirrors the same table in
// Rust. Never render a literal "⌥Space" anywhere: the hotkey is configurable.
const PRESET_LABELS: Record<string, string> = {
  "alt-space": "⌥Space", "ctrl-space": "⌃Space", "cmd-shift-d": "⌘⇧D",
  "ctrl-alt-d": "⌃⌥D", "alt-grave": "⌥`",
};

function describeHotkey(id: string): string {
  if (PRESET_LABELS[id]) return PRESET_LABELS[id];
  // A captured accelerator, e.g. "Alt+Shift+KeyD" -> "⌥⇧D".
  const parts = id.split("+");
  const code = parts.pop() ?? "";
  const glyphs: Record<string, string> = { Alt: "⌥", Control: "⌃", Shift: "⇧", Meta: "⌘", Super: "⌘", Cmd: "⌘" };
  const mods = parts.map((p) => glyphs[p] ?? p).join("");
  const key = code.startsWith("Key") ? code.slice(3) : code.startsWith("Digit") ? code.slice(5) : code;
  return mods + key;
}
// ---- end copy ---------------------------------------------------------------

const I = {
  mic: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>',
  kbd: '<svg class="ico" viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>',
  eye: '<svg class="ico" viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  bolt: '<svg class="bolt" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
  warn: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 3l9 16H3l9-16z"/><path d="M12 9v5M12 17h.01"/></svg>',
  tick: '<svg class="ico" viewBox="0 0 24 24" style="width:15px;height:15px"><path d="M20 6L9 17l-5-5"/></svg>',
  cog: '<svg class="ico" viewBox="0 0 24 24" style="width:15px;height:15px"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  lock: '<svg class="ico" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  menubar: '<svg class="ico" style="width:15px;height:15px" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  level: '<span class="lv"><b></b><b></b><b></b><b></b></span>',
};

/** Which field owns an error, and what that field says.
 *
 *  This is one function rather than a flag read at four render sites because the
 *  bug it prevents is subtle and expensive: attributing a rejection to the wrong
 *  slot sends the user off editing a key that was never refused. A 401 on the
 *  cleanup key must redden the cleanup field and name the cleanup vendor, and
 *  must leave the speech field alone — even though both keys are checked by the
 *  same Continue click. Pure, so it can be executed in the resolver suite.
 */
type FieldStatus = { bad1: boolean; bad2: boolean; msg1: string | null; msg2: string | null };

function fieldStatus(s: {
  verify: Verify; verify2: Verify2; vendor: Vendor | null; v2: Vendor | null;
}): FieldStatus {
  const rejected = (v: Vendor | null): string =>
    `${v ? VENDORS[v].name : "That vendor"} rejected this key. Check it and paste again.`;
  // A role mismatch is reported ahead of a rejection: it is caught before any
  // key_verify runs, so the two can never both be true for the same paste.
  const role = slotError(s.vendor, s.v2);
  return {
    bad1: s.verify === "bad",
    bad2: role !== null || s.verify2 === "bad",
    msg1: s.verify === "bad" ? rejected(s.vendor) : null,
    msg2: role !== null ? role : s.verify2 === "bad" ? rejected(s.v2) : null,
  };
}

/** Everything that reaches innerHTML from outside this file goes through here. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** How long the unreachable-vendor chip is held before Screen 2 replaces it. */
const CHIP_BEAT_MS = 1200;
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const dots = (n: 1 | 2 | 3): string =>
  `<div class="dots">${[1, 2, 3].map((i) => `<i class="${i === n ? "on" : ""}"></i>`).join("")}</div>`;

// ---- state ------------------------------------------------------------------
type Verify = "idle" | "checking" | "bad" | "offline" | "ok" | "saveFailed";
/** The second slot only ever has its own *rejection* to report: the spinner and
    the reachability verdict belong to the Continue action as a whole. */
type Verify2 = "idle" | "bad";
type TryState = "idle" | "listening" | "correcting" | "done";

type State = {
  screen: 1 | 2 | 3;
  key: string;
  vendor: Vendor | null;
  pick: boolean;
  reveal: boolean;
  verify: Verify;
  /** Kept apart from `verify` so a 401 is attributed to the key that was
      actually refused — see fieldStatus(). */
  verify2: Verify2;
  help: boolean;
  mode: Mode | null;
  key2: string;
  v2: Vendor | null;
  second: boolean;
  mic: boolean;
  /** macOS never re-prompts for the mic once denied, so a refusal has to route
      the user to System Settings and offer a manual re-check. */
  micDenied: boolean;
  ax: boolean;
  tryState: TryState;
  /** Screen 3's transcript, already escaped, with our own <s> spans for the
      removed pieces. Built from dictation-progress, never from user markup. */
  tryHtml: string;
};

const state: State = {
  screen: 1,
  key: "", vendor: null, pick: false, reveal: false, verify: "idle", verify2: "idle", help: false, mode: null,
  key2: "", v2: null, second: false,
  mic: false, micDenied: false, ax: false,
  tryState: "idle", tryHtml: "",
};

let cfg: OnboardConfig = {};
/** Whether get_config actually returned. Without it there is no way to tell an
    absent correctionProvider from an invalid one, and "absent" must never be
    repaired — that would overwrite a perfectly good stored value. */
let cfgRead = false;
/** Rendered hotkey label; the raw id comes from get_toggle_hotkey at boot. */
let hotkeyLabel = describeHotkey("alt-space");
/** Whether this build was compiled with a Saaslabs test key (option_env! in Rust). */
let internalBuild = false;

const root = document.getElementById("root") as HTMLElement;

// ---- the two long-lived key fields -----------------------------------------
// Created once, re-inserted into each render's placeholder. Keeping the nodes
// alive is what lets a secret stay out of every HTML string; the caret and focus
// are restored by hand because WebKit blurs a focused node when it is moved.
type Field = { el: HTMLDivElement; input: HTMLInputElement };

function makeField(placeholder: string, withEye: boolean): Field {
  const el = document.createElement("div");
  el.className = "field";
  const input = document.createElement("input");
  input.type = "password";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.placeholder = placeholder;
  el.appendChild(input);
  if (withEye) {
    const eye = document.createElement("button");
    eye.className = "eye";
    eye.title = "Show key";
    eye.dataset.act = "reveal";
    eye.innerHTML = I.eye;
    el.appendChild(eye);
  }
  return { el, input };
}

const field1 = makeField("Paste your API key", true);
const field2 = makeField("Paste a key", false);

field1.input.addEventListener("input", () => {
  state.key = field1.input.value;
  state.vendor = detect(state.key);
  state.verify = "idle";
  state.verify2 = "idle";
  // A second key the user can no longer see must not survive a change of the
  // first one. The resolver already ignores a stale second vendor, so Continue
  // can never be jammed by an invisible field — but a secret nobody can see
  // should not linger, and if the slot reappears the paste should be deliberate.
  // Only done once a vendor is actually detected: mid-typing the slot is merely
  // hidden, and wiping the cleanup key on every keystroke would be hostile.
  if (state.vendor && secondSlot(state.vendor).need === "none") clearSecond();
  render();
});
field2.input.addEventListener("input", () => {
  state.key2 = field2.input.value;
  state.v2 = detect(state.key2);
  state.verify = "idle";
  state.verify2 = "idle";
  render();
});
for (const f of [field1, field2]) {
  f.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void continueFromScreen1();
  });
}

function clearSecond(): void {
  state.key2 = "";
  state.v2 = null;
  state.second = false;
  state.verify2 = "idle";
  field2.input.value = "";
}

// ---- render -----------------------------------------------------------------
function render(): void {
  const active = document.activeElement;
  const focused = active === field1.input ? field1 : active === field2.input ? field2 : null;
  const caret = focused ? focused.input.selectionStart : null;

  root.innerHTML =
    state.screen === 1 ? (state.help ? screen1Help() : screen1()) :
    state.screen === 2 ? screen2() : screen3();

  // Masking is a property of the live node, so it is applied after every render
  // rather than baked into markup.
  field1.input.type = state.reveal ? "text" : "password";
  field2.input.type = state.reveal ? "text" : "password";
  const fs = fieldStatus(state);
  field1.el.classList.toggle("bad", fs.bad1);
  field2.el.classList.toggle("bad", fs.bad2);

  for (const [name, f] of [["key", field1], ["key2", field2]] as const) {
    const slot = root.querySelector(`[data-slot="${name}"]`);
    if (slot) slot.replaceWith(f.el);
  }

  if (focused && focused.el.isConnected) {
    focused.input.focus();
    if (caret !== null) focused.input.setSelectionRange(caret, caret);
  }
}

// ---- Screen 1: Connect ------------------------------------------------------
function screen1(): string {
  const det = state.vendor;
  const r1 = resolveFirst(det);
  const r = combo(det, state.v2);
  const slot = secondSlot(det);
  const fs = fieldStatus(state);
  const vendorName = det ? VENDORS[det].name : "That vendor";

  let meta: string;
  if (state.verify === "checking") {
    meta = `<span class="chip muted"><span class="spin"></span>Checking with ${vendorName}…</span>`;
  } else if (fs.msg1) {
    meta = `<p class="err">${fs.msg1}</p>`;
  } else if (state.verify === "saveFailed") {
    meta = `<p class="err">Couldn't save that key — check it and try again.</p>`;
  } else if (state.verify === "offline") {
    meta = `<span class="chip muted">Couldn't reach ${vendorName} — saved anyway</span>`;
  } else if (det && r1) {
    const role =
      r1.mode === "full" ? `<span class="okline">${I.tick}${r1.chip}</span>` :
      r1.mode === "raw" ? `<span class="note">${r1.chip}</span>` :
      `<span class="note warn">${r1.chip}</span>`;
    meta = `<button class="chip" data-act="pick">Detected: ${VENDORS[det].name} <span class="cv">▾</span></button>${role}`;
  } else if (state.key) {
    meta = `<span class="chip muted">Keep typing…</span>`;
  } else {
    meta = `<span class="chip muted dashed">We detect the vendor for you</span>`;
  }

  // Detection is only a hint, so it is always overridable — key_verify is the
  // real gate, and a picked vendor invalidates any previous verdict.
  const picker = state.pick
    ? `<div class="vpop">${VENDOR_ORDER.map((k) =>
        `<button data-act="setv" data-v="${k}" class="${k === det ? "sel" : ""}">${VENDORS[k].name}</button>`).join("")}</div>`
    : "";

  let second = "";
  if (slot.need !== "none") {
    if (slot.need === "required" || state.second) {
      const covered = slot.role === "stt" ? "speech" : "cleanup";
      const tail = fs.msg2
        ? `<p class="err">${fs.msg2}</p>`
        : state.v2 ? `<p class="okline">${I.tick}${VENDORS[state.v2].name} — ${covered} covered</p>` : "";
      field2.input.placeholder = `Paste ${article(firstName(slot.okList))} key`;
      second = `<div class="secondRow">
      <div class="lab">${slot.label} <em>${slot.need} · ${slot.okList}</em></div>
      <div data-slot="key2"></div>
      ${tail}
    </div>`;
    } else {
      second = `<button class="link discLink" data-act="second">
      <span class="cv">+</span> Add a cleanup key for self-correction <em>— optional</em></button>`;
    }
  }

  const testkey = internalBuild && !det ? `<button class="testkey" data-act="test">
      ${I.bolt}
      <span><strong>Use the Saaslabs test key</strong>
      <small>PyAI speech-to-text · shared quota · adds no cleanup key</small></span>
      <span class="pill">internal</span>
    </button>` : "";

  const help = det ? "" : `<button class="link discLink" data-act="help"><span class="cv">›</span> I don't have a key yet</button>`;

  // Once a key is in, the preview has done its job — the room goes to the
  // second-role slot instead, which is what the user now has to act on.
  const compact = !!det;
  const blocked = continueBlocked(det, state.v2) || state.verify === "checking";

  return `<div class="head">
      <img class="mark" src="/verbatim-logo.svg" alt="" width="34" height="34" />
      <h2>Welcome to Verbatim</h2>
      <p>${compact && r ? esc(r.headline) : "Paste one API key. That's the whole setup."}</p>
      ${dots(1)}
    </div>
    ${compact ? "" : `<div class="preview">
      ${I.mic}
      <span class="pvtext">send it by <span class="cut">8 pm no no make it&nbsp;</span>9 pm tomorrow</span>
    </div>
    <p class="previewTag">Live preview — no key, no mic. This is what Verbatim does to your words.</p>`}
    <div data-slot="key"></div>
    <div class="meta">${meta}</div>
    ${picker}
    ${second}
    ${testkey}
    ${help}
    <p class="trust">${I.lock}Stored locally on this Mac. Sent only to the vendor you picked — never to us.</p>
    <div class="foot">
      <button class="link" data-act="later">Set up later</button>
      <button class="btn primary" data-act="next1"${blocked ? " disabled" : ""}>Continue</button>
    </div>`;
}

/** "OpenAI or Anthropic" -> "OpenAI"; "PyAI, Deepgram or OpenAI" -> "PyAI". */
function firstName(okList: string): string {
  return okList.split(/,| or /)[0].trim();
}
function article(name: string): string {
  return /^[AEIOU]/i.test(name) ? `an ${name}` : `a ${name}`;
}

function screen1Help(): string {
  return `<div class="head">
      <h2>Where to get a key</h2>
      <p>Verbatim is bring-your-own-key. Any one of these works.</p>
      ${dots(1)}
    </div>
    <div class="kg spaced">
      ${VENDOR_ORDER.map((k) => `<div class="kr ${k === "openai" ? "best" : ""}">
        <b>${VENDORS[k].name}</b><span>${VENDORS[k].blurb}</span>
        ${k === "openai" ? `<span class="tagbest">1 key = all</span>` : ""}
        <button class="getkey" data-act="getkey" data-v="${k}">Get a key ↗</button>
      </div>`).join("")}
    </div>
    <p class="trust">${I.lock}Keys stay on this Mac and go only to the vendor you picked.</p>
    <div class="foot">
      <button class="link" data-act="help">‹ Back</button>
      <button class="btn" data-act="help">I have one now</button>
    </div>`;
}

// ---- Screen 2: permissions --------------------------------------------------
function screen2(): string {
  const both = state.mic && state.ax;
  // Only the degraded case gets a strip: a fully-configured setup has nothing to
  // disclose here, and a green "all good" banner would be noise.
  const strip = state.mode === "raw" ? `<div class="info">${I.warn}<span><b>Self-correction is off.</b> Your key covers speech-to-text only — dictation works now, and you can add an OpenAI or Anthropic key any time in Settings.</span></div>` : "";

  const row = (ico: string, title: string, sub: string, ok: boolean, buttons: string): string => `
      <div class="prow">
        <span class="pi">${ico}</span>
        <span class="pb">
          <h4>${title} <span class="stat ${ok ? "y" : "n"}"><i></i>${ok ? "Granted" : "Not granted"}</span></h4>
          <p>${sub}</p>
        </span>
        ${ok ? "" : buttons}
      </div>`;

  const micButtons = state.micDenied
    ? `<button class="btn" data-act="micSettings">Open Settings</button><button class="btn" data-act="mic">Re-check</button>`
    : `<button class="btn" data-act="mic">Allow</button>`;

  return `<div class="head">
      <h2>Two macOS permissions</h2>
      <p>Verbatim asks for exactly these two, and nothing else.</p>
      ${dots(2)}
    </div>
    <div class="rows">
      ${strip}
      ${row(I.mic, "Microphone", "So Verbatim can hear you. macOS will ask once.", state.mic, micButtons)}
      ${row(I.kbd, "Accessibility", "Lets Verbatim type into whatever app you're in. Without it, your text is copied to the clipboard instead.", state.ax, `<button class="btn" data-act="ax">Open Settings</button>`)}
      ${state.ax ? "" : `<p class="watch"><span class="spin"></span>Watching for the toggle — this page updates itself when you flip it.</p>`}
    </div>
    <div class="foot">
      <button class="link" data-act="back">Back</button>
      <button class="btn primary" data-act="next2">${both ? "Continue" : "Continue anyway"}</button>
    </div>`;
}

// ---- Screen 3: try it -------------------------------------------------------
function screen3(): string {
  const done = state.tryState === "done";
  let body: string;
  if (state.tryState === "idle") {
    body = `<div class="trybox">
      <span class="lbl2">Your turn</span>
      <div class="live"><span class="dim">Hold the hotkey and speak…</span><span class="cursor"></span></div>
    </div>
    <div class="pill">${I.mic} Hold <kbd>${esc(hotkeyLabel)}</kbd> to dictate</div>`;
  } else if (state.tryState === "listening") {
    body = `<div class="trybox">
      <span class="lbl2">Listening</span>
      <div class="live">${state.tryHtml}<span class="cursor"></span></div>
    </div>
    <div class="pill">${I.level} Listening…</div>`;
  } else if (state.tryState === "correcting") {
    body = `<div class="trybox">
      <span class="lbl2">Cleaning up</span>
      <div class="live">${state.tryHtml}</div>
    </div>
    <div class="pill">${I.cog} Correcting…</div>`;
  } else if (state.tryHtml) {
    body = `<div class="trybox">
      <span class="lbl2">Inserted</span>
      <div class="live">${state.tryHtml}</div>
      <div class="done">${I.tick} Typed into the field, corrections and all.</div>
    </div>`;
  } else {
    // Skipped: there is no transcript to show, and an empty "Inserted" box
    // claiming a successful dictation would be a lie.
    body = "";
  }

  const tips = done ? `<div class="tips">
      <div class="tip"><kbd>${esc(hotkeyLabel)}</kbd> anywhere — hold to talk, tap to toggle</div>
      <div class="tip">${I.menubar} The menu-bar icon has your history and settings</div>
    </div>` : "";

  return `<div class="head">
      <h2>${done ? "That's it — you're set." : "Give it one try"}</h2>
      <p>${done ? "Verbatim lives in your menu bar from here." : `Hold <b>${esc(hotkeyLabel)}</b> and say anything. It lands in the box below.`}</p>
      ${dots(3)}
    </div>
    ${body}
    ${tips}
    <div class="foot">
      ${done ? "" : `<button class="link" data-act="skip3">Skip the test</button>`}
      <button class="btn primary" data-act="done">Done</button>
    </div>`;
}

// ---- Screen 1 actions: verify, save, advance --------------------------------
/** Merge the resolver's patch into the config, repairing a poisoned correction id. */
async function writePatch(mode: Mode, patch: ConfigPatch): Promise<void> {
  const merged: ConfigPatch = { ...patch };
  if (mode === "raw") {
    // A raw setup leaves correctionProvider alone — unless what is already stored
    // cannot be resolved (an install poisoned with "pyai" by the previous version
    // of this window), in which case every dictation would banner an error the
    // user cannot act on.
    const current = cfgRead ? cfg.correctionProvider : undefined;
    if (current) {
      const fix = sanitizeCorrection(current);
      if (fix) merged.correctionProvider = fix;
    }
  }
  await invoke("set_config", { patch: merged });
}

async function continueFromScreen1(): Promise<void> {
  if (state.screen !== 1 || state.help) return;
  const first = state.vendor;
  if (!first || continueBlocked(first, state.v2)) return;
  const r = combo(first, state.v2);
  if (!r) return;

  state.verify = "checking";
  render();

  // Verify before saving: a 401 has to be caught here, in front of the field the
  // user can still fix, rather than at their first dictation. A network failure
  // is not a bad key — only ok === false blocks.
  let reachable = true;
  try {
    const v1 = await invoke<VerifyOutcome>("key_verify", { vendor: first, secret: state.key });
    if (!v1.ok) { state.verify = "bad"; render(); return; }
    reachable = v1.reachable;
    if (state.v2) {
      const v2 = await invoke<VerifyOutcome>("key_verify", { vendor: state.v2, secret: state.key2 });
      // The first key was accepted, so `verify` goes back to idle: the blame,
      // the red border and the vendor name all belong to the second slot.
      if (!v2.ok) { state.verify = "idle"; state.verify2 = "bad"; render(); return; }
      reachable = reachable && v2.reachable;
    }
  } catch {
    // An unknown vendor id is the only rejection key_verify has; treat it like an
    // unreachable vendor rather than blocking a key that may well be fine.
    reachable = false;
  }
  state.verify = reachable ? "ok" : "offline";

  const secretOf: Partial<Record<Vendor, string>> = {};
  secretOf[first] = state.key;
  if (state.v2) secretOf[state.v2] = state.key2;

  try {
    // Serially, speech key first: set_key restarts the backend sidecar on every
    // call, and two parallel calls race two spawns for the same port. STT first
    // means the last restart already has both keys.
    const sttSecret = r.sttVendor ? secretOf[r.sttVendor] : undefined;
    if (r.sttVendor && sttSecret !== undefined) {
      await invoke("set_key", { vendor: r.sttVendor, secret: sttSecret });
    }
    // Skipped when one vendor covers both roles: that is a single key, and a
    // second set_key would buy nothing but a second sidecar restart.
    if (r.corrVendor && r.corrVendor !== r.sttVendor) {
      const corrSecret = secretOf[r.corrVendor];
      if (corrSecret !== undefined) {
        await invoke("set_key", { vendor: r.corrVendor, secret: corrSecret });
      }
    }
    await writePatch(r.mode, r.patch);
  } catch {
    // Either key or the config write can fail here; the config patch is written
    // last, so a failure never leaves a provider id pointing at a key that did
    // not save. The user stays on Screen 1 with a field they can still fix.
    state.verify = "saveFailed";
    render();
    return;
  }

  if (!reachable) {
    // Painted after the save, so "saved anyway" is true when the user reads it,
    // and held for a beat because advancing in the same tick means the chip never
    // appears at all. It stays on Screen 1 rather than becoming a Screen 2
    // banner: PyAI has no probe yet (§9 #1) and so always lands here, and a
    // permanent warning on the default provider's happy path is noise.
    render();
    await sleep(CHIP_BEAT_MS);
  }

  state.mode = r.mode;
  await enterScreen2();
}

async function useTestKey(): Promise<void> {
  const r = combo("pyai", null);
  if (!r) return;
  try {
    // use_test_key stores the secret and restarts the sidecar itself, so there is
    // no set_key here — only the config half of the same save path.
    await invoke("use_test_key");
    await writePatch(r.mode, r.patch);
  } catch {
    state.verify = "saveFailed";
    render();
    return;
  }
  state.mode = r.mode;
  await enterScreen2();
}

// ---- Screen 2: permission probes -------------------------------------------
async function askMic(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Release the device immediately — this is a permission prompt, not a
    // recording, and holding the input would light the mic indicator for the
    // rest of onboarding.
    stream.getTracks().forEach((t) => t.stop());
    state.mic = true;
    state.micDenied = false;
  } catch {
    state.mic = false;
    state.micDenied = true;
  }
  render();
}

// The AX row flips itself so the user never has to hunt for a "check again"
// button after a trip to System Settings. The timer only exists while Screen 2
// is on screen: this window is hidden rather than destroyed, so a leaked
// interval would poll ax_trusted for the lifetime of the app.
let axTimer: number | null = null;

function startAxPoll(): void {
  stopAxPoll();
  axTimer = window.setInterval(() => void refreshAx(), 1000);
}
function stopAxPoll(): void {
  if (axTimer !== null) { clearInterval(axTimer); axTimer = null; }
}
async function refreshAx(): Promise<void> {
  let next = state.ax;
  try { next = await invoke<boolean>("ax_trusted"); } catch { return; }
  // Only re-render on a change: a 1 Hz innerHTML rebuild would restart the
  // spinner animation and fight the user for focus.
  if (next !== state.ax) { state.ax = next; render(); }
}

async function enterScreen2(): Promise<void> {
  state.screen = 2;
  render();
  await refreshAx();
  startAxPoll();
}

// ---- Screen 3: the live try-it box -----------------------------------------
let unlistenTry: UnlistenFn | null = null;

async function startTryListen(): Promise<void> {
  if (unlistenTry) return;
  try {
    // Subscribed only from Screen 3 onward: a dictation the user makes while
    // still on Screen 1 shouldn't pre-fill the box with a stale result.
    unlistenTry = await listen<DictationProgress>("dictation-progress", (e) => {
      const p = e.payload;
      if (state.screen !== 3) return;
      if (p.phase === "live") {
        state.tryState = "listening";
        // Committed words solid, the in-flight ones dimmed — the same split the
        // overlay's transcript bubble shows.
        const tail = p.active ? `<span class="dim">${p.transcript ? " " : ""}${esc(p.active)}</span>` : "";
        state.tryHtml = esc(p.transcript) + tail;
      } else if (p.phase === "correction") {
        state.tryState = "correcting";
        state.tryHtml = opsToHtml(p.ops, p.cleanText);
      } else {
        state.tryState = "done";
        state.tryHtml = esc(p.text);
      }
      render();
    });
  } catch {
    // No event stream means the box stays on its idle line — the hotkey tip and
    // the Done button, which are the point of the screen, still work.
  }
}
function stopTryListen(): void {
  if (unlistenTry) { unlistenTry(); unlistenTry = null; }
}

/** The correction reveal: what was cut stays visible, struck through. */
function opsToHtml(ops: Op[], fallback: string): string {
  if (!ops.length) return esc(fallback);
  return ops.map((op) =>
    op.type === "keep" ? esc(op.text)
    : op.type === "remove" ? `<s>${esc(op.text)}</s>`
    : `<s>${esc(op.text)}</s>${esc(op.replacement ?? "")}`).join("");
}

async function enterScreen3(): Promise<void> {
  stopAxPoll();
  state.screen = 3;
  render();
  await startTryListen();
}

// ---- exits ------------------------------------------------------------------
// Both record the user's choice so the window never auto-opens again. Rust hides
// the window before it writes the config, so a failed write must not leave the
// button looking stuck — hence the swallowed error.
function finish(setupState: "skipped" | "done"): void {
  stopAxPoll();
  stopTryListen();
  void invoke("finish_onboarding", { state: setupState }).catch(() => {});
}

// ---- one delegated click handler -------------------------------------------
root.addEventListener("click", (e) => {
  const hit = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-act]");
  if (!hit) return;
  const act = hit.dataset.act;
  const v = hit.dataset.v as Vendor | undefined;
  switch (act) {
    case "reveal": state.reveal = !state.reveal; render(); break;
    case "pick": state.pick = !state.pick; render(); break;
    case "setv":
      if (v) {
        state.vendor = v; state.pick = false; state.verify = "idle"; state.verify2 = "idle";
        if (secondSlot(v).need === "none") clearSecond();
      }
      render();
      break;
    case "second": state.second = true; render(); break;
    case "help": state.help = !state.help; state.pick = false; render(); break;
    case "getkey": if (v) window.open("https://" + VENDORS[v].url); break;
    case "test": void useTestKey(); break;
    case "next1": void continueFromScreen1(); break;
    case "mic": void askMic(); break;
    case "micSettings": void invoke("open_mic_settings").catch(() => {}); break;
    case "ax": void invoke("open_accessibility_settings").catch(() => {}); break;
    case "back": stopAxPoll(); state.screen = 1; render(); break;
    case "next2": void enterScreen3(); break;
    case "skip3": state.tryState = "done"; render(); break;
    case "later": finish("skipped"); break;
    case "done": finish("done"); break;
  }
});

// A hidden window keeps running: without this both the AX poll and the event
// subscription would outlive the page.
window.addEventListener("beforeunload", () => { stopAxPoll(); stopTryListen(); });

// ---- boot -------------------------------------------------------------------
function applyTheme(theme: string | undefined): void {
  document.body.dataset.theme = theme ?? "system";
}

void listen<{ theme?: string }>("config-changed", (e) => applyTheme(e.payload?.theme));

async function boot(): Promise<void> {
  // Painted before anything is awaited, so a slow or failing command can never
  // leave the user looking at an empty window.
  render();
  field1.input.focus();
  try {
    cfg = await invoke<OnboardConfig>("get_config");
    cfgRead = true;
    applyTheme(cfg.theme);
  } catch { /* defaults are fine; the theme stays "system" */ }
  try {
    hotkeyLabel = describeHotkey(await invoke<string>("get_toggle_hotkey"));
  } catch {
    hotkeyLabel = describeHotkey(cfg.hotkey ?? "alt-space");
  }
  internalBuild = await invoke<boolean>("test_key_available").catch(() => false);
  const refocus = document.activeElement === field1.input || document.activeElement === document.body;
  render();
  if (refocus) field1.input.focus();
}

void boot();
