"use strict";

// ---------- Costanti ----------

const STATUSES = [
  { id: "none", label: "Non posseduto" },
  { id: "wish", label: "Desiderato" },
  { id: "owned", label: "Posseduto da costruire" },
  { id: "building", label: "In costruzione" },
  { id: "built", label: "Costruito" },
  { id: "apart", label: "Smontato" },
];
const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.id, s.label]));
const OWNED = ["owned", "building", "built", "apart"];
const PAGE = 60;
const STORE_KEY = "lego-collezione-v1";
const BACKUP_KEY = "lego-ultimo-backup";
const PREV_KEY = "lego-collezione-prima-import";
const BACKUP_SNOOZE_KEY = "lego-backup-rimanda";
const MODE_KEY = "lego-collezione-vista"; // "cat" = per categoria (di partenza), "list" = tutti i set
const CAT_SEEN_KEY = "lego-categorie-viste"; // quanti set costruiti c'erano per categoria l'ultima volta (per la festa)
const BACKUP_DAYS = 30; // dopo tanti giorni senza backup, con modifiche nuove, in Collezione compare un promemoria
const NA = '<span class="na">non disponibile</span>';

// ---------- Stato ----------

const state = {
  catalog: null,        // { generated, sets: [...], bySetNum, themes }
  minifigs: null,       // caricato solo quando serve
  collection: loadCollection(),
  filters: { q: "", theme: "", sub: "", yearFrom: "", yearTo: "", partsMin: "", partsMax: "", status: "", onlyParts: true, sort: "year" },
  collectionVersion: 0, // cambia a ogni modifica, così il filtro per stato si aggiorna
  showFilters: false,
  shown: PAGE,
  catalogScroll: 0,
  collectionChip: "all",
  collectionMode: (() => { try { return localStorage.getItem(MODE_KEY) === "list" ? "list" : "cat"; } catch { return "cat"; } })(),
  photoCounts: {},      // numero di foto per set (le foto sono in IndexedDB)
};

// ---------- Utilità ----------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
// In italiano anche 4 cifre col punto (1.530): "de-DE" usa gli stessi separatori ma raggruppa sempre.
const fmtNum = (n) => (n == null ? null : n.toLocaleString("de-DE"));
const fmtDate = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" }) : "";
};

// Durata in minuti scritta come "2 h 15 min".
const fmtDuration = (min) => {
  const h = Math.floor(min / 60), m = min % 60;
  return [h ? `${fmtNum(h)} h` : "", m || !h ? `${m} min` : ""].filter(Boolean).join(" ");
};

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Data di oggi secondo l'ora del telefono (non quella di Greenwich).
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isIosBrowser() {
  // Gli iPad recenti si presentano come Mac: li riconosciamo dallo schermo touch.
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  return ios && !standalone;
}

const SAFARI_WARNING = `<div class="warn">Stai usando Safari: i set che segni qui restano solo in Safari e possono essere cancellati, e l'app installata non li vede. Prima installa l'app (Condividi → Aggiungi alla schermata Home) e usa sempre quella. Se hai già segnato dei set qui: Backup → Esporta, poi nell'app installata Backup → Importa.</div>`;

function imgUrl(path, base) {
  if (!path) return "";
  return /^https?:/.test(path) ? path : base + path;
}

// Miniature più leggere di Rebrickable; se non esistono si usa l'immagine originale.
function thumbUrl(full) {
  const m = full.match(/^https:\/\/cdn\.rebrickable\.com\/media\/(sets\/.+)$/);
  return m ? `https://cdn.rebrickable.com/media/thumbs/${m[1]}/250x250p.jpg` : full;
}

window.imgFallback = (img) => {
  const full = img.dataset.full;
  if (full && img.src !== full) { img.src = full; return; }
  const box = document.createElement("div");
  // Nelle caselle dei temi resta il riquadro con il mattoncino disegnato, senza scritta.
  const tile = img.classList.contains("tile-img");
  box.className = tile || img.classList.contains("block-img") ? img.className : img.className.includes("hero") ? "noimg" : "thumb";
  if (!tile) box.textContent = "Immagine non disponibile";
  img.replaceWith(box);
};

function imgTag(set, cls) {
  if (!set.img) return `<div class="${cls === "hero" ? "noimg" : "thumb"}">Immagine non disponibile</div>`;
  const src = cls === "hero" ? set.img : thumbUrl(set.img);
  return `<img class="${cls}" src="${esc(src)}" data-full="${esc(set.img)}" alt="" loading="lazy" decoding="async" onerror="imgFallback(this)">`;
}

// ---------- Collezione (salvata sul telefono) ----------

function loadCollection() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}

function saveCollection() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.collection));
    return true;
  } catch (err) {
    alert("Attenzione: non sono riuscito a salvare la modifica (memoria del telefono piena?). Fai un backup e libera spazio.");
    return false;
  }
}

function entry(setNum) {
  return state.collection[setNum] || { s: "none" };
}

function updateEntry(setNum, changes) {
  const e = { ...entry(setNum), ...changes, u: new Date().toISOString() };
  state.collectionVersion++;
  if (e.s === "none" && !e.f && !e.n && !e.d && !e.v && !e.t && !e.w) delete state.collection[setNum];
  else state.collection[setNum] = e;
  return saveCollection();
}

// ---------- Foto (salvate sul telefono in IndexedDB, che regge file grandi) ----------

const PHOTO_DB = "lego-foto";
const PHOTO_MAX_SIDE = 1600; // pixel: abbastanza per vederla bene, ma leggera (circa 200-400 KB)
let photoDbPromise = null;

function photoDb() {
  photoDbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(PHOTO_DB, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore("foto", { keyPath: "id" });
      store.createIndex("set", "set");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { photoDbPromise = null; reject(req.error); };
  });
  return photoDbPromise;
}

async function photoTx(mode, fn) {
  const db = await photoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("foto", mode);
    const out = fn(tx.objectStore("foto"));
    tx.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("operazione annullata"));
  });
}

const photosOf = (setNum) => photoTx("readonly", (st) => st.index("set").getAll(setNum))
  .then((list) => list.sort((a, b) => a.date.localeCompare(b.date)));
const allPhotos = () => photoTx("readonly", (st) => st.getAll());
const putPhoto = (p) => photoTx("readwrite", (st) => st.put(p));
const deletePhoto = (id) => photoTx("readwrite", (st) => st.delete(id));

// Numero di foto per set, per mostrare 📷 negli elenchi e contarle nelle statistiche.
async function loadPhotoCounts() {
  const counts = {};
  try {
    const db = await photoDb();
    await new Promise((resolve, reject) => {
      const req = db.transaction("foto").objectStore("foto").index("set").openKeyCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) { resolve(); return; }
        counts[c.key] = (counts[c.key] || 0) + 1;
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {}
  state.photoCounts = counts;
  return counts;
}

// Rimpicciolisce la foto del telefono (spesso 3-5 MB) a un JPEG leggero.
async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(Object.assign(new Error("immagine non leggibile"), { notImage: true }));
      el.src = url;
    });
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob) throw new Error("conversione non riuscita");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

function dataUrlToBlob(url) {
  const m = /^data:(image\/[\w+.-]+);base64,(.*)$/s.exec(url);
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}

// ---------- Catalogo ----------

async function loadCatalog() {
  const res = await fetch("data/catalog.json");
  if (!res.ok) throw new Error("catalogo non trovato");
  const raw = await res.json();
  const themes = {};
  for (const [id, [name, parent]] of Object.entries(raw.themes)) themes[id] = { id: +id, name, parent };
  // Catena dei temi dal principale al più specifico, es. [Star Wars, Ultimate Collector Series].
  const chainOf = (id) => {
    const chain = [];
    for (let t = themes[id]; t && !chain.includes(t.id); t = t.parent != null ? themes[t.parent] : null) chain.unshift(t.id);
    return chain;
  };
  const sets = raw.sets.map(([setNum, name, year, themeId, parts, img, figs, partsFrom]) => {
    const chain = chainOf(themeId);
    return {
      setNum, name, year, themeId, figs, chain,
      parts: parts || null, // 0 pezzi = dato mancante (libri, gadget…)
      partsFrom: parts && partsFrom ? partsFrom : null, // "Brickset" quando Rebrickable non ha ancora il numero di pezzi (set appena annunciati)
      img: imgUrl(img, raw.imgBase),
      root: chain[0] ?? null,
      base: setNum.replace(/-\d+$/, ""),
      // Ordine dei codici: i numeri contano per valore (9 prima di 10), come fa Intl.Collator ma molto più veloce.
      codeKey: setNum.toLowerCase().replace(/\d+/g, (d) => d.replace(/^0+(?=\d)/, "").padStart(20, "0")),
    };
  });
  // Ordinamento per codice calcolato una volta sola, così la ricerca resta veloce.
  // Quello per nome (più lento) e il testo per la ricerca si preparano solo la prima volta che servono.
  const collator = new Intl.Collator("it", { numeric: true, sensitivity: "base" });
  [...sets].sort((a, b) => (a.codeKey < b.codeKey ? -1 : a.codeKey > b.codeKey ? 1 : 0)).forEach((s, i) => { s.codeRank = i; });
  const bySetNum = new Map(sets.map((s) => [s.setNum, s]));
  const byTheme = (ids) => [...ids].filter((id) => themes[id]).map((id) => themes[id]).sort((a, b) => collator.compare(a.name, b.name));
  const children = {};
  for (const s of sets) {
    for (let i = 1; i < s.chain.length; i++) (children[s.chain[i - 1]] ||= new Set()).add(s.chain[i]);
  }
  const rootThemes = byTheme(new Set(sets.map((s) => s.root).filter((id) => id != null)));
  state.catalog = { generated: raw.generated, sets, bySetNum, themes, rootThemes, children, byTheme, imgBase: raw.imgBase, collator };
}

// Testo in cui cercare (nome, codice, temi), preparato la prima volta che si cerca.
function searchKey(s) {
  const { themes } = state.catalog;
  return (s.key ??= norm(s.name) + " " + norm(s.setNum) + " " + s.chain.map((id) => norm(themes[id].name)).join(" "));
}

// Posizione in ordine alfabetico, calcolata la prima volta che si ordina per nome.
function nameRanks() {
  const { sets, collator } = state.catalog;
  if (sets[0]?.nameRank == null) [...sets].sort((a, b) => collator.compare(a.name, b.name)).forEach((s, i) => { s.nameRank = i; });
}

// Dati Brickset: codici a barre, età, prezzi, valutazioni (caricati solo quando servono).
async function loadExtra() {
  if (state.extra) return state.extra;
  const res = await fetch("data/extra.json");
  if (!res.ok) throw new Error("dati extra non trovati");
  const raw = await res.json();
  state.extra = { sets: raw.sets || {}, imgBase: raw.imgBase, detailFiles: raw.detailFiles };
  return state.extra;
}

// Codici a barre → set: preparati solo la prima volta che si scansiona.
function barcodeIndex() {
  const extra = state.extra;
  if (extra.barcodes) return extra.barcodes;
  const barcodes = new Map();
  for (const [setNum, info] of Object.entries(extra.sets)) {
    for (const code of [info.ean, info.upc]) {
      const key = normBarcode(code);
      if (!key) continue;
      if (!barcodes.has(key)) barcodes.set(key, []);
      if (!barcodes.get(key).includes(setNum)) barcodes.get(key).push(setNum);
    }
  }
  return (extra.barcodes = barcodes);
}

// Descrizione, tag e foto in più di un set (da Brickset): divisi in tanti file piccoli,
// si scarica solo quello del set aperto. Stesso calcolo di detail_file in build_catalog.py.
const detailCache = new Map();
function detailFile(setNum, files) {
  let h = 0;
  for (const ch of setNum) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return h % files;
}

async function loadDetails(setNum) {
  const extra = await loadExtra();
  if (!extra.detailFiles) return null;
  const n = detailFile(setNum, extra.detailFiles);
  if (!detailCache.has(n)) {
    detailCache.set(n, fetch(`data/dettagli/${n}.json`).then((res) => {
      if (!res.ok) throw new Error("dettagli non trovati");
      return res.json();
    }).catch((err) => { detailCache.delete(n); throw err; }));
  }
  const raw = await detailCache.get(n);
  const info = raw.sets?.[setNum];
  if (!info) return null;
  // Le foto arrivano come [foto, miniatura] senza l'indirizzo iniziale: lo rimettiamo.
  const full = (path) => (path && !/^https?:/.test(path) ? raw.imgBase + path : path);
  return { ...info, imgs: (info.imgs || []).map(([img, thumb]) => ({ img: full(img), thumb: full(thumb) || full(img) })) };
}

// I codici UPC (12 cifre) e EAN (13 cifre) dello stesso prodotto differiscono solo per gli zeri iniziali.
function normBarcode(code) {
  const digits = String(code ?? "").replace(/\D/g, "").replace(/^0+/, "");
  return digits.length >= 6 ? digits : "";
}

const PRICE_PLACES = [["DE", "€", "prezzo LEGO in Germania"], ["UK", "£", "prezzo LEGO nel Regno Unito"], ["US", "$", "prezzo LEGO negli Stati Uniti"], ["CA", "C$", "prezzo LEGO in Canada"]];

function fmtPrice(prices) {
  if (!prices) return NA;
  const rows = PRICE_PLACES.filter(([c]) => prices[c])
    .map(([c, sym, label]) => `${esc(prices[c].toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }))} ${sym} <span class="muted small">(${label})</span>`);
  return rows.length ? rows.join("<br>") : NA;
}

function fmtAge(age) {
  if (!age) return NA;
  const [min, max] = age;
  if (min && max) return `${min}-${max} anni`;
  if (min) return `${min}+ anni`;
  return max ? `fino a ${max} anni` : NA;
}

async function loadMinifigs() {
  if (state.minifigs) return state.minifigs;
  const res = await fetch("data/minifigs.json");
  if (!res.ok) throw new Error("minifigure non trovate");
  state.minifigs = await res.json();
  return state.minifigs;
}

function themePath(themeId) {
  const { themes } = state.catalog;
  const path = [];
  for (let t = themes[themeId]; t; t = t.parent != null ? themes[t.parent] : null) path.unshift(t.name);
  return { theme: path[0] || null, sub: path.length > 1 ? path.slice(1).join(" › ") : null };
}

let filteredCache = { sig: null, list: [] };

