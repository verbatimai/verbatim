# Vendor Transport & Key-Handling — M4 Phase 4.0 Decision

**Status:** decision doc (the Phase 4.0 gate). Resolves *where* each vendor call runs and *how* the BYOK key reaches it, so the M4 adapters (4.3–4.5) can be built without reworking the plumbing later.
**Date:** 13 Aug 2026. **Verified against:** the current widget/backend code + OpenAI/Deepgram live docs (this session) and `vendor-apis.md`.

---

## 1. The problem, stated precisely

The widget is a **non-activating, non-key `NSPanel`** (Spike A): its webview can never receive typed/pasted keystrokes — that's what keeps focus on the app underneath. Keys already live in the **macOS Keychain** (Phase 3.5: `key_save/get/has/delete` under service `co.saaslabs.opendictation`, account = the vendor key name).

The open question for M4 is the **transport**: when the user picks an STT vendor and a correction vendor, *what process opens the vendor connection, and how does the key get there* — given the classic constraint that **a browser/webview cannot set a WebSocket `Authorization` header.**

### Key reframing (from reading the code)

Only **streaming STT** is a WebSocket. Everything else is plain HTTPS:

| Call | Protocol | Header-auth from a `fetch`/renderer? |
|---|---|---|
| Streaming STT (PyAI Hear, Deepgram, OpenAI Realtime) | **WebSocket** | ❌ browsers can't set WS headers |
| Batch STT (`transcribeBatch`, `POST /v1/audio/transcriptions`) | HTTPS POST | ✅ |
| Correction (`POST /v1/messages` / `/v1/chat/completions`) | HTTPS POST | ✅ |
| Format (same as correction) | HTTPS POST | ✅ |

**So the WS-header limitation is narrow — it only bites streaming STT.** That's the whole decision surface.

### What today's code actually does

`webview (mic) → loopback WS → apps/backend (Node) → packages/core adapters (Node ws, sets Authorization header) → vendor`. The key currently flows **Keychain → webview → backend `start` message (`msg.apiKey`) → `process.env`**. That works, but it routes the secret **through the renderer** — the one place we'd rather it never be.

---

## 2. Verified vendor auth facts (this session)

- **PyAI Hear (STT, default):** WS `GET /v1/audio/transcriptions/stream`, **`Authorization: Bearer` header only.** No subprotocol/query/ephemeral path known → **cannot** be driven from a raw webview WS. (Header auth from a non-browser process is required.)
- **Deepgram (STT):** WS `wss://api.deepgram.com/v1/listen`. Header `Authorization: Token …` **or**, for browsers, a **`Sec-WebSocket-Protocol` token subprotocol** and/or **short-lived tokens** (Deepgram token Auth API). So Deepgram *can* be browser-driven — but only via the token/subprotocol path, not the raw key.
- **OpenAI Realtime (STT):** WS `wss://api.openai.com/v1/realtime?model=…`. Docs are explicit: a **raw API key is allowed only on a "secure backend server"**; **browsers/mobile should use WebRTC + ephemeral client tokens.** Streaming models renamed since our research doc: **`gpt-live-transcribe`** (streaming) / **`gpt-transcribe`** (post-turn); audio **24 kHz PCM**; events `conversation.item.input_audio_transcription.delta` (partial) / `.completed` (final). *(Update `vendor-apis.md` §2.)*
- **Anthropic (correction):** `POST /v1/messages`, forced **tool-use** (`tool_choice:{type:"tool",name}`, `input_schema` = our compact-edits schema → `tool_use` block). HTTPS, so header-auth from any process is fine. (Confirmed live in `vendor-apis.md`.)

**Conclusion from the facts:** a **renderer-direct** design is a dead end — PyAI is header-only and OpenAI Realtime needs a server-minted ephemeral token, so the webview cannot uniformly open STT sockets *and* it would put keys in the renderer. Whatever holds the key must be a **non-renderer "secure holder"** that can set headers (and, later, mint OpenAI ephemeral tokens).

---

## 3. Options considered

**(B) Webview-direct (subprotocol/query/ephemeral).** ❌ **Rejected.** Fails for PyAI (header-only) and OpenAI Realtime (ephemeral required); leaks the key into the renderer. Only Deepgram would work. Not a uniform answer.

**(A) Rust-native STT.** Rust holds the keychain key, opens the vendor WS itself (`tokio-tungstenite`), normalizes to `TranscriptEvent`, and emits it to the webview over Tauri IPC.
- *Pros:* key never leaves Rust; true single-process, no bundled Node; smallest binary; the "purest" open-core "no server" story.
- *Cons:* the **STT adapters + per-vendor normalization get re-implemented in Rust**, abandoning the tested TS STT adapters (PyAI decoded, Deepgram mapping, and the coming OpenAI one) and maintaining vendor logic in **two languages**. Biggest lift; highest risk of drift from the vendor-neutral TS core.

