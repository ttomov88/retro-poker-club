/* Retro Poker Club — service worker

   The app's own files are served from one versioned cache, all from the same
   release: a new release is downloaded completely in the background (install),
   then swapped in at once (activate), and the page reloads at a safe moment.
   So a phone never runs a mix of old and new files.
   Bump CACHE_VERSION with every release. Club data never goes through here
   (Supabase requests are left alone); the app keeps its own offline copy. */

const CACHE_VERSION = "rpc-v24";
const APP_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./db.js",
  "./auth.js",
  "./vendor/supabase.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      // cache: "reload" skips the browser's HTTP cache, so every file is the new release
      .then((cache) => cache.addAll(APP_FILES.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting())
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

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.hostname.endsWith(".supabase.co")) return;

  if (url.origin === self.location.origin) {
    // App files: from this release's cache; the network only for anything not in it.
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) => {
        const key = request.mode === "navigate" ? "./index.html" : request;
        return cache.match(key, { ignoreSearch: true }).then((hit) => hit || fetch(request));
      })
    );
    return;
  }

  // Fonts (Google): network first, cached copy when offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && (response.ok || response.type === "opaque")) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || Response.error()))
  );
});