function filteredSets() {
  const f = state.filters;
  const sig = JSON.stringify(f) + "|" + state.collectionVersion;
  if (filteredCache.sig === sig) return filteredCache.list;
  const q = norm(f.q.trim());
  // Una ricerca fatta solo di cifre (es. 10294 o 10294-1) è un codice: cerca dall'inizio del codice.
  const isCode = /^\d+(-\d*)?$/.test(q);
  const words = isCode ? [] : q.split(/\s+/).filter(Boolean);
  const num = (v) => (v === "" ? null : Number(v));
  const yFrom = num(f.yearFrom), yTo = num(f.yearTo), pMin = num(f.partsMin), pMax = num(f.partsMax);
  const theme = f.sub !== "" ? Number(f.sub) : f.theme !== "" ? Number(f.theme) : null;
  let list = state.catalog.sets.filter((s) => {
    if (isCode && !s.setNum.startsWith(q)) return false;
    if (words.length && !words.every((w) => searchKey(s).includes(w))) return false;
    if (theme != null && !s.chain.includes(theme)) return false;
    if (f.onlyParts && s.parts == null && !s.figs) return false;
    if (yFrom != null && !(s.year != null && s.year >= yFrom)) return false;
    if (yTo != null && !(s.year != null && s.year <= yTo)) return false;
    if (pMin != null && !(s.parts != null && s.parts >= pMin)) return false;
    if (pMax != null && !(s.parts != null && s.parts <= pMax)) return false;
    if (f.status) {
      const st = entry(s.setNum).s;
      if (f.status === "fav" ? !entry(s.setNum).f : st !== f.status) return false;
    }
    return true;
  });
  // Se si cerca un codice, il set esatto e le sue versioni (10294-1, 10294-2…) vanno in cima.
  const codeMatch = (s) => (!isCode ? 2 : s.setNum === q ? 0 : s.base === q ? 1 : 2);
  const sorters = {
    year: (a, b) => (b.year || 0) - (a.year || 0) || a.codeRank - b.codeRank,
    yearAsc: (a, b) => (a.year || 0) - (b.year || 0) || a.codeRank - b.codeRank,
    name: (a, b) => a.nameRank - b.nameRank,
    parts: (a, b) => (b.parts || 0) - (a.parts || 0) || a.codeRank - b.codeRank,
  };
  if (f.sort === "name") nameRanks();
  const sorter = sorters[f.sort] || sorters.year;
  list.sort((a, b) => {
    const ca = codeMatch(a), cb = codeMatch(b);
    if (ca !== cb) return ca - cb;
    return ca < 2 ? a.codeRank - b.codeRank : sorter(a, b);
  });
  filteredCache = { sig, list };
  return list;
}

// ---------- Viste ----------

function setHeader(title, back) {
  $("header.top").innerHTML = (back ? `<a class="back" href="${back}" onclick="return goBack()">‹ Indietro</a>` : "") +
    `<h1>${esc(title)}</h1>`;
}

window.goBack = () => {
  if (history.length > 1 && state.cameFromApp) { history.back(); return false; }
  return true;
};

function setTab(name) {
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === name));
}

// Un set negli elenchi: un blocco con la foto grande, come un mattoncino (i bottoncini sopra hanno il colore dello stato).
function setItem(s) {
  const e = entry(s.setNum);
  const meta = [s.setNum, s.year].filter(Boolean).join(" · ");
  const label = e.s === "owned" ? "Da costruire" : STATUS_LABEL[e.s]; // corto: il blocco è stretto
  const badge = e.s !== "none" ? `<span class="badge st-${e.s}" title="${esc(STATUS_LABEL[e.s])}">${esc(label)}</span>` : "";
  const icons = (state.photoCounts[s.setNum] ? '<span title="Ha foto">📷</span>' : "") + (e.f ? '<span title="Preferito">❤️</span>' : "");
  return `<li><a class="item block" data-st="${e.s}" href="#/set/${encodeURIComponent(s.setNum)}">
    <span class="block-pic">${listImg(s, "block-img")}${releaseBadge(s, true)}${icons ? `<span class="block-icons">${icons}</span>` : ""}</span>
    <span class="name">${esc(s.name)}</span>
    <span class="meta">${esc(meta)}</span>
    ${s.parts != null ? `<span class="meta">${fmtNum(s.parts)} pezzi</span>` : ""}
    ${e.v ? `<span class="stars-small" aria-label="Voto ${e.v} su 5">${starText(e.v)}</span>` : ""}${badge ? `<span class="block-st">${badge}</span>` : ""}
  </a></li>`;
}

// Persone con cui ha costruito (campo "w"): tutti i nomi già usati, i più frequenti per primi.
function knownBuddies() {
  const count = new Map();
  for (const e of Object.values(state.collection)) for (const name of e.w || []) count.set(name, (count.get(name) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "it")).map(([name]) => name);
}

// "keep": nomi tolti mentre la scheda è aperta, che restano da ritoccare anche se non sono più usati altrove.
function buddyChips(w, keep = []) {
  const mine = w || [];
  const others = [...new Set([...knownBuddies(), ...keep])].filter((name) => !mine.includes(name));
  return mine.map((name) => `<button type="button" class="chip on" data-buddy="${esc(name)}" aria-label="Togli ${esc(name)}">${esc(name)} ✕</button>`).join("")
    + others.map((name) => `<button type="button" class="chip" data-buddy="${esc(name)}" aria-label="Aggiungi ${esc(name)}">+ ${esc(name)}</button>`).join("");
}

// Voto da 1 a 5 stelle, dato da lei ai set costruiti (campo "v" nella collezione).
function starText(v) {
  return "★".repeat(v) + `<span class="off">${"★".repeat(5 - v)}</span>`;
}

function starButtons(v) {
  return [1, 2, 3, 4, 5].map((n) =>
    `<button type="button" class="star ${n <= (v || 0) ? "on" : ""}" data-star="${n}" aria-label="${n} ${n === 1 ? "stella" : "stelle"}" aria-pressed="${n === v}">★</button>`).join("");
}

function renderCatalog() {
  setHeader("Catalogo LEGO");
  setTab("catalogo");
  const f = state.filters;
  const themeOpts = state.catalog.rootThemes
    .map((t) => `<option value="${t.id}" ${String(t.id) === f.theme ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  const subThemes = f.theme !== "" ? state.catalog.byTheme(state.catalog.children[f.theme] || []) : [];
  const subOpts = subThemes
    .map((t) => `<option value="${t.id}" ${String(t.id) === f.sub ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  const statusOpts = [...STATUSES.map((s) => [s.id, s.label]), ["fav", "Preferiti ❤️"]]
    .map(([id, label]) => `<option value="${id}" ${id === f.status ? "selected" : ""}>${esc(label)}</option>`).join("");

  $("#view").innerHTML = `
    <div class="search-row">
      <input type="search" id="q" placeholder="Nome inglese o codice" value="${esc(f.q)}" autocomplete="off" enterkeyhint="search">
      <button class="btn" id="toggle-filters">${filterLabel()}</button>
    </div>
    <div class="filters" id="filters" ${state.showFilters ? "" : "hidden"}>
      <div class="wide"><label>Tema</label><select data-f="theme"><option value="">Tutti i temi</option>${themeOpts}</select></div>
      ${subThemes.length ? `<div class="wide"><label>Sottotema</label><select data-f="sub"><option value="">Tutti i sottotemi</option>${subOpts}</select></div>` : ""}
      <div><label>Anno da</label><input type="number" inputmode="numeric" data-f="yearFrom" value="${esc(f.yearFrom)}" placeholder="es. 2010"></div>
      <div><label>Anno a</label><input type="number" inputmode="numeric" data-f="yearTo" value="${esc(f.yearTo)}" placeholder="es. 2024"></div>
      <div><label>Pezzi minimo</label><input type="number" inputmode="numeric" data-f="partsMin" value="${esc(f.partsMin)}"></div>
      <div><label>Pezzi massimo</label><input type="number" inputmode="numeric" data-f="partsMax" value="${esc(f.partsMax)}"></div>
      <div class="wide"><label>Stato nella mia collezione</label><select data-f="status"><option value="">Qualsiasi</option>${statusOpts}</select></div>
      <label class="wide check"><input type="checkbox" id="only-parts" ${f.onlyParts ? "checked" : ""}> Nascondi libri, gadget e articoli senza pezzi</label>
      <div class="wide"><button class="btn full" id="reset-filters">Azzera filtri</button></div>
    </div>
    <div class="result-info">
      <span id="count"></span>
      <select data-f="sort" aria-label="Ordina">
        <option value="year" ${f.sort === "year" ? "selected" : ""}>Più recenti</option>
        <option value="yearAsc" ${f.sort === "yearAsc" ? "selected" : ""}>Più vecchi</option>
        <option value="name" ${f.sort === "name" ? "selected" : ""}>Nome A-Z</option>
        <option value="parts" ${f.sort === "parts" ? "selected" : ""}>Più pezzi</option>
      </select>
    </div>
    <ul class="list blocks" id="results"></ul>
    <div id="more"></div>`;

  const refresh = () => { state.shown = PAGE; renderResults(); };
  $("#q").addEventListener("input", debounce((ev) => { f.q = ev.target.value; refresh(); }, 200));
  $("#q").addEventListener("keydown", (ev) => { if (ev.key === "Enter") ev.target.blur(); });
  document.querySelectorAll("[data-f]").forEach((el) =>
    el.addEventListener(el.tagName === "SELECT" ? "change" : "input", debounce(() => {
      f[el.dataset.f] = el.value;
      if (el.dataset.f === "theme") { f.sub = ""; renderCatalog(); return; } // aggiorna l'elenco dei sottotemi
      $("#toggle-filters").textContent = filterLabel();
      refresh();
    }, 250)));
  $("#only-parts").addEventListener("change", (ev) => { f.onlyParts = ev.target.checked; refresh(); });
  $("#toggle-filters").addEventListener("click", () => {
    state.showFilters = !state.showFilters;
    $("#filters").hidden = !state.showFilters;
  });
  $("#reset-filters").addEventListener("click", () => {
    Object.assign(f, { theme: "", sub: "", yearFrom: "", yearTo: "", partsMin: "", partsMax: "", status: "", onlyParts: true });
    renderCatalog();
  });
  renderResults();
  layoutAll(state.catalogScroll);
  // Foto delle scatole ed etichette Nuovo/In arrivo arrivano da Brickset: appena ci sono si ridisegnano i blocchi.
  if (!state.extra) loadExtra().then(() => {
    if (currentRoute.startsWith("#/catalogo")) renderResults(false, true);
  }).catch(() => {});
}

function filterLabel() {
  const f = state.filters;
  const n = ["theme", "yearFrom", "yearTo", "partsMin", "partsMax", "status"].filter((k) => f[k] !== "").length;
  return `Filtri${n ? ` (${n})` : ""}`;
}

let moreObserver = null;

// I blocchi lontani dallo schermo non vengono disegnati (content-visibility in style.css) e hanno
// un'altezza stimata. Quando un elenco è appena stato ridisegnato e si torna a metà pagina, per un
// attimo si misurano tutti davvero: così il punto in cui si era resta preciso e scorrendo in su non salta.
// y = dove portare la pagina: per restare dov'era va letto PRIMA di cambiare l'elenco
// (dopo, con le altezze stimate, la pagina può essere più corta e il telefono l'avrebbe già spostata).
function layoutAll(y) {
  const view = $("#view");
  if (y > 0) {
    view.classList.add("layout-all");
    clearTimeout(layoutAll.t);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      layoutAll.t = setTimeout(() => view.classList.remove("layout-all"), 50);
    }));
  }
  window.scrollTo(0, y);
}

// Disegna la lista; con append=true aggiunge solo le righe nuove ("Mostra altri").
// quiet=true: ridisegna senza animazione (gli stessi set, con le foto delle scatole arrivate dopo).
function renderResults(append = false, quiet = false) {
  const list = filteredSets();
  const results = $("#results");
  if (!results) return;
  $("#count").textContent = list.length === 1 ? "1 set" : `${fmtNum(list.length)} set`;
  if (moreObserver) { moreObserver.disconnect(); moreObserver = null; }
  if (!list.length) {
    results.innerHTML = `<li class="empty"><b>Nessun set trovato</b>Prova a cambiare la ricerca o i filtri. I nomi dei set sono in inglese (es. "castle", "fire station").</li>`;
    $("#more").innerHTML = "";
    return;
  }
  const already = append ? results.children.length : 0;
  const rows = list.slice(already, state.shown).map(setItem).join("");
  if (append) results.insertAdjacentHTML("beforeend", rows);
  else { const y = window.scrollY; results.innerHTML = rows; layoutAll(y); if (quiet) calmView(); else animateView("relist"); }
  if (list.length > state.shown) {
    $("#more").innerHTML = `<button class="btn full more">Mostra altri</button>`;
    const btn = $("#more button");
    const more = () => { state.shown += PAGE; renderResults(true); };
    btn.addEventListener("click", more);
    moreObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) more();
    }, { rootMargin: "400px" });
    moreObserver.observe(btn);
  } else {
    $("#more").innerHTML = "";
  }
}

// ---------- Temi (categorie) ----------

const NEW_DAYS = 60; // un set è "Nuovo" per 60 giorni dalla data di uscita
const RECENT_YEARS = 3; // i temi con set usciti negli ultimi anni sono quelli "di oggi"
// Temi che non sono categorie da negozio (gadget, libri, omaggi, negozi, scuola…): in fondo, tra gli altri temi.
const NOT_BUILDING = ["Gear", "Books", "Promotional", "LEGO Brand Store", "Other", "Educational and Dacta", "Power Functions",
  "Value Packs", "FIRST LEGO League", "Legoland Parks", "LEGO Exclusive", "Editions", "Bulk Bricks", "Service Packs",
  "Key Chains", "Magnets", "Supplemental"];
// I set normali hanno un codice di sole cifre (es. 60420-1); omaggi e confezioni speciali hanno lettere (EG00160-1, L0002220-1).
const isShopSet = (s) => (s.shop ??= /^\d+-\d+$/.test(s.setNum));

// Data di uscita da Brickset (AAAA-MM-GG); se manca si usa solo l'anno.
function launchOf(s) {
  return state.extra?.sets[s.setNum]?.launch || null;
}

// "new" = uscito da poco, "soon" = non ancora in vendita, null = niente etichetta.
function releaseTag(s) {
  const launch = launchOf(s);
  const today = todayLocal();
  if (launch) {
    if (launch > today) return "soon";
    const days = (new Date(today) - new Date(launch)) / 86400000;
    return days <= NEW_DAYS ? "new" : null;
  }
  // Senza data precisa: in arrivo solo se l'anno è già oltre quello in corso.
  return s.year != null && s.year > new Date().getFullYear() ? "soon" : null;
}

