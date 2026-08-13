import { defineConfig } from "vite";
import { resolve } from "node:path";

// Tauri expects the dev server on a fixed port (see src-tauri/tauri.conf.json devUrl).
// Multi-page: `main` = the overlay (index.html), `settings` = the desktop settings window
// (settings.html). The dev server serves both by filename; the build emits both.
export default defineConfig({
  clearScreen: false,
  server: { port: 5175, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
      },
    },
  },
});
