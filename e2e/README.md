# e2e (Playwright)

Drives the real web app in a headless browser: the **Demo** flow must stream a
live transcript, animate the "what was removed" diff, and produce a formatted
final output — with no JS console errors. Backend + Vite are started on isolated
ports by the suite (demo mode needs no key or mic).

## Run
```bash
# one-time on a dev machine:
npx playwright install chromium

# from the repo root:
npm run test:e2e
```

In CI or a sandbox with a system Chromium, point Playwright at it instead of
installing:
```bash
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome npm run test:e2e
```

Ports can be overridden with `E2E_VITE_PORT` / `E2E_BACKEND_PORT` (defaults 5199 / 8801).
