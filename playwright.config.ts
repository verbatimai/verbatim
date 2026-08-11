import { defineConfig } from "@playwright/test";

// e2e runs the real web app (Vite) + backend on isolated ports so a leftover dev
// server can't interfere. In CI/cloud, point at a system Chromium via
// PLAYWRIGHT_CHROMIUM_PATH; on a dev machine, `npx playwright install chromium`.
const VITE_PORT = process.env.E2E_VITE_PORT ?? "5199";
const BACKEND_PORT = process.env.E2E_BACKEND_PORT ?? "8801";
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: { baseURL: `http://localhost:${VITE_PORT}` },
  projects: [
    {
      name: "chromium",
      use: {
        launchOptions: {
          args: ["--no-sandbox"],
          ...(chromiumPath ? { executablePath: chromiumPath } : {}),
        },
      },
    },
  ],
  webServer: {
    command: "npm run web",
    url: `http://localhost:${VITE_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { ...process.env, VITE_PORT, BACKEND_WS: `ws://127.0.0.1:${BACKEND_PORT}` },
  },
});
