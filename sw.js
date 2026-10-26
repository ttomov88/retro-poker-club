/* Retro Poker Club — service worker
   Network-first (so updates show up right away), but if the network hasn't
   answered within NETWORK_TIMEOUT_MS the cached copy is served instead, so a
   weak signal at the table doesn't leave you staring at a blank screen. */

const CACHE_VERSION = "rpc-v7";
const NETWORK_TIMEOUT_MS = 3000;
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./db.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fromCache(request) {
  return caches.match(request).then((cached) => {
    if (cached) return cached;
    // Only page navigations fall back to the app shell; a missing image or
    // stylesheet must not be answered with HTML.
    if (request.mode === "navigate") return caches.match("./index.html");
    return undefined;
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const network = fetch(request).then((response) => {
    // Cache only good responses (no 404/500 pages, no opaque responses).
    if (response && response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)));
    }
    return response;
  });

  event.respondWith(
    new Promise((resolve) => {
      let done = false;
      const finish = (res) => {
        if (!done && res) {
          done = true;
          resolve(res);
        }
      };

      const timer = setTimeout(() => {
        fromCache(request).then(finish); // slow network: serve cache if we have it
      }, NETWORK_TIMEOUT_MS);

      network
        .then((res) => {
          clearTimeout(timer);
          finish(res);
        })
        .catch(() => {
          clearTimeout(timer);
          fromCache(request).then((res) => {
            if (res) finish(res);
            else if (!done) {
              done = true;
              resolve(Response.error());
            }
          });
        });
    })
  );
});