// short: data corta ("1 dic"), per i blocchi stretti degli elenchi.
function releaseBadge(s, short = false) {
  const tag = releaseTag(s);
  if (tag === "new") return '<span class="rel rel-new">Nuovo</span>';
  if (tag === "soon") {
    const launch = launchOf(s);
    const d = launch && short ? new Date(launch).toLocaleDateString("it-IT", { day: "numeric", month: "short" }) : fmtDate(launch);
    return `<span class="rel rel-soon">In arrivo${d ? ` · ${esc(d)}` : ""}</span>`;
  }
  return "";
}

// Chiave per ordinare dal più nuovo: la data se c'è, altrimenti l'anno (va dopo i set datati dello stesso anno).
function releaseKey(s) {
  return launchOf(s) || (s.year != null ? `${s.year}-00-00` : "0000");
}

// A parità di data: prima i set normali, poi quelli con la foto della scatola, poi il codice più alto.
const byRelease = (a, b) => {
  const ka = releaseKey(a), kb = releaseKey(b);
  if (ka !== kb) return ka < kb ? 1 : -1;
  return (isShopSet(b) - isShopSet(a)) || (!!boxThumb(b) - !!boxThumb(a)) || b.codeRank - a.codeRank;
};

// Foto della scatola (Brickset) per gli elenchi, se c'è; altrimenti quella di Rebrickable.
function boxThumb(s) {
  const box = state.extra?.sets[s.setNum]?.box;
  if (!box) return null;
  const full = (p) => (p && !/^https?:/.test(p) ? state.extra.imgBase + p : p);
  return full(box[1]) || full(box[0]);
}

function listImg(s, cls = "thumb") {
  const box = boxThumb(s);
  if (!box) return imgTag(s, "thumb").replace('class="thumb"', `class="${cls}"`);
  return `<img class="${cls}" src="${esc(box)}" data-full="${esc(s.img)}" alt="" loading="lazy" decoding="async" onerror="imgFallback(this)">`;
}

const isRealSet = (s) => s.parts != null || s.figs;

// Copertina di ogni categoria: un set simbolo scelto a mano (quello che tutti riconoscono) e un colore tutto nostro.
// Niente loghi dei marchi: la foto è quella del set dal catalogo Rebrickable, come nel resto dell'app.
// Se il set non c'è nel catalogo, o il tema è nuovo, si usa il set più recente come prima.
const THEME_COVERS = {
  "Animal Crossing": ["77050-1", "#7cc26a"], "Architecture": ["21061-1", "#8f9aa6"], "Bluey": ["11203-1", "#5aa9e6"],
  "Botanicals": ["10328-1", "#e46a8a"], "BrickLink Designer Program": ["910029-1", "#8a7a6a"], "Brickheadz": ["40677-1", "#f2a33a"],
  "Chinese Traditional Festivals": ["80111-1", "#d9433b"], "City": ["60380-1", "#3c7fd6"], "Classic": ["11033-1", "#f2c230"], "Collectible Minifigures": ["71048-13", "#f08a24"],
  "Creator": ["31120-1", "#e8742f"], "DOTS": ["41806-1", "#c77ddb"], "Despicable Me 4": ["75583-1", "#f5cf2a"],
  "Disney": ["43222-1", "#6a7fdb"], "Dreamzzz": ["71486-1", "#7d5bd6"], "Duplo": ["10994-1", "#ee5a3c"],
  "Fortnite": ["77073-1", "#4fa3f7"], "Friends": ["41748-1", "#e95fa8"], "Gabby's Dollhouse": ["10788-1", "#ef7fb8"],
  "Harry Potter": ["76419-1", "#a0473f"], "Horizon Adventures": ["77037-1", "#e0863a"], "Icons": ["10294-1", "#3d5a80"],
  "Jurassic World": ["76956-1", "#6c9a3c"], "LEGO Art": ["31203-1", "#4aa3a0"], "LEGO Ideas and CUUSOO": ["21318-1", "#f0b429"],
  "Minecraft": ["21265-1", "#5d9b3a"], "Modular Buildings": ["10326-1", "#b07a4f"], "Monkie Kid": ["80039-1", "#e4a12c"],
  "Nike": ["43008-1", "#555b66"], "Ninjago": ["71799-1", "#2f9e6e"], "One Piece": ["75639-1", "#e0483a"],
  "Pokémon": ["72152-1", "#f6c445"], "Seasonal": ["10293-1", "#c9433f"], "Sonic The Hedgehog": ["76994-1", "#2f6fdb"],
  "Speed Champions": ["76924-1", "#d23b3b"], "Star Wars": ["75192-1", "#4a4f5a"], "Super Heroes DC": ["76240-1", "#2c4a8a"],
  "Super Heroes Marvel": ["76269-1", "#cf3737"], "Super Mario": ["71411-1", "#e5392f"], "Technic": ["42143-1", "#5f6b78"],
  "The Legend of Zelda": ["77092-1", "#3e9a6a"], "Wednesday": ["76780-1", "#6b5b7b"], "Wicked": ["75684-1", "#3faa5c"],
};
// Colore per i temi senza colore scelto: sempre lo stesso per lo stesso nome.
function themeColor(name) {
  if (THEME_COVERS[name]) return THEME_COVERS[name][1];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 52%)`;
}

// Temi principali con numero di set e set più recente (calcolati una volta sola).
let themeIndexCache = null;
function themeIndex() {
  const sig = state.extra ? "extra" : "base";
  if (themeIndexCache?.sig === sig) return themeIndexCache;
  const { themes, rootThemes, sets } = state.catalog;
  const now = new Date().getFullYear();
  const today = todayLocal();
  const info = new Map(rootThemes.map((t) => [t.id, { theme: t, count: 0, newest: null, recent: 0, from: null, to: null }]));
  for (const s of sets) {
    const t = info.get(s.root);
    if (!t || !isRealSet(s)) continue;
    t.count++;
    if (s.year != null) {
      t.from = t.from == null ? s.year : Math.min(t.from, s.year);
      t.to = t.to == null ? s.year : Math.max(t.to, s.year);
      if (s.year >= now - RECENT_YEARS + 1 && isShopSet(s)) t.recent++; // un omaggio non rende "attuale" un tema
    }
    // Foto della casella: il set già uscito più recente che ha un'immagine.
    const out = launchOf(s) ? launchOf(s) <= today : s.year != null && s.year <= now;
    // Si preferisce sempre un set normale a un omaggio, anche se l'omaggio è più recente.
    const better = !t.newest || (isShopSet(s) !== isShopSet(t.newest) ? isShopSet(s) : byRelease(s, t.newest) < 0);
    if (out && s.img && better) t.newest = s;
  }
  const all = [...info.values()].filter((t) => t.count);
  for (const t of all) {
    const cover = state.catalog.bySetNum.get(THEME_COVERS[t.theme.name]?.[0]);
    t.cover = cover?.img && cover.root === t.theme.id ? cover : null;
  }
  const main = (t) => t.recent && !NOT_BUILDING.includes(t.theme.name);
  themeIndexCache = { sig, active: all.filter(main), old: all.filter((t) => !main(t)), themes };
  return themeIndexCache;
}

function renderThemes() {
  setHeader("Temi LEGO");
  setTab("temi");
  const { active, old } = themeIndex();
  const tile = (t) => {
    // Il set simbolo si mostra con la foto del set montato: il suo sfondo bianco prende il colore del tema.
    const s = t.cover || t.newest;
    const img = t.cover ? `<span class="tile-cover">${imgTag(s, "tile-img")}</span>` : s ? listImg(s, "tile-img") : '<div class="tile-img"></div>';
    return `<a class="tile" href="#/tema/${t.theme.id}" style="--tc:${themeColor(t.theme.name)}">${img}<span class="tile-name">${esc(t.theme.name)}</span><span class="tile-count">${fmtNum(t.count)} set</span></a>`;
  };
  // I temi vecchi sono mattoncini più piccoli, senza foto: sono tanti e così la pagina resta corta.
  const mini = (t) => `<a class="tile mini" href="#/tema/${t.theme.id}" style="--tc:${themeColor(t.theme.name)}"><span class="tile-name">${esc(t.theme.name)}</span><span class="tile-count">${fmtNum(t.count)} set</span><span class="tile-count">${yearsText(t)}</span></a>`;
  $("#view").innerHTML = `
    <p class="muted small">Tocca un tema per vedere tutti i suoi set, dal più nuovo. I nomi dei temi sono quelli originali in inglese.</p>
    <div class="tiles">${active.map(tile).join("")}</div>
    <details class="old-themes" ${state.oldThemesOpen ? "open" : ""}>
      <summary>Altri temi: vecchi, libri e gadget (${old.length})</summary>
      <div class="tiles mini-tiles">${old.map(mini).join("")}</div>
    </details>`;
  $(".old-themes").addEventListener("toggle", (ev) => { state.oldThemesOpen = ev.target.open; });
  window.scrollTo(0, state.themesScroll || 0);
  // Le date di uscita e le foto delle scatole arrivano da Brickset: appena ci sono si ridisegna.
  if (!state.extra) loadExtra().then(() => {
    if (currentRoute !== "#/temi") return;
    state.themesScroll = window.scrollY;
    calmView();
    renderThemes();
  }).catch(() => {});
}

const yearsText = (t) => (t.from === t.to ? String(t.from ?? "") : `${t.from}–${t.to}`);

function renderTheme(id) {
  const t = state.catalog.themes[id];
  if (!t) { location.hash = "#/temi"; return; }
  setHeader(t.name, "#/temi");
  setTab("temi");
  const v = state.themeView?.id === id ? state.themeView : (state.themeView = { id, sub: "", when: "", shown: PAGE, scroll: 0 });
  const subs = state.catalog.byTheme(state.catalog.children[id] || []);
  const subOpts = subs.map((x) => `<option value="${x.id}" ${String(x.id) === v.sub ? "selected" : ""}>${esc(x.name)}</option>`).join("");
  $("#view").innerHTML = `
    <div id="theme-head"></div>
    ${subs.length ? `<select id="theme-sub" aria-label="Sottotema"><option value="">Tutti i sottotemi</option>${subOpts}</select>` : ""}
    <div class="chips when-chips" id="theme-when"></div>
    <div class="result-info"><span id="count"></span><span>dal più nuovo</span></div>
    <ul class="list blocks" id="theme-list"></ul>
    <div id="more"></div>`;
  $("#theme-sub")?.addEventListener("change", (ev) => { v.sub = ev.target.value; v.when = ""; v.shown = PAGE; v.scroll = 0; drawThemeList(id); });
  $("#theme-when").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-when]");
    if (!b || b.dataset.when === v.when) return;
    v.when = b.dataset.when; v.shown = PAGE; v.scroll = 0;
    drawThemeList(id);
  });
  drawThemeList(id);
  layoutAll(v.scroll);
  if (!state.extra) loadExtra().then(() => { if (currentRoute === `#/tema/${id}`) drawThemeList(id, false, true); }).catch(() => {});
}

// Set di un tema dal più nuovo: ordinati una volta sola (non a ogni "Mostra altri" mentre si scorre).
let themeSetsCache = null;
function themeSets(themeId) {
  const sig = `${themeId}|${state.extra ? "extra" : "base"}|${todayLocal()}`;
  if (themeSetsCache?.sig !== sig) {
    themeSetsCache = { sig, list: state.catalog.sets.filter((s) => s.chain.includes(themeId) && isRealSet(s)).sort(byRelease) };
  }
  return themeSetsCache.list;
}

// "quiet": ridisegno perché sono arrivati i dati, non perché lei ha cambiato qualcosa: niente animazione.
function drawThemeList(id, append = false, quiet = false) {
  const v = state.themeView;
  const ul = $("#theme-list");
  if (!ul) return;
  const filter = v.sub !== "" ? Number(v.sub) : Number(id);
  const all = themeSets(filter);
  if (!append) drawThemeHead(id);
  // Pulsanti "Nuovi" e "In arrivo": solo se in questo tema ce ne sono.
  const nNew = all.filter((s) => releaseTag(s) === "new").length;
  const nSoon = all.filter((s) => releaseTag(s) === "soon").length;
  if (v.when === "new" && !nNew || v.when === "soon" && !nSoon) v.when = "";
  const chip = (when, label, n) => `<button type="button" class="chip ${v.when === when ? "on" : ""}" data-when="${when}">${label}${n ? ` (${fmtNum(n)})` : ""}</button>`;
  $("#theme-when").innerHTML = nNew || nSoon
    ? chip("", "Tutti") + (nNew ? chip("new", "Nuovi", nNew) : "") + (nSoon ? chip("soon", "In arrivo", nSoon) : "")
    : "";
  const list = v.when ? all.filter((s) => releaseTag(s) === v.when) : all;
  $("#count").textContent = list.length === 1 ? "1 set" : `${fmtNum(list.length)} set`;
  if (moreObserver) { moreObserver.disconnect(); moreObserver = null; }
  if (!list.length) {
    ul.innerHTML = `<li class="empty"><b>Nessun set</b>In questo tema non ci sono set con pezzi.</li>`;
    $("#more").innerHTML = "";
    return;
  }
  const already = append ? ul.children.length : 0;
  const rows = list.slice(already, v.shown).map(setItem).join("");
  if (append) ul.insertAdjacentHTML("beforeend", rows);
  else { const y = window.scrollY; ul.innerHTML = rows; layoutAll(y); if (quiet) calmView(); else animateView("relist"); }
  if (list.length > v.shown) {
    $("#more").innerHTML = `<button class="btn full more">Mostra altri</button>`;
    const btn = $("#more button");
    const more = () => { v.shown += PAGE; drawThemeList(id, true); };
    btn.addEventListener("click", more);
    moreObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) more();
    }, { rootMargin: "400px" });
    moreObserver.observe(btn);
  } else {
    $("#more").innerHTML = "";
  }
}

// In cima alla pagina di un tema: la sua copertina (come la casella nella pagina Temi) con anni e numero di set.
function drawThemeHead(id) {
  const head = $("#theme-head");
  const t = themeIndex().active.concat(themeIndex().old).find((x) => x.theme.id === Number(id));
  if (!head || !t) { if (head) head.innerHTML = ""; return; }
  const s = t.cover || t.newest;
  const img = t.cover ? `<span class="tile-cover">${imgTag(s, "tile-img")}</span>` : s ? listImg(s, "tile-img") : '<div class="tile-img"></div>';
  head.innerHTML = `<div class="tile theme-head" style="--tc:${themeColor(t.theme.name)}">${img}
    <span class="theme-head-info"><span class="tile-name">${t.count === 1 ? "1 set" : `${fmtNum(t.count)} set`}</span>
    ${t.from != null ? `<span class="tile-count">${t.from === t.to ? `uscito nel ${t.from}` : `dal ${t.from} al ${t.to}`}</span>` : ""}</span></div>`;
}

