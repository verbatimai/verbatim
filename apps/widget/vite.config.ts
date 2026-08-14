import { defineConfig } from "vite";
import { resolve } from "node:path";

// Tauri expects the dev server on a fixed port (see src-tauri/tauri.conf.json devUrl).
// Multi-page: `main` = the overlay (index.html), `app` = the desktop main window / History
// tab (app.html), `settings` = the settings screen (settings.html), `meetings` = the
// meetings recorder (meetings.html), `notes` = the plain-text notes list (notes.html).
// The dev server serves each by filename; the build emits all.
export default defineConfig({
  clearScreen: false,
  server: { port: 5175, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        app: resolve(__dirname, "app.html"),
        settings: resolve(__dirname, "settings.html"),
        meetings: resolve(__dirname, "meetings.html"),
        notes: resolve(__dirname, "notes.html"),
      },
    },
  },
});
