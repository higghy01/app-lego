// Fa funzionare l'app anche senza internet.
const VERSION = "v48";
const SHELL = "shell-" + VERSION;
const DATA = "data";
const IMAGES = "images";
const MAX_IMAGES = 200;
const GALLERY = "gallery";
const MAX_GALLERY = 300;
const DATA_FILES = ["data/catalog.json", "data/minifigs.json", "data/extra.json"];
const NETWORK_TIMEOUT = 3000;
const SHELL_FILES = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest",
  "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "vendor/zxing-browser.min.js", "vendor/fredoka.woff2"];

self.addEventListener("install", (e) => {
  // Alla prima apertura salva subito app e catalogo, così funziona anche offline.
  e.waitUntil(Promise.all([
    // no-cache: mai la copia vecchia del browser, sennò la nuova versione partirebbe con i dati di prima
    caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((f) => new Request(f, { cache: "no-cache" })))),
    caches.open(DATA).then((c) => c.addAll(DATA_FILES.map((f) => new Request(f, { cache: "no-cache" })))).catch(() => {}),
  ]).then(() => self.skipWaiting()));
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
    e.respondWith(freshData(req));
  } else if (url.origin === location.origin) {
    e.respondWith(networkFirst(req));
  } else if (url.hostname.endsWith("rebrickable.com")) {
    e.respondWith(cachedImage(req, IMAGES, MAX_IMAGES));
  } else if (url.hostname === "images.brickset.com") {
    // Foto della galleria in una cache a parte, così non fanno sparire quelle degli elenchi.
    e.respondWith(cachedImage(req, GALLERY, MAX_GALLERY));
  }
});

// Catalogo e foto scelte: sempre quelli nuovi se c'è internet (sasha 1/11: prima il telefono mostrava i dati
// della volta prima, per esempio la scatola non ancora messa per prima). Si chiede al sito se sono cambiati
// (no-cache: se non sono cambiati la risposta è piccolissima); senza internet, o se il sito non risponde
// entro 3 secondi, si usa la copia salvata, e quella nuova si salva appena arriva.
async function freshData(req) {
  const cache = await caches.open(DATA);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req.url, { cache: "no-cache" }).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  if (!cached) return network;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT));
  try {
    const res = await Promise.race([network, timeout]);
    return res && res.ok ? res : cached;
  } catch (err) {
    return cached;
  }
}

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req.url, { cache: "no-cache" }).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  // Con internet lento non si aspetta più di 3 secondi: si usa la copia salvata.
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), cached ? NETWORK_TIMEOUT : 60000));
  try {
    return (await Promise.race([network, timeout])) || cached;
  } catch (err) {
    return cached || (await cache.match("index.html"));
  }
}

async function cachedImage(req, name, max) {
  const cache = await caches.open(name);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  // Una risposta sbagliata (sito momentaneamente giù) non si salva: alla prossima apertura si riprova.
  // Le foto di altri siti arrivano "chiuse" (opaque, senza codice di stato): quelle si salvano come prima.
  if (!res.ok && res.type !== "opaque") return res;
  cache.put(req, res.clone()).then(async () => {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
  });
  return res;
}
