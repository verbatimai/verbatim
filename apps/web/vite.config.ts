import { defineConfig } from "vite";

// The browser talks only to the Vite origin; /ws is proxied to the backend.
// Target is explicit IPv4 (avoids the macOS "localhost -> ::1" mismatch) and can
// be overridden via BACKEND_WS (used by the e2e suite to isolate the port).
const backend = process.env.BACKEND_WS ?? "ws://127.0.0.1:8787";

export default defineConfig({
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    proxy: {
      "/ws": { target: backend, ws: true },
    },
  },
});
