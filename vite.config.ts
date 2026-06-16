import { defineConfig } from "vite";

// Set DEV_HOST to the public hostname when serving `bun run dev` through a
// reverse proxy / tunnel (e.g. DEV_HOST=notes.example.com bun run dev). It then
// allows that Host header and points HMR's websocket at the TLS endpoint (:443).
// Unset (plain localhost dev) needs neither. Keeps deployment hostnames out of
// committed source.
const DEV_HOST = process.env.DEV_HOST;

// Vite (Rollup) bundles the client and dedupes @codemirror/state to a single
// copy — sidestepping the no-build esm.sh duplicate-state bug. In dev, proxy the
// API to the Bun server so the whole app is same-origin at http://localhost:5180.
export default defineConfig({
  server: {
    host: true, // bind 0.0.0.0 so a reverse proxy / tunnel can reach it
    port: 5180,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8911",
    },
    allowedHosts: DEV_HOST ? [DEV_HOST] : undefined, // Vite blocks unknown Host headers otherwise
    hmr: DEV_HOST ? { protocol: "wss", host: DEV_HOST, clientPort: 443 } : undefined,
  },
  build: { outDir: "dist", target: "es2022" },
});
