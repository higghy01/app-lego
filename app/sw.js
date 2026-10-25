// Fa funzionare l'app anche senza internet.
const VERSION = "v1";
const SHELL = "shell-" + VERSION;
const DATA = "data";
const IMAGES = "images";
const MAX_IMAGES = 400;
const SHELL_FILES = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest",
  "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k.startsWith("shell-") && k !== SHELL).map((k) => caches.delete(k))
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.includes("/data/")) {
    e.respondWith(staleWhileRevalidate(req));
  } else if (url.origin === location.origin) {
    e.respondWith(networkFirst(req));
  } else if (url.hostname.endsWith("rebrickable.com")) {
    e.respondWith(cachedImage(req));
  }
});

// Catalogo: si apre subito con la copia salvata e intanto si scarica quella nuova.
async function staleWhileRevalidate(req) {
  const cache = await caches.open(DATA);
  const cached = await cache.match(req, { ignoreSearch: true });
  const fresh = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || fresh;
}

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return (await cache.match(req, { ignoreSearch: true })) || (await cache.match("index.html"));
  }
}

async function cachedImage(req) {
  const cache = await caches.open(IMAGES);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  cache.put(req, res.clone()).then(async () => {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - MAX_IMAGES; i++) await cache.delete(keys[i]);
  });
  return res;
}