**(C′) Rust-managed local sidecar.** Keep the existing Node backend, but the **app spawns and supervises it as a Tauri sidecar** instead of the user running `npm run backend`. Rust reads the Keychain and hands the key to the sidecar **via env/stdin — never through the renderer.** The webview streams mic PCM to the sidecar over loopback exactly as today.
- *Pros:* **reuses 100% of the tested TS `packages/core`** (STT + correction + format + batch, all their integration tests) with no rewrite; **fixes the key-in-renderer smell** (Rust injects the key, the webview only ever sees audio + transcripts); still **fully local / offline / nothing to deploy**, which is what the open-core "no backend required to run" promise actually means (product-plan §13); one narrow seam to change (key hand-off), not a re-architecture.
- *Cons:* ships a Node runtime inside the app (bundle size); a sidecar to package and lifecycle-manage; philosophically "a local server" even though it's 100% loopback.

---

## 4. Recommendation

**Adopt (C′) — Rust-managed local sidecar — for M4.** Keep (A) native-Rust STT as a documented **future optimization** for the public release (M6), if binary size or a strict single-process model becomes a priority.

Rationale: the vendor-neutral **TS core is the project's main asset** — adapters, pipeline, accumulator, correction, format, batch, all unit/integration-tested against mock servers. (C′) preserves every bit of it, still satisfies BYOK-local, and closes the only real security gap (secret through the renderer) by moving the key hand-off into Rust. (A) buys binary purity at the cost of a two-language rewrite of exactly the layer M4 is trying to *expand* with three new vendors — wrong time to fork it. Revisit (A) once the adapter set is stable.

**Concretely, "drop the dev backend" (m4-tasks 4.2) is refined to:** the user never again runs the backend by hand — the app owns its lifecycle as a bundled sidecar, keyed from the Keychain by Rust. The code stays; the manual step and the renderer key-path go away. The separate **hosted** proxy (product-plan §13, commercial layer) is unaffected and still optional.

### Key-handoff seam (the one thing that changes now)
- Rust `key_get(account)` already exists. Add a Rust step that, on sidecar spawn, reads the **selected** providers' keys from the Keychain and passes them to the sidecar process (env or a one-shot stdin handshake) — the webview's `start` message stops carrying `apiKey`.
- The webview keeps doing what it does well: mic capture + UI + emitting the final `formatted` text to `inject_text`.

### If we ever go (A)
The seam to port is small and already isolated: `STTProvider.startSession()` + each vendor's message→`TranscriptEvent` mapping. Correction/format/batch (HTTPS) can stay in TS regardless. So (C′)→(A) later is incremental, not a rewrite.

---

## 5. Locked config schema (`AppSettings`)

One shape, shared by core (resolver), Rust (key hand-off + language guard), and the settings UI. **Secrets are never in it** — they live in the Keychain, keyed by each provider's `requiredKeys[]`.

```ts
// packages/core — the single source of truth for provider selection.
export type SttVendor        = "pyai" | "deepgram" | "openai";
export type CorrectionVendor = "pyai" | "openai" | "anthropic";

export interface AppSettings {
  sttProvider: SttVendor;             // default "pyai"
  correctionProvider: CorrectionVendor; // default "pyai"
  language: string;                   // BCP-47 / ISO-639-1, default "en"
  // NO keys here. Keys are in the OS Keychain under the vendor's requiredKeys name
  // (PYAI_API_KEY | DEEPGRAM_API_KEY | OPENAI_API_KEY | ANTHROPIC_API_KEY).
}

export const DEFAULT_SETTINGS: AppSettings = {
  sttProvider: "pyai",
  correctionProvider: "pyai",
  language: "en",
};
```

- **Persistence:** non-secret settings (the three fields) persist as small JSON via a Tauri settings store (`tauri-plugin-store`); secrets stay in Keychain. Clean split: lose the settings file → you lose preferences, never keys; the Keychain is the only secret store.
- **Capability check (4.1):** for `{sttProvider, correctionProvider}`, resolve each provider and verify **every** `requiredKeys` entry is present via the existing `key_has` — fail fast listing all missing keys in one message (mirror `assertKeys`, extend to the correction registry).
- **Mix-and-match** falls out for free: the two roles resolve independently (e.g. `deepgram` STT + `anthropic` correction).
- **Multilingual guard (4.6):** PyAI Hear is English-only → if `sttProvider === "pyai" && language !== "en"`, block with a clear *"English-only on PyAI — choose Deepgram or OpenAI for this language"* message before a session starts.

---

## 6. Outcome / what unblocks

- **Transport decided:** Rust-managed local sidecar holds keys and opens all vendor connections (header auth); the renderer never sees a secret. → unblocks 4.2 (keychain hand-off) and 4.3–4.5 (adapters build against the same Node runtime they're already tested in — **no per-adapter transport surprises**).
- **API facts confirmed & logged:** OpenAI model rename + ephemeral-token rule, Deepgram token/subprotocol, PyAI header-only, Anthropic tool-use. → `vendor-apis.md` §2 needs the OpenAI model-id update.
- **`AppSettings` locked** → 4.1 config/capability layer and 4.6 settings UI can be built to a fixed shape.

**Gate satisfied:** the WS-auth decision is documented before 4.3–4.5 begin.
