/* Najpierw sieć, a bez połączenia kopia z pamięci: aplikacja pokazuje najnowsze dane, a bez internetu ostatnio pobrane. */
const CACHE = "analizator-v1", SHELL = ["./", "index.html", "engine.js", "data.js", "manifest.webmanifest", "icon-192.png"];
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})); });
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || (e.request.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});
