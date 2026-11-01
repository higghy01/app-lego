// Fa funzionare l'app anche senza internet.
const VERSION = "v49";
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
  let hadOld = false;
  const done = caches.keys().then(async (keys) => {
    const old = keys.filter((k) => k.startsWith("shell-") && k !== SHELL);
    hadOld = old.length > 0;
    await Promise.all(old.map((k) => caches.delete(k)));
    await self.clients.claim();
  });
  e.waitUntil(done);
  // sasha 1/11: dopo un aggiornamento l'app aperta continuava con il programma e i dati di prima (per esempio la
  // scatola non ancora prima in galleria). Se c'era una versione vecchia, le pagine aperte si ricaricano una volta.
  // Solo DOPO l'attivazione: durante l'attivazione la pagina ricaricata resterebbe ferma ad aspettare.
  // Prima si chiede alla pagina: se risponde, si ricarica da sola quando non si sta usando la fotocamera, guardando
  // una foto grande o scrivendo (app.js, reloadWhenFree). Se non risponde (versione vecchia dell'app), la si ricarica da qui.
  done.then(() => {
    if (!hadOld) return;
    setTimeout(async () => {
      const wins = await self.clients.matchAll({ type: "window" });
      await Promise.all(wins.map(async (c) => {
        const ch = new MessageChannel();
        const answered = new Promise((ok) => { ch.port1.onmessage = () => ok(true); setTimeout(() => ok(false), 1500); });
        c.postMessage({ type: "nuova-versione" }, [ch.port2]);
        if (!(await answered) && c.navigate) c.navigate(c.url).catch(() => {});
      }));
    }, 0);
  });
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
