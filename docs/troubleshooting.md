# Troubleshooting

## "cannot reach dev server" (web app)
The browser connects to the **same origin the page loads from** (`ws://localhost:5173/ws`), and Vite proxies `/ws` to the backend on `127.0.0.1:8787`. This avoids the macOS "`localhost` → IPv6 `::1`" mismatch that makes a cross-port socket look unreachable even when the backend is clearly up in the terminal. Fixes:
1. **Run both with one command** from the repo root: `npm run dev`. Open http://localhost:5173 and use that tab (the proxy only exists on the Vite origin).
2. If you started them separately, both must be running: `npm run backend` **and** `npm run web`. The browser still connects via the web app's port (5173), not 8787 directly.
3. **Port already in use** — if the backend logs `port 8787 is already in use`, kill the stray copy (`lsof -ti:8787 | xargs kill`) or use another port: set `PORT=8888` for the backend and update the proxy target in `apps/web/vite.config.ts` to `ws://127.0.0.1:8888`.
4. Make sure you ran `npm install` at the repo root first (installs all workspaces).
5. If you opened the built app (not the Vite dev server) there's no proxy — set `VITE_WS_URL=ws://127.0.0.1:8787` at build time, or just use `npm run dev`.

## "Live mode needs PYAI_API_KEY" / "no key found"
This appears only when you click **Start dictation** (live mode). Two options:
- **Demo mode needs no key** — click **Demo (no mic)** to see the whole flow immediately (it replays a real captured sample).
- **For live mode**, give the backend a key. Easiest: create a `.env` file at the repo root (copy `.env.example`) with:
  ```
  PYAI_API_KEY=pyai_...
  STT_PROVIDER=pyai
  CORRECTION_PROVIDER=pyai
  ```
  The backend loads `.env` on start (watch for `[backend] loaded env from …` and `PYAI_API_KEY=set` in its logs). Restart the backend after editing `.env`. You can also just export it: `PYAI_API_KEY=... npm run dev`.

## Backend starts but the browser shows an error on "Start dictation"
Check the backend terminal. It logs `PYAI_API_KEY=set|MISSING` at startup and prints each session's providers. If the key is `MISSING`, see above.

## Node version
Use Node 20+ (22 recommended). The backend uses global `fetch` (Node 18+) and the tooling targets modern Node.

## Microphone doesn't work / no permission
Browsers only allow mic capture on `http://localhost` or HTTPS. Use the Vite URL (`http://localhost:5173`), and allow the mic permission prompt. If you denied it, reset the site permission in the browser and reload. (Demo mode needs no mic.)

## Nothing renders / blank page
Rebuild and re-run: `npm run web` (dev) or `npm run build --workspace @verbatim/web`. Check the browser console for errors.
