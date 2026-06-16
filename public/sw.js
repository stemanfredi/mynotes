// Hand-written service worker (no Workbox / no build plugin). It runtime-caches
// same-origin GET requests so the app shell and already-visited assets keep
// working offline. The /api/* surface is owned by the client's IndexedDB layer
// (src/idb.ts + src/api.ts), so the worker bypasses it entirely.
//
// Assets ship with hashed filenames, so "cache on first fetch" is enough — no
// hardcoded precache list to keep in sync. Bump CACHE to evict everything.
const CACHE = "mynotes-v1";

// Precache the app shell so an offline navigation always has something to serve,
// even on the first load that this worker controls. Hashed assets aren't listed
// here (their names aren't known ahead of time) — they're cached on first fetch.
self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(["/", "/index.html"]).catch(() => {}); // best-effort; offline install still activates
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Network-first, cache fallback. Successful responses are cached as we go; when
// the network is gone we serve the cached copy, falling back to the app shell for
// navigations so a cold reload still boots offline.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // IDB layer owns API offline behaviour

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(req);
      if (fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    } catch {
      const cached = await cache.match(req);
      if (cached) return cached;
      if (req.mode === "navigate") {
        const shell = (await cache.match("/")) || (await cache.match("/index.html"));
        if (shell) return shell;
      }
      throw new Error("offline and not cached");
    }
  })());
});
