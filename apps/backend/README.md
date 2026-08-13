# apps/backend — dev bridge (M2)

Node WebSocket server that bridges the browser to `@verbatim/core`: it
runs the STT + correction pipeline with the **vendor key held server-side** and
streams `live` / `correction` / `done` events back to the web client.

## Run
```bash
# from the repo root
npm install
# offline demo (no key, no mic) — the browser can request mode:"demo"
npm run backend
# live: provide a key in the server env
PYAI_API_KEY=... STT_PROVIDER=pyai CORRECTION_PROVIDER=pyai npm run backend
```
Listens on `ws://localhost:8787` (override with `PORT`).

## Protocol
- Browser → server: `{type:"start", mode:"live"|"demo"}`, then binary PCM16 frames (16 kHz mono), then `{type:"stop"}`.
- Server → browser: `{type:"ready",...}`, `{type:"live", stableText, activeText, ...}`, `{type:"correction", cleanText, ops, latencyMs, valid, ...}`, `{type:"error"}`, `{type:"done"}`.

`mode:"demo"` forces the `fixture` STT + `mock` correction so it runs with no key
or mic. Headless check: `node apps/backend/smoke.mjs` (start the server first).

> This is the open-core boundary: the OSS client can also talk BYOK-direct to a
> vendor; this proxy is the "keys never touch the device" path (see the plan).
