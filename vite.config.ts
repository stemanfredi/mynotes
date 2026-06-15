import { defineConfig } from "vite";

// Vite (Rollup) bundles the client and dedupes @codemirror/state to a single
// copy — sidestepping the no-build esm.sh duplicate-state bug. In dev, proxy the
// API to the Bun server so the whole app is same-origin at http://localhost:5180.
export default defineConfig({
  server: {
    host: true,                 // bind 0.0.0.0 so a reverse proxy / tunnel can reach it
    port: 5180,
    strictPort: true,
    allowedHosts: ["notes.example.com"], // Vite 6 blocks unknown Host headers otherwise
    proxy: {
      "/api": "http://localhost:8911",
    },
    // The tunnel terminates TLS at :443, so point HMR's websocket there.
    hmr: { protocol: "wss", host: "notes.example.com", clientPort: 443 },
  },
  build: { outDir: "dist", target: "es2022" },
});
