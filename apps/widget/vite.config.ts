import { defineConfig } from "vite";

// Tauri expects the dev server on a fixed port (see src-tauri/tauri.conf.json devUrl).
export default defineConfig({
  clearScreen: false,
  server: { port: 5175, strictPort: true },
});
