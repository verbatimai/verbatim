import { defineConfig } from "vite";
import { resolve } from "node:path";

// Tauri expects the dev server on a fixed port (see src-tauri/tauri.conf.json devUrl).
// Multi-page: `main` = the overlay (index.html), `app` = the desktop main window
// (app.html — notes/history/settings shell), `settings` = the settings screen
// (settings.html). The dev server serves each by filename; the build emits all.
export default defineConfig({
  clearScreen: false,
  server: { port: 5175, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        app: resolve(__dirname, "app.html"),
        settings: resolve(__dirname, "settings.html"),
      },
    },
  },
});
