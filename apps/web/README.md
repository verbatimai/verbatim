# apps/web — live web demo (M2)

Vite browser app. Captures the mic, downsamples to 16 kHz PCM, streams it to the
dev backend, and renders the **live transcript** (stable = solid, active = dim)
plus the **visible correction** animation (removed spans strike through and fade,
replacements swap in, color-coded by reason).

## Run
```bash
# terminal 1 — the bridge (see apps/backend)
npm run backend
# terminal 2 — the web app
npm run web         # http://localhost:5173
```
- **Demo (no mic)** button → replays a real captured sample via the backend's demo mode; needs no key or microphone.
- **Start dictation** → asks for mic permission and streams live (backend must have a vendor key).

Override the backend URL with `VITE_WS_URL`.

## Notes
- Audio is captured with a `ScriptProcessorNode` for portability; a future pass can move to an `AudioWorklet`.
- The correction animation logic here is the same one the desktop widget (M3) will reuse.