// ---------- Galleria foto della scheda ----------
// Prima la scatola (Brickset), poi la foto di Rebrickable, poi le altre foto Brickset
// e per ultima una pagina con i personaggi (minifigure di Rebrickable).

function firstSlides(s) {
  const box = state.extra?.sets[s.setNum]?.box;
  const slides = [];
  if (box) slides.push({ img: imgUrl(box[0], state.extra.imgBase) });
  if (s.img) slides.push({ img: s.img, thumb: thumbUrl(s.img) });
  return slides;
}

function galleryHtml(slides) {
  if (!slides.length) return `<div class="noimg">Immagine non disponibile</div>`;
  const one = (sl, i) => sl.figs
    ? `<div class="slide figs-slide"><div class="figs-grid">${sl.figs.map(([src, name]) => `<img src="${esc(src)}" alt="${esc(name)}" loading="lazy" onerror="figError(this)">`).join("")}</div><div class="slide-label">I personaggi del set</div></div>`
    : `<button type="button" class="slide" data-full="${esc(sl.img)}" aria-label="Foto ${i + 1}, apri grande"><img src="${esc(sl.img)}" alt="" ${i ? 'loading="lazy"' : ""} onerror="slideError(this)"></button>`;
  return `<div class="gallery"><div class="slides">${slides.map(one).join("")}</div>
    ${slides.length > 1 ? `<div class="dots">${dotsHtml(slides.length, 0)}</div>` : ""}</div>`;
}

// Fino a 12 foto i puntini; con di più (es. 45) i puntini non ci stanno e si scrive "1 / 45".
function dotsHtml(n, i) {
  if (n < 2) return "";
  if (n > 12) return `<span class="count">${i + 1} / ${n}</span>`;
  return Array.from({ length: n }, (_, j) => `<span class="${i === j ? "on" : ""}"></span>`).join("");
}

// Una foto che non si carica (es. senza internet) sparisce; se non resta niente, il riquadro grigio.
window.slideError = (img) => {
  const gallery = img.closest(".gallery");
  img.closest(".slide").remove();
  if (gallery) setupGallery(gallery);
};

// Se nessuna foto dei personaggi si carica, la loro pagina sparisce.
window.figError = (img) => {
  const grid = img.parentElement;
  img.remove();
  if (grid.children.length) return;
  const gallery = grid.closest(".gallery");
  grid.closest(".slide").remove();
  if (gallery) setupGallery(gallery);
};

function setupGallery(gallery) {
  const slides = gallery.querySelector(".slides");
  const n = slides.children.length;
  if (!n) { gallery.outerHTML = `<div class="noimg">Immagine non disponibile</div>`; return; }
  const dots = gallery.querySelector(".dots");
  if (dots) {
    dots.innerHTML = dotsHtml(n, 0);
    slides.onscroll = () => {
      const i = Math.round(slides.scrollLeft / slides.clientWidth);
      if (n > 12) dots.firstChild.textContent = `${i + 1} / ${n}`;
      else [...dots.children].forEach((d, j) => d.classList.toggle("on", i === j));
    };
  }
  slides.onclick = (ev) => {
    const b = ev.target.closest(".slide[data-full]");
    if (b) openImage(b.dataset.full);
  };
}

function openImage(src) {
  const el = document.createElement("div");
  el.className = "viewer";
  el.innerHTML = `<img src="${esc(src)}" alt=""><div class="viewer-bar"><button class="btn primary" data-a="close">Chiudi</button></div>`;
  document.body.appendChild(el);
  el.addEventListener("click", () => el.remove());
  window.addEventListener("hashchange", () => el.remove(), { once: true });
}

async function fillGallery(s) {
  const el = $("#gallery");
  if (el.querySelector(".gallery")) setupGallery(el.querySelector(".gallery"));
  const sig = (list) => list.map((x) => x.img || "figs").join(" ");
  el.dataset.sig = sig(firstSlides(s));
  const [details, figs] = await Promise.all([
    loadDetails(s.setNum).catch(() => null),
    s.figs ? loadMinifigs().catch(() => null) : null,
  ]);
  const slides = [];
  const extra = details?.imgs || [];
  // L'elenco arriva già ordinato con la scatola per prima (Box1, boxprod, Box5...).
  const isBox = (u) => {
    const name = u.split("/").pop();
    return !/lifestyle/i.test(name) && /(?:^|[_ -]|\d)(?:box(\d*|prod\d*|pod|front|back)|packaging)(?=[_. (-]|v\d|$)/i.test(name);
  };
  if (extra[0] && isBox(extra[0].img)) slides.push(extra.shift());
  if (s.img) slides.push({ img: s.img });
  slides.push(...extra);
  const list = figs?.sets[s.setNum] || [];
  const faces = list.map(([fig, qty]) => {
    const [name, , img] = figs.figs[fig] || [];
    return [imgUrl(img, figs.imgBase), qty > 1 ? `${qty} × ${name}` : name];
  }).filter(([src]) => src);
  if (faces.length) slides.push({ figs: faces });
  // Si ridisegna solo se le foto sono cambiate rispetto a quelle già mostrate.
  if (!document.body.contains(el) || sig(slides) === el.dataset.sig) return;
  el.innerHTML = galleryHtml(slides);
  setupGallery(el.querySelector(".gallery"));
}

// Ricerca del set sul sito LEGO italiano: lì ci sono descrizione in italiano, prezzo e
// disponibilità di oggi. Solo un link: i termini del sito vietano di copiarne i dati.
function legoUrl(s) {
  return `https://www.lego.com/it-it/search?q=${encodeURIComponent(s.base)}`;
}

function shopUrl(shop, s) {
  const q = encodeURIComponent(`LEGO ${s.base} ${s.name}`);
  return shop === "amazon" ? `https://www.amazon.it/s?k=${q}` : `https://www.ebay.it/sch/i.html?_nkw=${q}`;
}

// Prezzo di listino ufficiale LEGO in euro (quello tedesco, l'unico in euro che dà Brickset).
function legoPrice(x) {
  const eur = x.price?.DE;
  const retired = x.exit && x.exit <= todayLocal();
  const upcoming = x.launch && x.launch > todayLocal();
  let html = eur
    ? `<div class="big-price">${esc(eur.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }))} €</div>
       <div class="small muted">Prezzo di listino del sito LEGO (in Germania, dati Brickset).</div>`
    : `<div>Prezzo LEGO in euro ${NA}</div>`;
  if (retired) html += `<div class="note">Non è più in vendita sul sito LEGO: per il prezzo di oggi guarda su Amazon o eBay.</div>`;
  else if (upcoming) html += `<div class="note">Non ancora in vendita: esce il ${esc(fmtDate(x.launch))}.</div>`;
  return html;
}

// Piccola festa quando un set è finito: cadono mattoncini colorati (niente se il telefono chiede meno animazioni).
function celebrate() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#da291c", "#006cb7", "#00852b", "#ffd500", "#e8680c", "#7b3fc4"];
  const box = document.createElement("div");
  box.className = "confetti";
  box.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 36; i++) {
    const b = document.createElement("i");
    b.style.left = Math.random() * 100 + "%";
    b.style.background = colors[i % colors.length];
    b.style.animationDelay = Math.random() * 0.5 + "s";
    b.style.setProperty("--r", (Math.random() * 720 - 360).toFixed(0) + "deg");
    box.append(b);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 2400);
}

// ---------- Animazioni ----------
// Tutte leggere (solo movimento e trasparenza) e spente se il telefono chiede meno animazioni.

const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Fa ripartire un'animazione sullo stesso elemento (es. "✓ Salvato" a ogni salvataggio).
function replay(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// Pagina nuova: i pezzi arrivano uno dopo l'altro come mattoncini che si incastrano ("enter").
// Elenco ridisegnato (ricerca, filtri): solo le righe ("relist"). Poi la classe si toglie,
// così i ridisegni successivi (foto contate, dati arrivati) non fanno ripartire tutto.
function animateView(cls = "enter") {
  const view = $("#view");
  view.classList.add(cls);
  clearTimeout(animateView[cls]);
  animateView[cls] = setTimeout(() => view.classList.remove(cls), 900);
}

// Ferma le animazioni della pagina: per i ridisegni arrivati da soli (dati scaricati dopo).
function calmView() {
  const view = $("#view");
  for (const cls of ["enter", "relist"]) { clearTimeout(animateView[cls]); view.classList.remove(cls); }
}

// Scoppio di mattoncini, cuori o stelle attorno a un pulsante.
function burst(el, kind = "bricks") {
  if (!el || calm()) return;
  const r = el.getBoundingClientRect();
  const colors = ["#da291c", "#006cb7", "#00852b", "#ffd500", "#e8680c", "#7b3fc4"];
  const box = document.createElement("div");
  box.className = "burst " + kind;
  box.setAttribute("aria-hidden", "true");
  box.style.left = r.left + r.width / 2 + "px";
  box.style.top = r.top + r.height / 2 + "px";
  const n = 10;
  for (let i = 0; i < n; i++) {
    const b = document.createElement("i");
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
    const d = 34 + Math.random() * 26;
    b.style.setProperty("--x", (Math.cos(a) * d).toFixed(0) + "px");
    b.style.setProperty("--y", (Math.sin(a) * d).toFixed(0) + "px");
    b.style.setProperty("--r", (Math.random() * 300 - 150).toFixed(0) + "deg");
    if (kind === "bricks") b.style.background = colors[i % colors.length];
    else b.textContent = kind === "hearts" ? "❤" : "★";
    box.append(b);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 800);
}

// I numeri delle statistiche salgono da 0 fino al valore vero. "t0" è l'inizio: se la pagina
// si ridisegna mentre i numeri salgono (es. quando arrivano le foto), si continua da dove si era.
const COUNT_MS = 700;
function countUp(root, t0) {
  if (calm()) return;
  root.querySelectorAll(".stat b").forEach((b) => {
    const text = b.textContent;
    if (b.children.length || !/^\d{1,3}(\.\d{3})*( €)?$/.test(text)) return;
    const end = Number(text.replace(/\D/g, ""));
    if (end < 2) return;
    const suffix = text.endsWith(" €") ? " €" : "";
    const step = () => {
      if (!b.isConnected) return; // pagina ridisegnata o cambiata
      const k = Math.min(Math.max((performance.now() - t0) / COUNT_MS, 0), 1);
      b.textContent = fmtNum(Math.round(end * (1 - (1 - k) ** 3))) + suffix;
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  });
}

function renderDetail(setNum) {
  const found = state.catalog.bySetNum.get(setNum);
  // Un set salvato in collezione ma tolto dal catalogo resta gestibile (stato, note…).
  const s = found || { setNum, name: "Set non più presente nel catalogo", base: setNum.replace(/-\d+$/, ""), chain: [], img: "" };
  setHeader(s.setNum, "#/catalogo");
  setTab("");
  window.scrollTo(0, 0);
  const e = entry(setNum);
  const { theme, sub } = found ? themePath(s.themeId) : {};
  const base = s.base;
  const variants = found ? state.catalog.sets.filter((x) => x !== s && x.base === base) : [];
  // Set correlati: stesso tema specifico, anni vicini (dato ricavato dal catalogo).
  const related = found && s.themeId != null && s.year != null
    ? state.catalog.sets
        .filter((x) => x !== s && x.base !== base && x.themeId === s.themeId && x.year != null && Math.abs(x.year - s.year) <= 1 && x.parts)
        .sort((a, b) => Math.abs(a.year - s.year) - Math.abs(b.year - s.year) || (b.parts || 0) - (a.parts || 0))
        .slice(0, 8)
    : [];
  const val = (v) => (v == null || v === "" ? NA : esc(v));
  // Data, voto, tempo e persone si vedono solo negli stati in cui hanno senso; se si cambia stato per sbaglio
  // restano salvati e ricompaiono tornando indietro. Si cancellano solo con "Non posseduto", dopo conferma.
  const showDate = e.s === "built" || e.s === "apart";
  const showRating = e.s === "built" || e.s === "apart";
  const showBuild = ["building", "built", "apart"].includes(e.s);

  $("#view").innerHTML = `
    <div id="gallery">${galleryHtml(firstSlides(s))}</div>
    <h2 class="set-title">${esc(s.name)}</h2>
    <div class="muted">${esc(s.setNum)}${s.year ? " · " + s.year : ""}</div>
    <div class="badges" id="x-badges"></div>

    ${found ? `<div class="card price-card">
      <h2>Prezzo</h2>
      <div id="x-lego-price"><div>Prezzo LEGO in euro ${NA}</div></div>
      <div class="shop-row">
        <a class="btn shop-lego" href="${esc(legoUrl(s))}" target="_blank" rel="noopener">🧱 Vedi sul sito LEGO</a>
        <a class="btn" href="${esc(shopUrl("amazon", s))}" target="_blank" rel="noopener">🔎 Cerca su Amazon</a>
        <a class="btn" href="${esc(shopUrl("ebay", s))}" target="_blank" rel="noopener">🔎 Cerca su eBay</a>
      </div>
      <div class="small muted">I pulsanti aprono la ricerca del set sul sito: sul sito LEGO trovi prezzo e disponibilità di oggi, su Amazon ed eBay anche l'usato.</div>
    </div>` : ""}

    <div class="card" style="margin-top:14px">
      <h2>La mia collezione</h2>
      ${isIosBrowser() ? SAFARI_WARNING : ""}
      <div class="status-grid">
        ${STATUSES.map((st) => `<button class="status-btn ${e.s === st.id ? "on st-" + st.id : ""}" data-status="${st.id}">${esc(st.label)}</button>`).join("")}
      </div>
      <div class="field" id="date-field" ${showDate ? "" : "hidden"}>
        <label for="built-date">Data in cui l'ho costruito</label>
        <div class="search-row"><input type="date" id="built-date" value="${esc(e.d || "")}"><button class="btn" id="today" type="button">Oggi</button></div>
      </div>
      <div class="field" id="rating-field" ${showRating ? "" : "hidden"}>
        <label id="rating-label">Il mio voto</label>
        <div class="stars" role="group" aria-labelledby="rating-label">${starButtons(e.v)}</div>
        <div class="small muted" id="rating-hint">${e.v ? "Tocca di nuovo la stessa stella per togliere il voto." : "Quanto ti è piaciuto costruirlo?"}</div>
      </div>
      <div id="build-fields" ${showBuild ? "" : "hidden"}>
        <div class="field">
          <label id="time-label">Tempo totale di costruzione</label>
          <div class="time-row" role="group" aria-labelledby="time-label">
            <input type="number" id="time-h" inputmode="numeric" min="0" max="999" placeholder="0" value="${e.t ? Math.floor(e.t / 60) : ""}" aria-label="Ore"><span>ore</span>
            <input type="number" id="time-m" inputmode="numeric" min="0" max="59" placeholder="0" value="${e.t ? e.t % 60 : ""}" aria-label="Minuti"><span>min</span>
          </div>
          <div class="time-add">
            <span class="small muted">Aggiungi:</span>
            <button type="button" class="chip" data-add-min="15">+15 min</button>
            <button type="button" class="chip" data-add-min="30">+30 min</button>
            <button type="button" class="chip" data-add-min="60">+1 ora</button>
          </div>
        </div>
        <div class="field">
          <label for="buddy-new">Con chi l'ho costruito</label>
          <div class="chips buddies" id="buddies">${buddyChips(e.w)}</div>
          <div class="search-row"><input type="text" id="buddy-new" maxlength="30" autocomplete="off" placeholder="Scrivi un nome…" enterkeyhint="done"><button class="btn" id="buddy-add" type="button">Aggiungi</button></div>
          <div class="small muted hint">Tocca un nome per aggiungerlo o toglierlo.</div>
        </div>
      </div>
      <div class="field">
        <label for="notes">Note</label>
        <textarea id="notes" placeholder="es. manca un pezzo, regalo di Natale…">${esc(e.n || "")}</textarea>
      </div>
      <button class="btn fav-btn" id="fav">${e.f ? "❤️ Nei preferiti" : "🤍 Aggiungi ai preferiti"}</button>
      <div class="saved" id="saved"></div>
    </div>

    ${found ? `<div class="card" id="desc-card">
      <h2>Descrizione</h2>
      <div id="x-desc" class="muted small"><span class="mini-load">Caricamento…</span></div>
    </div>` : ""}

    <div class="card">
      <h2>Le mie foto</h2>
      <div class="photos" id="photos"></div>
      <input type="file" id="photo-input" accept="image/*" hidden>
      <button class="btn full" id="photo-add" type="button">📷 Aggiungi una foto</button>
      <div class="small muted" id="photo-msg"></div>
    </div>

    ${!found ? `<div class="warn">Questo set è nella tua collezione ma non è più nel catalogo di Rebrickable. Puoi comunque cambiare stato e note, o metterlo su "Non posseduto" (e togliere note e preferito) per toglierlo.</div>` : ""}
    <div class="card">
      <h2>Dati del set</h2>
      <dl class="data">
        <dt>Codice</dt><dd>${esc(s.setNum)}</dd>
        <dt>Tema</dt><dd>${val(theme)}</dd>
        <dt>Sottotema</dt><dd>${sub ? esc(sub) : NA}</dd>
        <dt>Anno</dt><dd>${val(s.year)}</dd>
        <dt>Pezzi</dt><dd>${val(fmtNum(s.parts))}${s.partsFrom ? ` <span class="muted small">(dato ${esc(s.partsFrom)})</span>` : ""}</dd>
        <dt>Minifigure</dt><dd>${val(s.figs)}</dd>
        <dt>Codice a barre</dt><dd id="x-barcode">${NA}</dd>
        <dt>Fascia d'età</dt><dd id="x-age">${NA}</dd>
        <dt>Prezzo di listino</dt><dd id="x-price">${NA}</dd>
        <dt id="x-bt-label" hidden>Costruisci insieme</dt><dd id="x-bt" hidden></dd>
        <dt>In vendita dal</dt><dd id="x-launch">${NA}</dd>
        <dt>Fuori produzione</dt><dd id="x-exit">${NA}</dd>
        <dt>Valutazione</dt><dd id="x-rating">${NA}</dd>
        <dt>Istruzioni</dt><dd><a href="https://www.lego.com/it-it/service/building-instructions/${encodeURIComponent(base)}" target="_blank" rel="noopener">Cerca sul sito LEGO</a></dd>
        <dt>Scheda</dt><dd><a href="https://rebrickable.com/sets/${encodeURIComponent(s.setNum)}/" target="_blank" rel="noopener">Apri su Rebrickable</a><br><a href="https://brickset.com/sets/${encodeURIComponent(s.setNum)}" target="_blank" rel="noopener">Apri su Brickset</a></dd>
      </dl>
    </div>

    ${s.figs ? `<div class="card"><h2>Minifigure</h2><div id="figs" class="muted small"><span class="mini-load">Caricamento…</span></div></div>` : ""}

    ${variants.length ? `<div class="card"><h2>Varianti</h2><ul class="list blocks">${variants.map(setItem).join("")}</ul></div>` : ""}

    ${related.length ? `<div class="card"><h2>Set correlati</h2><p class="muted small">Stesso tema, usciti negli stessi anni.</p><ul class="list blocks">${related.map(setItem).join("")}</ul></div>` : ""}`;

  const flash = () => {
    const el = $("#saved");
    if (!el) return;
    el.textContent = "✓ Salvato";
    replay(el, "pop-in");
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { el.textContent = ""; }, 1500);
  };
  document.querySelectorAll(".status-btn").forEach((btn) => btn.addEventListener("click", () => {
    const st = btn.dataset.status;
    const changes = { s: st };
    const was = entry(setNum).s;
    if (st === was) return;
    if (st === "none") {
      const old = entry(setNum);
      if (old.d || old.v || old.t || old.w) {
        if (!confirm("Togliere questo set dalla collezione? Si cancellano anche data, voto, tempo e persone (le note, il preferito e le foto restano).")) return;
        changes.d = changes.v = changes.t = changes.w = undefined;
      }
    }
    const ok = updateEntry(setNum, changes);
    if (ok && st === "built" && was !== "built") celebrate();
    document.querySelectorAll(".status-btn").forEach((b) => { b.className = "status-btn" + (b.dataset.status === st ? " on st-" + st : ""); });
    if (ok && st !== was) {
      replay(btn, "snap");
      if (st === "wish") burst(btn, "stars");
      else if (st !== "none" && st !== "built") burst(btn);
    }
    const cur = entry(setNum);
    $("#date-field").hidden = !(st === "built" || st === "apart");
    $("#built-date").value = cur.d || "";
    showStars(cur.v);
    $("#rating-field").hidden = !(st === "built" || st === "apart");
    $("#build-fields").hidden = !["building", "built", "apart"].includes(st);
    showTime(cur.t);
    $("#buddies").innerHTML = buddyChips(cur.w, [...seenBuddies]);
    if (ok) flash();
  }));
  const showStars = (v) => {
    $(".stars").classList.remove("rated");
    $(".stars").innerHTML = starButtons(v);
    $("#rating-hint").textContent = v ? "Tocca di nuovo la stessa stella per togliere il voto." : "Quanto ti è piaciuto costruirlo?";
  };
  $(".stars").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-star]");
    if (!btn) return;
    const n = Number(btn.dataset.star);
    const v = entry(setNum).v === n ? undefined : n;
    if (!updateEntry(setNum, { v })) return;
    showStars(v);
    if (v) $(".stars").classList.add("rated");
    if (v === 5) burst($('.star[data-star="5"]'), "stars");
    flash();
  });
  // Tempo di costruzione: salvato in minuti (campo "t").
  const showTime = (t) => {
    $("#time-h").value = t ? Math.floor(t / 60) : "";
    $("#time-m").value = t ? t % 60 : "";
  };
  const saveTime = (t) => {
    t = Math.min(Math.max(Math.round(t) || 0, 0), 999 * 60 + 59) || undefined;
    if (entry(setNum).t === t) return;
    if (updateEntry(setNum, { t })) flash();
  };
  const typedTime = () => (Number($("#time-h").value) || 0) * 60 + (Number($("#time-m").value) || 0);
  ["#time-h", "#time-m"].forEach((sel) => {
    $(sel).addEventListener("input", () => { pendingSave = () => { pendingSave = null; saveTime(typedTime()); }; saveTimeLater(); });
    $(sel).addEventListener("change", () => { pendingSave = null; saveTime(typedTime()); showTime(entry(setNum).t); });
  });
  const saveTimeLater = debounce(() => { if (pendingSave) pendingSave(); }, 600);
  document.querySelectorAll("[data-add-min]").forEach((btn) => btn.addEventListener("click", () => {
    pendingSave = null;
    saveTime(typedTime() + Number(btn.dataset.addMin));
    showTime(entry(setNum).t);
    replay($(".time-row"), "bump");
  }));
  // Con chi: nomi già usati in altri set si scelgono con un tocco, oppure se ne scrive uno nuovo.
  const seenBuddies = new Set(e.w || []);
  const setBuddies = (w) => {
    const before = entry(setNum).w || [];
    if (!updateEntry(setNum, { w: w.length ? w : undefined })) return;
    w.forEach((name) => seenBuddies.add(name));
    $("#buddies").innerHTML = buddyChips(w, [...seenBuddies]);
    $("#buddies").querySelectorAll(".chip.on").forEach((c) => { if (!before.includes(c.dataset.buddy)) c.classList.add("snap"); });
    flash();
  };
  $("#buddies").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-buddy]");
    if (!btn) return;
    const name = btn.dataset.buddy, w = entry(setNum).w || [];
    setBuddies(w.includes(name) ? w.filter((x) => x !== name) : [...w, name]);
  });
  const addBuddy = () => {
    const input = $("#buddy-new");
    const typed = input.value.trim().replace(/\s+/g, " ");
    input.value = "";
    if (!typed) return;
    // Se il nome esiste già (anche con maiuscole diverse) si usa quello, così non ci sono doppioni.
    const name = knownBuddies().find((x) => norm(x) === norm(typed)) || typed;
    const w = entry(setNum).w || [];
    if (!w.includes(name)) setBuddies([...w, name]);
  };
  $("#buddy-add").addEventListener("click", addBuddy);
  $("#buddy-new").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); addBuddy(); ev.target.blur(); } });
  $("#built-date").addEventListener("change", (ev) => { if (updateEntry(setNum, { d: ev.target.value || undefined })) flash(); });
  $("#today").addEventListener("click", () => {
    $("#built-date").value = todayLocal();
    if (updateEntry(setNum, { d: todayLocal() })) flash();
  });
  // Le note si salvano mentre si scrive, quando si esce dal campo e se l'app viene chiusa.
  const notes = $("#notes");
  const saveNotes = () => {
    pendingSave = null;
    const n = notes.value.trim() ? notes.value : undefined;
    if ((entry(setNum).n || undefined) === n) return;
    if (updateEntry(setNum, { n })) flash();
  };
  const saveNotesLater = debounce(() => { if (pendingSave) saveNotes(); }, 400);
  notes.addEventListener("input", () => { pendingSave = saveNotes; saveNotesLater(); });
  notes.addEventListener("blur", () => { if (pendingSave) saveNotes(); });
  $("#fav").addEventListener("click", (ev) => {
    const f = !entry(setNum).f;
    if (!updateEntry(setNum, { f: f || undefined })) return;
    ev.target.textContent = f ? "❤️ Nei preferiti" : "🤍 Aggiungi ai preferiti";
    replay(ev.target, "beat");
    if (f) burst(ev.target, "hearts");
    flash();
  });

  setupPhotos(setNum);

  loadExtra().then(({ sets }) => {
    const x = sets[s.setNum];
    if (!x || !$("#x-barcode")) return;
    const codes = [x.ean && `EAN ${esc(x.ean)}`, x.upc && `UPC ${esc(x.upc)}`].filter(Boolean);
    if (codes.length) $("#x-barcode").innerHTML = codes.join("<br>");
    $("#x-age").innerHTML = fmtAge(x.age);
    $("#x-price").innerHTML = fmtPrice(x.price);
    $("#x-lego-price").innerHTML = legoPrice(x);
    // "Costruisci insieme" solo se Brickset lo dice: se il tag manca non sappiamo se il set lo permette.
    if (x.bt) {
      $("#x-bt-label").hidden = $("#x-bt").hidden = false;
      $("#x-bt").innerHTML = "Sì: si può costruire in più persone con l'app LEGO Builder";
      $("#x-badges").insertAdjacentHTML("beforeend", `<span class="tag tag-bt">👥 Costruisci insieme</span>`);
    }
    if (found) $("#x-badges").insertAdjacentHTML("afterbegin", releaseBadge(s));
    if (x.launch) $("#x-launch").innerHTML = esc(fmtDate(x.launch)) + (x.launch > todayLocal() ? ' <span class="muted small">(non ancora uscito)</span>' : "");
    if (x.exit) $("#x-exit").innerHTML = x.exit > todayLocal() ? `previsto dal ${esc(fmtDate(x.exit))}` : `dal ${esc(fmtDate(x.exit))}`;
    else if (x.launch && x.launch <= todayLocal()) $("#x-exit").innerHTML = "no, non ancora";
    if (x.rating) $("#x-rating").innerHTML = `${esc(x.rating.toLocaleString("it-IT"))} su 5 <span class="muted small">(Brickset)</span>`;
  }).catch(() => {});

  if (found) fillGallery(s);
  if (found) {
    loadDetails(s.setNum).then((d) => {
      const el = $("#x-desc");
      if (!el) return;
      if (!d || !d.desc) { el.innerHTML = `${NA}. <a href="${esc(legoUrl(s))}" target="_blank" rel="noopener">Cercala sul sito LEGO</a>`; return; }
      el.classList.remove("muted", "small");
      el.innerHTML = `<div class="desc">${d.desc.split("\n").map((p) => `<p>${esc(p)}</p>`).join("")}</div>
        <div class="small muted">Testo in inglese, da Brickset. <a href="${esc(legoUrl(s))}" target="_blank" rel="noopener">Leggilo in italiano sul sito LEGO</a></div>`;
      const box = el.querySelector(".desc");
      if (box.scrollHeight > box.clientHeight + 4) {
        el.insertAdjacentHTML("beforeend", `<button class="btn full" type="button" id="desc-more">Leggi tutto</button>`);
        $("#desc-more").addEventListener("click", (ev) => { box.classList.add("open"); ev.target.remove(); });
      } else box.classList.add("open");
    }).catch(() => { const el = $("#x-desc"); if (el) el.innerHTML = "Descrizione non disponibile senza internet."; });
  }

  if (s.figs) {
    loadMinifigs().then((m) => {
      const list = m.sets[s.setNum] || [];
      const el = $("#figs");
      if (!el) return;
      if (!list.length) { el.innerHTML = NA; return; }
      el.classList.remove("muted", "small");
      el.innerHTML = `<ul class="figs">${list.map(([fig, qty]) => {
        const [name, , img] = m.figs[fig] || [`Nome non disponibile (${fig})`];
        const src = imgUrl(img, m.imgBase);
        return `<li>${src ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ""}<span>${qty > 1 ? qty + " × " : ""}${esc(name)}</span></li>`;
      }).join("")}</ul>`;
    }).catch(() => { const el = $("#figs"); if (el) el.innerHTML = "Elenco non disponibile senza internet."; });
  }
}

async function setupPhotos(setNum) {
  const box = $("#photos");
  const msg = $("#photo-msg");
  const urls = [];
  const draw = async () => {
    let list;
    try { list = await photosOf(setNum); } catch { msg.textContent = "Le foto non sono disponibili su questo telefono."; $("#photo-add").hidden = true; return; }
    if (!document.body.contains(box)) return;
    urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    state.photoCounts[setNum] = list.length;
    if (!list.length) delete state.photoCounts[setNum];
    box.innerHTML = list.map((p) => {
      const u = URL.createObjectURL(p.blob);
      urls.push(u);
      return `<button type="button" class="photo" data-id="${esc(p.id)}" data-src="${u}" aria-label="Apri foto"><img src="${u}" alt=""></button>`;
    }).join("");
    msg.textContent = list.length ? "Tocca una foto per vederla grande o cancellarla." : "Fotografa il set quando l'hai costruito.";
    box.querySelectorAll(".photo").forEach((b) => b.addEventListener("click", () => openPhoto(b.dataset.src, b.dataset.id, draw)));
  };
  $("#photo-add").addEventListener("click", () => $("#photo-input").click());
  $("#photo-input").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    msg.textContent = "Salvo la foto…";
    try {
      const blob = await shrinkPhoto(file);
      await putPhoto({ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, set: setNum, date: new Date().toISOString(), blob });
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      await draw();
      msg.textContent = "✓ Foto salvata. Ricordati ogni tanto di fare il Backup.";
    } catch (err) {
      msg.textContent = "";
      alert(err && err.notImage
        ? "Questo file non è una foto che riesco ad aprire. Scegli un'altra foto."
        : "Non sono riuscito a salvare la foto (memoria del telefono piena?). Riprova con un'altra foto.");
    }
  });
  await draw();
}

function openPhoto(src, id, after) {
  const el = document.createElement("div");
  el.className = "viewer";
  el.innerHTML = `<img src="${src}" alt="">
    <div class="viewer-bar"><button class="btn" data-a="del">🗑 Cancella</button><button class="btn primary" data-a="close">Chiudi</button></div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.addEventListener("click", async (ev) => {
    const a = ev.target.dataset.a;
    if (a === "del") {
      if (!confirm("Cancellare questa foto?")) return;
      try { await deletePhoto(id); } catch { alert("Non sono riuscito a cancellare la foto."); return; }
      close();
      after();
    } else if (a === "close" || ev.target === el) close();
  });
  window.addEventListener("hashchange", close, { once: true });
}

// ---------- Scansione codice a barre ----------

let scanControls = null;
let scanGen = 0; // ogni avvio/stop cambia numero: una fotocamera avviata "in ritardo" viene subito spenta
// Su iPhone ogni nuova richiesta della fotocamera fa ricomparire il permesso:
// teniamo la stessa fotocamera (in pausa) finché l'app resta aperta e la riusiamo.
let camStream = null;

function camAlive() {
  return camStream && camStream.getVideoTracks().some((t) => t.readyState === "live");
}

async function getCam() {
  if (!camAlive()) {
    releaseCam();
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  }
  camStream.getVideoTracks().forEach((t) => { t.enabled = true; });
  return camStream;
}

function releaseCam() {
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
}

function stopScan() {
  scanGen++;
  if (scanControls) { try { scanControls.stop(); } catch {} scanControls = null; }
  const v = $("#cam");
  if (v) v.srcObject = null;
  // In pausa: la spia si spegne ma il permesso resta valido.
  if (camStream) camStream.getVideoTracks().forEach((t) => { t.enabled = false; });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const el = document.createElement("script");
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error("script non caricato"));
    document.head.appendChild(el);
  });
}

function renderScan() {
  setHeader("Scansiona");
  setTab("scansiona");
  $("#view").innerHTML = `
    <div class="scan-box" id="scan-box">
      <video id="cam" playsinline muted autoplay></video>
      <div class="scan-frame"></div>
    </div>
    <p class="center" id="scan-msg">Inquadra il codice a barre sulla scatola.</p>
    <div class="center"><button class="btn primary" id="scan-start" hidden>Avvia la fotocamera</button></div>
    <div id="scan-result"></div>
    <div class="card">
      <h2>Oppure scrivi il codice</h2>
      <p class="small muted">Il numero del set (es. 10294) o le cifre sotto il codice a barre.</p>
      <form class="search-row" id="manual">
        <input type="search" id="manual-code" inputmode="numeric" autocomplete="off" placeholder="es. 10294">
        <button class="btn" type="submit">Cerca</button>
      </form>
    </div>`;
  $("#manual").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const code = $("#manual-code").value.trim();
    if (code) { $("#manual-code").blur(); handleCode(code, true); }
  });
  $("#scan-start").addEventListener("click", startScan);
  startScan();
}

async function startScan() {
  const msg = $("#scan-msg");
  $("#scan-start").hidden = true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    msg.textContent = "Questo telefono non permette di usare la fotocamera qui. Scrivi il codice qui sotto.";
    $("#scan-box").hidden = true;
    return;
  }
  try {
    stopScan();
    const gen = scanGen;
    await loadScript("vendor/zxing-browser.min.js");
    if (gen !== scanGen) return;
    const stream = await getCam();
    if (gen !== scanGen || location.hash !== "#/scansiona") { stopScan(); return; }
    const video = $("#cam");
    video.srcObject = stream;
    const reader = new ZXingBrowser.BrowserMultiFormatReader();
    const controls = await reader.decodeFromVideoElement(video,
      (result, err, ctrl) => {
        if (!result) return;
        ctrl.stop();
        scanControls = null;
        stopScan();
        if (navigator.vibrate) navigator.vibrate(80);
        handleCode(result.getText(), false);
      });
    if (gen !== scanGen || location.hash !== "#/scansiona") { controls.stop(); stopScan(); return; }
    scanControls = controls;
  } catch (err) {
    if (!$("#scan-box")) return;
    $("#scan-box").hidden = true;
    msg.textContent = err && err.name === "NotAllowedError"
      ? "Per scansionare serve il permesso di usare la fotocamera: su iPhone vai in Impostazioni → Safari → Fotocamera → Consenti, poi tocca il pulsante qui sotto. Oppure scrivi il codice qui sotto."
      : "Non riesco ad avviare la fotocamera. Puoi scrivere il codice qui sotto.";
    $("#scan-start").hidden = false;
  }
}

async function handleCode(text, typed) {
  const out = $("#scan-result");
  if (!out) return;
  const digits = String(text).replace(/\D/g, "");
  let matches = [];
  let extraMissing = false;
  let offline = false;
  // Codice a barre (8 cifre o più) cercato nei dati Brickset.
  if (digits.length >= 8) {
    try {
      const { sets } = await loadExtra();
      extraMissing = Object.keys(sets).length === 0;
      matches = (barcodeIndex().get(normBarcode(digits)) || []).map((n) => state.catalog.bySetNum.get(n)).filter(Boolean);
    } catch { offline = true; }
  }
  // Numero del set (scritto a mano o letto da un QR code che lo contiene).
  if (!matches.length) {
    const num = typed
      ? (digits.length < 8 ? String(text).trim().toLowerCase() : null)
      : (String(text).match(/\b(\d{3,7}(-\d+)?)\b/) || [])[1];
    if (num) {
      matches = state.catalog.sets.filter((s) => s.setNum === num || s.base === num).sort((a, b) => a.codeRank - b.codeRank);
    }
  }
  if (matches.length === 1) { location.hash = "#/set/" + encodeURIComponent(matches[0].setNum); return; }
  // Fotocamera in pausa mentre si guarda il risultato.
  stopScan();
  if ($("#scan-box")) $("#scan-box").hidden = true;
  if ($("#scan-msg")) $("#scan-msg").textContent = "";
  const isText = typed && !/\d/.test(text);
  const again = `<div class="center"><button class="btn primary" id="scan-again">Scansiona un altro</button></div>`;
  if (matches.length) {
    out.innerHTML = `<div class="card"><h2>Ho trovato ${matches.length} set</h2><ul class="list blocks">${matches.map(setItem).join("")}</ul></div>${again}`;
  } else {
    out.innerHTML = `<div class="card"><h2>Codice non trovato</h2><p class="small">Ho letto <b>${esc(text)}</b> ma non corrisponde a nessun set.
      ${isText ? `Qui si cercano solo numeri. Per cercare per nome usa la scheda <a href="#/catalogo">Catalogo</a>.`
        : offline ? "Per riconoscere i codici a barre la prima volta serve internet. Riprova quando sei connessa, oppure scrivi il numero del set."
        : extraMissing ? "I codici a barre non sono ancora stati scaricati da Brickset: per ora cerca con il numero del set."
        : "Prova a scrivere il numero del set che trovi sulla scatola (di solito in alto, es. 10294)."}</p></div>${again}`;
  }
  $("#scan-again").addEventListener("click", () => {
    out.innerHTML = "";
    $("#scan-box").hidden = false;
    $("#scan-msg").textContent = "Inquadra il codice a barre sulla scatola.";
    startScan();
  });
}

function collectionList(filter) {
  // Anche i set con foto ma senza stato (es. "Non posseduto") compaiono in "Con foto".
  const nums = new Set([...Object.keys(state.collection), ...Object.keys(state.photoCounts)]);
  return [...nums].map((num) => [num, entry(num)])
    .filter(([num, e]) => filter(e, num))
    .map(([num, e]) => ({ set: state.catalog.bySetNum.get(num) || { setNum: num, name: "(set non più nel catalogo)", img: "" }, e }))
    .sort((a, b) => (b.e.u || "").localeCompare(a.e.u || ""))
    .map((x) => x.set);
}

function renderCollection() {
  setHeader("La mia collezione");
  setTab("collezione");
  const chips = [
    ["all", "Tutti", (e) => OWNED.includes(e.s)],
    ["owned", "Da costruire", (e) => e.s === "owned"],
    ["building", "In costruzione", (e) => e.s === "building"],
    ["built", "Costruiti", (e) => e.s === "built"],
    ["apart", "Smontati", (e) => e.s === "apart"],
    ["fav", "Preferiti ❤️", (e) => e.f],
    ["notes", "Con note", (e) => e.n],
    ["rated", "Con voto ★", (e) => e.v],
    ["photo", "Con foto 📷", (e, num) => state.photoCounts[num]],
  ];
  const t0 = performance.now();
  let grown = null; // categorie cresciute dall'ultima volta (calcolate la prima volta che si vedono)
  const draw = (quiet = false) => {
    keepBars(quiet);
    const byCat = state.collectionMode === "cat";
    const [, , filter] = chips.find((c) => c[0] === state.collectionChip) || chips[0];
    const list = byCat ? [] : collectionList(filter);
    const cats = byCat ? myCategories() : null;
    const y = window.scrollY;
    $("#view").innerHTML = `${isIosBrowser() ? SAFARI_WARNING : ""}
      ${backupReminder()}
      ${statsCard()}
      ${viewSwitch()}
      ${byCat ? categoriesHtml(cats) : `<div class="chips scroll">${chips.map(([id, label, fn]) =>
        `<button class="chip ${id === state.collectionChip ? "on" : ""}" data-chip="${id}">${esc(label)} (${collectionList(fn).length})</button>`).join("")}</div>
      ${list.length ? `<ul class="list blocks">${list.map(setItem).join("")}</ul>` :
        `<div class="empty"><b>Ancora niente qui</b>Cerca un set nel <a href="#/catalogo">Catalogo</a>, aprilo e scegli il suo stato (per esempio "Costruito").</div>`}`}`;
    layoutAll(y);
    $(".view-switch").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-mode]");
      if (!b || b.dataset.mode === state.collectionMode) return;
      state.collectionMode = b.dataset.mode;
      try { localStorage.setItem(MODE_KEY, state.collectionMode); } catch {}
      draw();
      $("[data-mode].on")?.classList.add("snap");
      animateView("relist");
    });
    if (byCat) {
      // Le categorie cresciute si calcolano una volta sola: i ridisegni (foto contate, dati arrivati) tengono il "+1" senza rifare la festa.
      const party = grown == null;
      grown ??= grownCategories(cats);
      markGrown(grown, party);
    }
    $("#backup-later")?.addEventListener("click", () => {
      try { localStorage.setItem(BACKUP_SNOOZE_KEY, new Date().toISOString()); } catch {}
      $("#backup-reminder").remove();
    });
    $(".more-stats").addEventListener("toggle", (ev) => { state.statsOpen = ev.target.open; });
    // La fila dei filtri scorre di lato: resta visibile quello scelto.
    const chipRow = $(".chips.scroll");
    if (chipRow) chipRow.scrollLeft = state.chipScroll || 0;
    chipRow?.addEventListener("scroll", () => { state.chipScroll = chipRow.scrollLeft; }, { passive: true });
    document.querySelectorAll("[data-chip]").forEach((b) => b.addEventListener("click", () => {
      if (state.collectionChip === b.dataset.chip) return;
      state.collectionChip = b.dataset.chip;
      draw();
      $("[data-chip].on")?.classList.add("snap");
      animateView("relist");
    }));
    if (performance.now() - t0 < COUNT_MS) countUp($("#view"), t0);
    fillValue();
  };
  draw();
  // Le foto si contano in un secondo momento: quando arrivano si aggiornano numeri e 📷.
  loadPhotoCounts().then(() => { if (location.hash === "#/collezione") draw(true); });
  // Foto delle scatole ed etichette Nuovo/In arrivo arrivano da Brickset: appena ci sono si ridisegna (senza animazione).
  if (!state.extra) loadExtra().then(() => { if (location.hash === "#/collezione") { calmView(); draw(true); } }).catch(() => {});
}

// ---------- Collezione per categoria ----------
// Una categoria è un tema principale (es. Super Heroes DC); dentro si vedono i sottotemi (es. Batman).
// Compaiono solo le categorie dove lei ha già costruito almeno un set: mai categorie vuote.
// "Costruiti" = Costruito o Smontato (un set smontato l'ha comunque costruito).
const BUILT = ["built", "apart"];
const CAT_OTHER = 0; // set non più nel catalogo o senza tema

function viewSwitch() {
  const b = (mode, label) => `<button type="button" class="chip ${state.collectionMode === mode ? "on" : ""}" data-mode="${mode}" aria-pressed="${state.collectionMode === mode}">${label}</button>`;
  return `<div class="chips view-switch" role="group" aria-label="Come vedere la collezione">${b("list", "Tutti i set")}${b("cat", "Per categoria")}</div>`;
}

// Numero di set "veri" (con pezzi o personaggi) per tema, compresi i sottotemi: calcolato una volta sola.
let themeCountCache = null;
function catalogCount(themeId) {
  if (!themeCountCache) {
    themeCountCache = new Map();
    for (const s of state.catalog.sets) {
      if (!isRealSet(s)) continue;
      for (const id of s.chain) themeCountCache.set(id, (themeCountCache.get(id) || 0) + 1);
    }
  }
  return themeCountCache.get(themeId) || 0;
}

// Le categorie della collezione: per ognuna i suoi set posseduti, quanti costruiti e i sottotemi.
function myCategories() {
  const cats = new Map();
  for (const [num, e] of Object.entries(state.collection)) {
    if (!OWNED.includes(e.s)) continue;
    const s = state.catalog.bySetNum.get(num);
    if (!s || s.root == null) continue;
    const c = cats.get(s.root) || { id: s.root, theme: state.catalog.themes[s.root], sets: [], built: 0, subs: new Map(), last: null };
    cats.set(s.root, c);
    c.sets.push(s);
    const sub = s.chain[1];
    if (sub != null) {
      const x = c.subs.get(sub) || { id: sub, name: state.catalog.themes[sub].name, owned: 0, built: 0 };
      c.subs.set(sub, x);
      x.owned++;
      if (BUILT.includes(e.s)) x.built++;
    }
    if (BUILT.includes(e.s)) {
      c.built++;
      // Copertina: l'ultimo set che ha costruito in questa categoria (con la data di costruzione se l'ha scritta;
      // altrimenti l'ultima modifica, così un voto o una nota su un set vecchio non cambia la copertina se c'è la data).
      if (!c.last || builtKey(e) > builtKey(entry(c.last.setNum))) c.last = s;
    }
  }
  return [...cats.values()].filter((c) => c.built)
    .sort((a, b) => b.built - a.built || state.catalog.collator.compare(a.theme.name, b.theme.name));
}

// Ridisegno arrivato da solo (foto contate, dati Brickset arrivati dopo): le barre che si riempiono e il "+1"
// continuano da dove erano invece di ripartire da zero (le animazioni partono "indietro" del tempo già passato).
let barsStart = 0;
function keepBars(quiet) {
  if (!quiet) barsStart = performance.now();
  $("#view").style.setProperty("--bars-skip", quiet ? `${-Math.round(performance.now() - barsStart)}ms` : "0ms");
}

const builtKey = (e) => (e.d || (e.u || "").slice(0, 10)) + (e.u || "");

// Barra di avanzamento a mattoncini: quanti dei suoi set di questa categoria ha già costruito.
function progressBar(built, owned) {
  const pct = Math.round((built / owned) * 100);
  const done = built === owned;
  return `<span class="cat-bar${done ? " done" : ""}" role="img" aria-label="Costruiti ${built} su ${owned}"><span style="width:${pct}%"></span></span>`;
}

function catText(c) {
  const owned = c.sets.length;
  return c.built === owned
    ? `<span class="cat-done">${owned === 1 ? "Costruito!" : `Tutti costruiti! ${fmtNum(owned)} su ${fmtNum(owned)}`}</span>`
    : `Costruiti <b>${fmtNum(c.built)}</b> su ${fmtNum(owned)} che hai`;
}

function catTile(c, head = false) {
  const color = themeColor(c.theme.name);
  const img = c.last ? listImg(c.last, "tile-img") : '<div class="tile-img"></div>';
  // Sottotemi in cui ha costruito qualcosa (es. Batman): così la categoria si riconosce subito.
  const subs = [...c.subs.values()].filter((x) => x.built).sort((a, b) => b.built - a.built || a.name.localeCompare(b.name, "it"));
  const subsText = subs.length ? `<span class="cat-subs">${subs.slice(0, 3).map((x) => esc(x.name)).join(" · ")}${subs.length > 3 ? ` · +${subs.length - 3}` : ""}</span>` : "";
  const total = catalogCount(c.id);
  const inner = `<span class="tile-cover cat-pic">${img}<span class="cat-count" aria-hidden="true">${fmtNum(c.built)}</span></span>
    <span class="theme-head-info">
      <span class="tile-name">${esc(c.theme.name)}</span>${subsText}
      ${progressBar(c.built, c.sets.length)}
      <span class="cat-text">${catText(c)}</span>
      ${total ? `<span class="tile-count">Nel catalogo LEGO: ${total === 1 ? "1 set" : `${fmtNum(total)} set`}</span>` : ""}
    </span>`;
  return head
    ? `<div class="tile theme-head cat-tile" style="--tc:${color}">${inner}</div>`
    : `<a class="tile theme-head cat-tile" data-cat="${c.id}" href="#/collezione/${c.id}" style="--tc:${color}">${inner}</a>`;
}

function categoriesHtml(cats) {
  // Set posseduti che non stanno in nessuna categoria mostrata (categorie dove non ha ancora costruito niente).
  const shown = cats.reduce((a, c) => a + c.sets.length, 0);
  const owned = Object.entries(state.collection).filter(([n, e]) => OWNED.includes(e.s) && state.catalog.bySetNum.get(n)?.root != null).length;
  const rest = owned - shown;
  const restText = rest > 0 ? ` ${rest === 1 ? "Un altro set da costruire è" : `Altri ${fmtNum(rest)} set da costruire sono`} in "Tutti i set".` : "";
  if (!cats.length) {
    return `<div class="empty"><b>Ancora nessuna categoria</b>Quando segni un set come "Costruito", qui compare la sua categoria (per esempio Super Heroes DC con Batman) con i set che hai costruito.${restText}</div>`;
  }
  const apart = cats.some((c) => c.sets.some((s) => entry(s.setNum).s === "apart"));
  return `<p class="muted small">${cats.length === 1 ? "1 categoria" : `${cats.length} categorie`} con set costruiti da te. Tocca una categoria per vedere i suoi set.${apart ? " Tra i costruiti contano anche i set smontati." : ""}${restText}</p>
    <div class="cat-list">${cats.map((c) => catTile(c)).join("")}</div>`;
}

// Piccola festa quando una categoria è cresciuta dall'ultima volta: "+1" e stelline;
// se ora ha costruito tutti i suoi set di quella categoria, cadono anche i mattoncini.
function grownCategories(cats) {
  let seen = null;
  try { seen = JSON.parse(localStorage.getItem(CAT_SEEN_KEY) || "null"); } catch {}
  const next = {};
  for (const c of cats) next[c.id] = [c.built, c.sets.length];
  try { localStorage.setItem(CAT_SEEN_KEY, JSON.stringify(next)); } catch {}
  const grown = [];
  if (!seen || typeof seen !== "object") return grown; // la prima volta niente festa: tutte le categorie sarebbero "nuove"
  for (const c of cats) {
    const [was = 0, wasOwned = 0] = Array.isArray(seen[c.id]) ? seen[c.id] : [];
    if (c.built <= was) continue;
    grown.push({ id: c.id, plus: c.built - was, complete: c.built === c.sets.length && !(wasOwned && was === wasOwned) });
  }
  return grown;
}

function markGrown(grown, party) {
  let delay = 450;
  for (const g of grown) {
    const tile = document.querySelector(`.cat-tile[data-cat="${g.id}"]`);
    if (!tile) continue;
    tile.classList.add("grew");
    tile.querySelector(".cat-text").insertAdjacentHTML("beforeend", ` <span class="cat-plus">+${g.plus}</span>`);
    if (party) { setTimeout(() => burst(tile.querySelector(".cat-bar"), "stars"), delay); delay += 250; }
  }
  if (party && grown.some((g) => g.complete)) setTimeout(celebrate, 300);
}

// Una categoria della collezione: la sua casella in cima e i suoi set, prima quelli costruiti.
function renderCollectionCategory(id) {
  const c = myCategories().find((x) => x.id === id);
  const t = state.catalog.themes[id];
  if (!t) { location.hash = "#/collezione"; return; }
  setHeader(t.name, "#/collezione");
  setTab("collezione");
  if (!c) {
    $("#view").innerHTML = `<div class="empty"><b>Nessun set costruito qui</b>In questa categoria non hai ancora costruito nessun set. <a href="#/collezione">Torna alla collezione</a></div>`;
    return;
  }
  const v = state.catView?.id === id ? state.catView : (state.catView = { id, sub: "" });
  const subs = [...c.subs.values()].sort((a, b) => a.name.localeCompare(b.name, "it"));
  if (v.sub && !c.subs.has(Number(v.sub))) v.sub = "";
  const draw = (quiet = false) => {
    keepBars(quiet);
    const rank = (s) => (BUILT.includes(entry(s.setNum).s) ? 0 : entry(s.setNum).s === "building" ? 1 : 2);
    const list = c.sets.filter((s) => !v.sub || s.chain[1] === Number(v.sub))
      .sort((a, b) => rank(a) - rank(b) || (entry(b.setNum).u || "").localeCompare(entry(a.setNum).u || ""));
    const chip = (sub, label) => `<button type="button" class="chip ${v.sub === sub ? "on" : ""}" data-sub="${sub}">${label}</button>`;
    const y = window.scrollY;
    $("#view").innerHTML = `${catTile(c, true)}
      ${subs.length > 1 || (subs.length === 1 && subs[0].owned < c.sets.length)
        ? `<div class="chips scroll">${chip("", `Tutti (${c.sets.length})`)}${subs.map((x) => chip(String(x.id), `${esc(x.name)} ${x.built}/${x.owned}`)).join("")}</div>` : ""}
      <ul class="list blocks">${list.map(setItem).join("")}</ul>
      <a class="btn full" href="#/tema/${id}">Vedi tutti i set ${esc(t.name)} del catalogo</a>`;
    layoutAll(y);
    $("#view .chips.scroll")?.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-sub]");
      if (!b || b.dataset.sub === v.sub) return;
      v.sub = b.dataset.sub;
      draw();
      $("[data-sub].on")?.classList.add("snap");
      animateView("relist");
    });
  };
  draw();
  if (!state.extra) loadExtra().then(() => { if (currentRoute === `#/collezione/${id}`) { calmView(); draw(true); } }).catch(() => {});
  loadPhotoCounts().then(() => { if (currentRoute === `#/collezione/${id}`) { calmView(); draw(true); } });
}

// Promemoria del backup: solo se ci sono set salvati, modifiche più recenti dell'ultimo backup
// e l'ultimo backup manca o ha più di 30 giorni. "Più tardi" lo nasconde per una settimana.
function backupReminder() {
  const entries = Object.values(state.collection);
  if (!entries.length) return "";
  let last = null, snooze = null;
  try { last = localStorage.getItem(BACKUP_KEY); snooze = localStorage.getItem(BACKUP_SNOOZE_KEY); } catch {}
  const now = Date.now();
  if (snooze && now - new Date(snooze) < 7 * 86400000) return "";
  if (last && now - new Date(last) < BACKUP_DAYS * 86400000) return "";
  const changed = entries.some((e) => !last || (e.u || "") > last);
  if (!changed) return "";
  const when = last ? `L'ultimo backup è del ${esc(fmtDate(last))} e da allora hai segnato altri set.` : "Non hai ancora fatto nessun backup della collezione.";
  return `<div class="warn backup-reminder" id="backup-reminder">${when} I set che segni sono salvati solo su questo telefono: salvane una copia.
    <div class="shop-row"><a class="btn primary" href="#/backup">Vai al Backup</a><button type="button" class="btn" id="backup-later">Più tardi</button></div></div>`;
}

function statsCard() {
  const entries = Object.entries(state.collection);
  const owned = entries.filter(([, e]) => OWNED.includes(e.s));
  const built = entries.filter(([, e]) => e.s === "built");
  const wish = entries.filter(([, e]) => e.s === "wish");
  let builtParts = 0, missingParts = 0;
  for (const [num] of built) {
    const parts = state.catalog.bySetNum.get(num)?.parts;
    if (parts) builtParts += parts; else missingParts++;
  }
  const photos = Object.values(state.photoCounts).reduce((a, b) => a + b, 0);
  const rated = entries.filter(([, e]) => e.v);
  const avg = rated.length ? rated.reduce((a, [, e]) => a + e.v, 0) / rated.length : 0;
  const best = rated.filter(([, e]) => e.v === 5).length;
  const timed = entries.filter(([, e]) => e.t);
  const totalTime = timed.reduce((a, [, e]) => a + e.t, 0);
  const buddies = knownBuddies().slice(0, 3).map((name) => {
    const n = entries.filter(([, e]) => e.w?.includes(name)).length;
    return `${esc(name)} (${n === 1 ? "1 set" : n + " set"})`;
  });
  const tile = (n, label, id = "", cls = "") => `<div class="stat"${id ? ` id="${id}"` : ""}><b${cls ? ` class="${cls}"` : ""}>${n}</b><span>${label}</span></div>`;
  return `<div class="card">
    <h2>Le mie statistiche</h2>
    <div class="stats">
      ${tile(fmtNum(owned.length), "set posseduti")}
      ${tile(fmtNum(built.length), "set costruiti")}
      ${tile(fmtNum(builtParts), "pezzi costruiti")}
    </div>
    <details class="more-stats" ${state.statsOpen ? "open" : ""}>
    <summary>Altre statistiche</summary>
    <div class="stats">
      ${tile(fmtNum(wish.length), "set desiderati")}
      ${tile(fmtNum(photos), "foto")}
      ${tile('<span class="na">…</span>', "valore indicativo", "stat-value")}
      ${tile(rated.length ? `${avg.toLocaleString("it-IT", { maximumFractionDigits: 1 })} ★` : '<span class="na">–</span>', "voto medio")}
      ${tile(fmtNum(best), "set da 5 stelle")}
      ${tile(totalTime ? fmtDuration(totalTime) : '<span class="na">–</span>', "tempo di costruzione", "", totalTime >= 60 && totalTime % 60 ? "long" : "")}
    </div>
    ${timed.length ? `<p class="small muted">Tempo calcolato su ${timed.length === 1 ? "1 set" : timed.length + " set"} con il tempo segnato${timed.length > 1 ? `: in media ${fmtDuration(Math.round(totalTime / timed.length))} per set` : ""}.</p>` : ""}
    ${buddies.length ? `<p class="small muted">Costruito più spesso con: ${buddies.join(", ")}.</p>` : ""}
    ${rated.length ? `<p class="small muted">Voto medio calcolato su ${rated.length === 1 ? "1 set votato" : rated.length + " set votati"}.</p>` : ""}
    ${missingParts ? `<p class="small muted">Pezzi non disponibili per ${missingParts} ${missingParts === 1 ? "set costruito" : "set costruiti"}: non sono contati.</p>` : ""}
    <p class="small muted" id="value-note"></p>
    </details>
  </div>`;
}

// Valore indicativo: somma dei prezzi di listino originali (in euro, prezzo LEGO in Germania, da Brickset).
// Non è il valore di mercato di oggi, e i set senza prezzo non vengono contati.
async function fillValue() {
  const owned = Object.entries(state.collection).filter(([, e]) => OWNED.includes(e.s)).map(([n]) => n);
  const show = (html, note) => {
    if ($("#stat-value")) $("#stat-value").querySelector("b").innerHTML = html;
    if ($("#value-note")) $("#value-note").textContent = note;
  };
  if (!owned.length) { show("0 €", ""); return; }
  let sets;
  try { ({ sets } = await loadExtra()); } catch { show(NA, "Il valore si calcola la prima volta con internet."); return; }
  let total = 0, priced = 0;
  for (const n of owned) {
    const eur = sets[n]?.price?.DE;
    if (eur) { total += eur; priced++; }
  }
  if (!priced) { show(NA, "Per ora non c'è il prezzo di listino di nessuno dei tuoi set."); return; }
  show(`${fmtNum(Math.round(total))} €`,
    `Valore indicativo = somma dei prezzi di listino originali in euro (prezzo LEGO in Germania, da Brickset). ` +
    (priced < owned.length ? `Calcolato su ${priced} set su ${owned.length}: per gli altri il prezzo non è disponibile.` : `Calcolato su tutti i ${priced} set posseduti.`));
}

function renderWishlist(quiet = false) {
  setHeader("Lista desideri");
  setTab("desideri");
  const list = collectionList((e) => e.s === "wish");
  const prices = state.extra ? list.map((s) => state.extra.sets[s.setNum]?.price?.DE).filter(Boolean) : [];
  const total = fmtNum(Math.round(prices.reduce((a, b) => a + b, 0)));
  const sum = !prices.length ? "" : prices.length === list.length ? ` · in tutto circa ${total} € di listino`
    : ` · circa ${total} € di listino (prezzo noto per ${prices.length} su ${list.length})`;
  if (quiet) calmView();
  const y = window.scrollY;
  $("#view").innerHTML = list.length
    ? `<p class="muted small">${list.length === 1 ? "1 set desiderato" : list.length + " set desiderati"}${sum}</p><ul class="list blocks">${list.map(wishItem).join("")}</ul>`
    : `<div class="empty"><b>La lista desideri è vuota</b>Apri un set dal <a href="#/catalogo">Catalogo</a> e tocca "Desiderato".</div>`;
  layoutAll(y);
  // Prezzi, foto delle scatole ed etichette Nuovo arrivano da Brickset: appena ci sono si ridisegna.
  if (!state.extra && list.length) loadExtra().then(() => { if (location.hash === "#/desideri") renderWishlist(true); }).catch(() => {});
}

// Nella lista desideri l'etichetta "Desiderato" sarebbe uguale per tutti: al suo posto il prezzo di listino.
function wishItem(s) {
  const eur = state.extra?.sets[s.setNum]?.price?.DE;
  const price = eur ? `<span class="block-st"><span class="price-tag">${esc(eur.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }))} €</span></span>` : "";
  return setItem(s).replace(/<span class="block-st">.*?<\/span><\/span>/, price);
}

function renderBackup() {
  setHeader("Backup");
  setTab("backup");
  const count = Object.keys(state.collection).length;
  const last = localStorage.getItem(BACKUP_KEY);
  const dark = document.documentElement.dataset.theme === "dark";
  $("#view").innerHTML = `
    <div class="card">
      <h2>Salva una copia della collezione</h2>
      <p class="small">La collezione è salvata su questo telefono. Ogni tanto salva una copia (per esempio in iCloud Drive o mandala a te stessa via email): se cambi telefono o cancelli l'app, potrai recuperare tutto.</p>
      <p class="small muted">Set nella collezione: ${count}. Foto: <span id="backup-photos">…</span>. Ultimo backup: ${last ? fmtDate(last) : "mai"}.</p>
      <p class="small muted">Le tue foto sono dentro il backup: con molte foto il file diventa grande (circa mezzo MB per foto).</p>
      <button class="btn primary full" id="export">Esporta backup</button>
    </div>
    <div class="card">
      <h2>Recupera da un backup</h2>
      <p class="small">Scegli un file di backup salvato prima. La collezione attuale sarà sostituita da quella del file.</p>
      <input type="file" id="import" accept=".json,application/json" hidden>
      <button class="btn full" id="import-btn">Importa backup</button>
      ${localStorage.getItem(PREV_KEY) ? `<button class="btn full" id="undo-import" style="margin-top:8px">Annulla l'ultimo import</button>` : ""}
    </div>
    <div class="card">
      <h2>Aspetto</h2>
      <p class="small">L'app si apre sempre chiara. Se preferisci i colori scuri, scegli Scuro.</p>
      <div class="chips" id="theme-pick">
        <button type="button" class="chip${dark ? "" : " on"}" data-theme-pick="chiaro">☀️ Chiaro</button>
        <button type="button" class="chip${dark ? " on" : ""}" data-theme-pick="scuro">🌙 Scuro</button>
      </div>
    </div>
    <div class="card small muted">
      Catalogo: ${fmtNum(state.catalog.sets.length)} set, aggiornato il ${fmtDate(state.catalog.generated)}.<br>
      Dati del catalogo da <a href="https://rebrickable.com" target="_blank" rel="noopener">Rebrickable</a>; codici a barre, età e prezzi da <a href="https://brickset.com" target="_blank" rel="noopener">Brickset</a>. Si aggiorna da solo.
    </div>`;
  $("#export").addEventListener("click", exportBackup);
  $("#import-btn").addEventListener("click", () => $("#import").click());
  $("#import").addEventListener("change", importBackup);
  if ($("#undo-import")) $("#undo-import").addEventListener("click", undoImport);
  $("#theme-pick").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-theme-pick]");
    if (b) setTheme(b.dataset.themePick);
  });
  prepareBackupPhotos();
  loadPhotoCounts().then((c) => {
    if ($("#backup-photos")) $("#backup-photos").textContent = Object.values(c).reduce((a, b) => a + b, 0);
  });
}

// Tema: chiaro di base, anche se il telefono è in modalità scura. Lo scuro solo se scelto qui.
// La scelta si legge già in index.html, così l'app non lampeggia all'apertura.
function setTheme(name) {
  if (name === "scuro") document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem("lego-tema", name); } catch {}
  document.querySelectorAll("#theme-pick [data-theme-pick]").forEach((b) => b.classList.toggle("on", b.dataset.themePick === name));
}

// Le foto si preparano appena si apre la scheda Backup: così al tocco di "Esporta"
// la condivisione parte subito (su iPhone, se si aspetta troppo, Safari la blocca).
let backupPhotos = null; // { foto: [...] } oppure { error: true }

async function prepareBackupPhotos() {
  const btn = $("#export");
  backupPhotos = null;
  btn.disabled = true;
  btn.textContent = "Preparo il backup…";
  try {
    const foto = [];
    for (const p of await allPhotos()) foto.push({ id: p.id, set: p.set, data: p.date, img: await blobToDataUrl(p.blob) });
    backupPhotos = { foto };
  } catch {
    backupPhotos = { error: true };
  }
  if (!document.body.contains(btn)) return;
  btn.disabled = false;
  btn.textContent = "Esporta backup";
}

async function exportBackup() {
  if (!backupPhotos) return;
  if (backupPhotos.error && !confirm("Non riesco a leggere le foto. Vuoi fare lo stesso il backup, ma senza foto?")) return;
  const foto = backupPhotos.foto || [];
  const data = { app: "i-miei-lego", versione: 2, data: new Date().toISOString(), collezione: state.collection, foto };
  const name = `backup-lego-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(data, null, 1)], name, { type: "application/json" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "Backup collezione LEGO" });
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(file);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    localStorage.setItem(BACKUP_KEY, new Date().toISOString());
    renderBackup();
  } catch (err) {
    if (err.name !== "AbortError") alert("Non sono riuscito a creare il backup: " + err.message);
  }
}

// Tiene solo le voci valide di un backup; null se il file non è un backup.
function cleanCollection(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const [num, e] of Object.entries(raw)) {
    if (!e || typeof e !== "object" || !STATUS_LABEL[e.s]) continue;
    const clean = { s: e.s };
    if (typeof e.d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.d)) clean.d = e.d;
    if (typeof e.n === "string" && e.n.trim()) clean.n = e.n;
    if (e.f === true) clean.f = true;
    if (Number.isInteger(e.v) && e.v >= 1 && e.v <= 5) clean.v = e.v;
    if (Number.isInteger(e.t) && e.t > 0 && e.t < 60000) clean.t = e.t;
    if (Array.isArray(e.w)) {
      const w = [...new Set(e.w.filter((x) => typeof x === "string").map((x) => x.trim().slice(0, 30)).filter(Boolean))];
      if (w.length) clean.w = w;
    }
    if (typeof e.u === "string") clean.u = e.u;
    out[num] = clean;
  }
  return out;
}

function undoImport() {
  let prev;
  try { prev = cleanCollection(JSON.parse(localStorage.getItem(PREV_KEY))); } catch { prev = null; }
  if (!prev || !confirm(`Tornare alla collezione di prima dell'ultimo import (${Object.keys(prev).length} set)?`)) return;
  state.collection = prev;
  state.collectionVersion++;
  if (saveCollection()) localStorage.removeItem(PREV_KEY);
  renderBackup();
}

async function importBackup(ev) {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  const collection = cleanCollection(data && data.collezione);
  if (!collection) {
    alert("Questo file non è un backup di questa app. Scegli il file \"backup-lego-…\" che avevi esportato.");
    return;
  }
  const n = Object.keys(collection).length;
  const photos = Array.isArray(data.foto) ? data.foto.filter((p) => p && typeof p.id === "string" && typeof p.set === "string" && typeof p.img === "string") : [];
  const withPhotos = photos.length ? ` e ${photos.length} foto` : "";
  if (!confirm(`Il backup del ${fmtDate(data.data) || "data sconosciuta"} contiene ${n} set${withPhotos}. Sostituire la collezione attuale?${photos.length ? "\n\nLe foto vengono aggiunte a quelle già presenti (nessuna foto viene cancellata, nemmeno con \"Annulla l'ultimo import\")." : ""}`)) return;
  // Le foto del backup si aggiungono a quelle già sul telefono: nessuna foto viene cancellata.
  let photoErrors = 0;
  for (const p of photos) {
    try {
      const blob = dataUrlToBlob(p.img);
      if (!blob) throw new Error("foto non valida");
      await putPhoto({ id: p.id, set: p.set, date: typeof p.data === "string" ? p.data : new Date().toISOString(), blob });
    } catch { photoErrors++; }
  }
  await loadPhotoCounts();
  if (photoErrors) alert(`Attenzione: ${photoErrors} foto non sono state recuperate (file rovinato o memoria del telefono piena).`);
  try { localStorage.setItem(PREV_KEY, JSON.stringify(state.collection)); } catch {}
  state.collection = collection;
  state.collectionVersion++;
  if (saveCollection()) alert("Collezione recuperata!");
  renderBackup();
}

// ---------- Navigazione ----------

let currentRoute = "";
let pendingSave = null;
const flushPending = () => { if (pendingSave) pendingSave(); };
window.addEventListener("pagehide", flushPending);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { flushPending(); stopScan(); releaseCam(); }
  // Tornando nell'app mentre si è in Scansiona (e non si guarda un risultato) la fotocamera riparte da sola.
  else if (location.hash === "#/scansiona" && $("#scan-box") && !$("#scan-box").hidden) startScan();
});

function route() {
  flushPending();
  stopScan();
  // Fuori da Scansiona la fotocamera si spegne del tutto (sull'iPhone sparisce il pallino verde);
  // resta in pausa solo dentro Scansiona, mentre si guarda un risultato, così le scansioni di fila non richiedono il permesso.
  if ((location.hash || "#/temi") !== "#/scansiona") releaseCam();
  const hash = location.hash || "#/temi";
  if (currentRoute.startsWith("#/catalogo")) state.catalogScroll = window.scrollY;
  if (currentRoute === "#/temi" || currentRoute === "") state.themesScroll = window.scrollY;
  if (currentRoute.startsWith("#/tema/") && state.themeView) state.themeView.scroll = window.scrollY;
  if (currentRoute === "#/collezione") state.collectionScroll = window.scrollY;
  const backFromCat = currentRoute.startsWith("#/collezione/") && hash === "#/collezione";
  state.cameFromApp = currentRoute !== "";
  currentRoute = hash;
  animateView();
  const [, page, arg] = hash.split("/");
  if (page === "set" && arg) renderDetail(decodeURIComponent(arg));
  else if (page === "collezione" && arg) renderCollectionCategory(Number(arg));
  else if (page === "collezione") renderCollection();
  else if (page === "desideri") renderWishlist();
  else if (page === "backup") renderBackup();
  else if (page === "scansiona") renderScan();
  else if (page === "tema" && arg) renderTheme(Number(arg));
  else if (page === "catalogo") renderCatalog();
  else renderThemes();
  // Tornando da una categoria, la collezione resta dov'era.
  if (backFromCat) window.scrollTo(0, state.collectionScroll || 0);
  else if (!["catalogo", "temi", "tema", undefined, ""].includes(page)) window.scrollTo(0, 0);
}

function setupInstallHint() {
  let dismissed = false;
  try { dismissed = localStorage.getItem("lego-hint-chiuso") === "1"; } catch {}
  if (isIosBrowser() && !dismissed) {
    $("#install-hint").hidden = false;
    $("#install-close").addEventListener("click", () => {
      $("#install-hint").hidden = true;
      localStorage.setItem("lego-hint-chiuso", "1");
    });
  }
}

async function start() {
  setupInstallHint();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  try {
    await loadCatalog();
  } catch (err) {
    $("#view").innerHTML = `<div class="empty"><b>Non riesco a caricare il catalogo</b>Controlla la connessione a internet e riapri l'app.</div>`;
    return;
  }
  window.addEventListener("hashchange", route);
  route();
  // Appena si sa quali set hanno foto, si aggiungono le 📷 all'elenco già mostrato.
  loadPhotoCounts().then(() => { if ($("#results")) renderResults(false, true); });
  // Poco dopo l'apertura prepara a pezzetti il testo per la ricerca, così la prima ricerca non si blocca.
  const sets = state.catalog.sets;
  let i = 0;
  const prepare = () => {
    for (const end = Math.min(i + 1500, sets.length); i < end; i++) searchKey(sets[i]);
    if (i < sets.length) setTimeout(prepare, 50);
  };
  setTimeout(prepare, 2000);
}

start();
