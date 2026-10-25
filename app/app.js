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
  photoCounts: {},      // numero di foto per set (le foto sono in IndexedDB)
};

// ---------- Utilità ----------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const fmtNum = (n) => (n == null ? null : n.toLocaleString("it-IT"));
const fmtDate = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" }) : "";
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
  box.className = img.className.includes("hero") ? "noimg" : "thumb";
  box.textContent = "Immagine non disponibile";
  img.replaceWith(box);
};

function imgTag(set, cls) {
  if (!set.img) return `<div class="${cls === "hero" ? "noimg" : "thumb"}">Immagine non disponibile</div>`;
  const src = cls === "hero" ? set.img : thumbUrl(set.img);
  return `<img class="${cls}" src="${esc(src)}" data-full="${esc(set.img)}" alt="" loading="lazy" onerror="imgFallback(this)">`;
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
  if (e.s === "none" && !e.f && !e.n && !e.d) delete state.collection[setNum];
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
      el.onerror = () => reject(new Error("immagine non leggibile"));
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
  const sets = raw.sets.map(([setNum, name, year, themeId, parts, img, figs]) => {
    const chain = chainOf(themeId);
    return {
      setNum, name, year, themeId, figs, chain,
      parts: parts || null, // 0 pezzi = dato mancante (libri, gadget…)
      img: imgUrl(img, raw.imgBase),
      root: chain[0] ?? null,
      base: setNum.replace(/-\d+$/, ""),
      key: norm(name) + " " + norm(setNum) + " " + chain.map((id) => norm(themes[id].name)).join(" "),
    };
  });
  // Ordinamenti calcolati una volta sola, così la ricerca resta veloce.
  const collator = new Intl.Collator("it", { numeric: true, sensitivity: "base" });
  [...sets].sort((a, b) => collator.compare(a.setNum, b.setNum)).forEach((s, i) => { s.codeRank = i; });
  [...sets].sort((a, b) => collator.compare(a.name, b.name)).forEach((s, i) => { s.nameRank = i; });
  const bySetNum = new Map(sets.map((s) => [s.setNum, s]));
  const byTheme = (ids) => [...ids].filter((id) => themes[id]).map((id) => themes[id]).sort((a, b) => collator.compare(a.name, b.name));
  const children = {};
  for (const s of sets) {
    for (let i = 1; i < s.chain.length; i++) (children[s.chain[i - 1]] ||= new Set()).add(s.chain[i]);
  }
  const rootThemes = byTheme(new Set(sets.map((s) => s.root).filter((id) => id != null)));
  state.catalog = { generated: raw.generated, sets, bySetNum, themes, rootThemes, children, byTheme, imgBase: raw.imgBase };
}

// Dati Brickset: codici a barre, età, prezzi, valutazioni (caricati solo quando servono).
async function loadExtra() {
  if (state.extra) return state.extra;
  const res = await fetch("data/extra.json");
  if (!res.ok) throw new Error("dati extra non trovati");
  const raw = await res.json();
  const barcodes = new Map();
  for (const [setNum, info] of Object.entries(raw.sets || {})) {
    for (const code of [info.ean, info.upc]) {
      const key = normBarcode(code);
      if (!key) continue;
      if (!barcodes.has(key)) barcodes.set(key, []);
      if (!barcodes.get(key).includes(setNum)) barcodes.get(key).push(setNum);
    }
  }
  state.extra = { sets: raw.sets || {}, barcodes };
  return state.extra;
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
    .map(([c, sym, label]) => `${esc(prices[c].toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }))} ${sym} <span class="muted small">(${label})</span>`);
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
    if (words.length && !words.every((w) => s.key.includes(w))) return false;
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

function setItem(s) {
  const e = entry(s.setNum);
  const meta = [s.setNum, s.year, s.parts != null ? `${fmtNum(s.parts)} pezzi` : null].filter(Boolean).join(" · ");
  const badge = e.s !== "none" ? `<span class="badge st-${e.s}">${esc(STATUS_LABEL[e.s])}</span>` : "";
  return `<li><a class="item" href="#/set/${encodeURIComponent(s.setNum)}">
    ${imgTag(s, "thumb")}
    <div class="info"><div class="name">${esc(s.name)}</div><div class="meta">${esc(meta)}</div>${badge}</div>
    ${state.photoCounts[s.setNum] ? '<span class="fav" title="Ha foto">📷</span>' : ""}${e.f ? '<span class="fav">❤️</span>' : ""}
  </a></li>`;
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
    <ul class="list" id="results"></ul>
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
  window.scrollTo(0, state.catalogScroll);
}

function filterLabel() {
  const f = state.filters;
  const n = ["theme", "yearFrom", "yearTo", "partsMin", "partsMax", "status"].filter((k) => f[k] !== "").length;
  return `Filtri${n ? ` (${n})` : ""}`;
}

let moreObserver = null;

// Disegna la lista; con append=true aggiunge solo le righe nuove ("Mostra altri").
function renderResults(append = false) {
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
  else results.innerHTML = rows;
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
  const showDate = e.s === "built" || e.s === "apart" || e.d;

  $("#view").innerHTML = `
    ${imgTag(s, "hero")}
    <h2 class="set-title">${esc(s.name)}</h2>
    <div class="muted">${esc(s.setNum)}${s.year ? " · " + s.year : ""}</div>

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
      <div class="field">
        <label for="notes">Note</label>
        <textarea id="notes" placeholder="es. manca un pezzo, regalo di Natale…">${esc(e.n || "")}</textarea>
      </div>
      <button class="btn fav-btn" id="fav">${e.f ? "❤️ Nei preferiti" : "🤍 Aggiungi ai preferiti"}</button>
      <div class="saved" id="saved"></div>
    </div>

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
        <dt>Pezzi</dt><dd>${val(fmtNum(s.parts))}</dd>
        <dt>Minifigure</dt><dd>${val(s.figs)}</dd>
        <dt>Codice a barre</dt><dd id="x-barcode">${NA}</dd>
        <dt>Fascia d'età</dt><dd id="x-age">${NA}</dd>
        <dt>Prezzo di listino</dt><dd id="x-price">${NA}</dd>
        <dt>Valutazione</dt><dd id="x-rating">${NA}</dd>
        <dt>Istruzioni</dt><dd><a href="https://www.lego.com/it-it/service/building-instructions/${encodeURIComponent(base)}" target="_blank" rel="noopener">Cerca sul sito LEGO</a></dd>
        <dt>Scheda</dt><dd><a href="https://rebrickable.com/sets/${encodeURIComponent(s.setNum)}/" target="_blank" rel="noopener">Apri su Rebrickable</a><br><a href="https://brickset.com/sets/${encodeURIComponent(s.setNum)}" target="_blank" rel="noopener">Apri su Brickset</a></dd>
      </dl>
    </div>

    ${s.figs ? `<div class="card"><h2>Minifigure</h2><div id="figs" class="muted small">Caricamento…</div></div>` : ""}

    ${variants.length ? `<div class="card"><h2>Varianti</h2><ul class="list">${variants.map(setItem).join("")}</ul></div>` : ""}

    ${related.length ? `<div class="card"><h2>Set correlati</h2><p class="muted small">Stesso tema, usciti negli stessi anni.</p><ul class="list">${related.map(setItem).join("")}</ul></div>` : ""}`;

  const flash = () => {
    const el = $("#saved");
    if (!el) return;
    el.textContent = "✓ Salvato";
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { el.textContent = ""; }, 1500);
  };
  document.querySelectorAll(".status-btn").forEach((btn) => btn.addEventListener("click", () => {
    const st = btn.dataset.status;
    const changes = { s: st };
    if (["none", "wish", "owned"].includes(st)) changes.d = undefined; // non ancora costruito: niente data
    const ok = updateEntry(setNum, changes);
    document.querySelectorAll(".status-btn").forEach((b) => { b.className = "status-btn" + (b.dataset.status === st ? " on st-" + st : ""); });
    const cur = entry(setNum);
    $("#date-field").hidden = !(st === "built" || st === "apart" || cur.d);
    $("#built-date").value = cur.d || "";
    if (ok) flash();
  }));
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
    if (x.rating) $("#x-rating").innerHTML = `${esc(x.rating.toLocaleString("it-IT"))} su 5 <span class="muted small">(Brickset)</span>`;
  }).catch(() => {});

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
      await draw();
      msg.textContent = "✓ Foto salvata. Ricordati ogni tanto di fare il Backup.";
    } catch (err) {
      msg.textContent = "";
      alert("Non sono riuscito a salvare la foto (memoria del telefono piena?). Riprova con un'altra foto.");
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

function stopScan() {
  scanGen++;
  if (scanControls) { try { scanControls.stop(); } catch {} scanControls = null; }
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
    const reader = new ZXingBrowser.BrowserMultiFormatReader();
    const controls = await reader.decodeFromConstraints(
      { video: { facingMode: "environment" } }, $("#cam"),
      (result, err, ctrl) => {
        if (!result) return;
        ctrl.stop();
        scanControls = null;
        if (navigator.vibrate) navigator.vibrate(80);
        handleCode(result.getText(), false);
      });
    if (gen !== scanGen || location.hash !== "#/scansiona") { controls.stop(); return; }
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
      const { barcodes, sets } = await loadExtra();
      extraMissing = Object.keys(sets).length === 0;
      matches = (barcodes.get(normBarcode(digits)) || []).map((n) => state.catalog.bySetNum.get(n)).filter(Boolean);
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
    out.innerHTML = `<div class="card"><h2>Ho trovato ${matches.length} set</h2><ul class="list">${matches.map(setItem).join("")}</ul></div>${again}`;
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
  return Object.entries(state.collection)
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
    ["photo", "Con foto 📷", (e, num) => state.photoCounts[num]],
  ];
  const draw = () => {
    const [, , filter] = chips.find((c) => c[0] === state.collectionChip) || chips[0];
    const list = collectionList(filter);
    $("#view").innerHTML = `${isIosBrowser() ? SAFARI_WARNING : ""}
      ${statsCard()}
      <div class="chips">${chips.map(([id, label, fn]) =>
        `<button class="chip ${id === state.collectionChip ? "on" : ""}" data-chip="${id}">${esc(label)} (${collectionList(fn).length})</button>`).join("")}</div>
      ${list.length ? `<ul class="list">${list.map(setItem).join("")}</ul>` :
        `<div class="empty"><b>Ancora niente qui</b>Cerca un set nel <a href="#/catalogo">Catalogo</a>, aprilo e scegli il suo stato (per esempio "Costruito").</div>`}`;
    document.querySelectorAll("[data-chip]").forEach((b) => b.addEventListener("click", () => { state.collectionChip = b.dataset.chip; draw(); }));
    fillValue();
  };
  draw();
  // Le foto si contano in un secondo momento: quando arrivano si aggiornano numeri e 📷.
  loadPhotoCounts().then(() => { if (location.hash === "#/collezione") draw(); });
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
  const tile = (n, label, id = "") => `<div class="stat"${id ? ` id="${id}"` : ""}><b>${n}</b><span>${label}</span></div>`;
  return `<div class="card">
    <h2>Le mie statistiche</h2>
    <div class="stats">
      ${tile(fmtNum(owned.length), "set posseduti")}
      ${tile(fmtNum(built.length), "set costruiti")}
      ${tile(fmtNum(builtParts), "pezzi costruiti")}
      ${tile(fmtNum(wish.length), "set desiderati")}
      ${tile(fmtNum(photos), "foto")}
      ${tile('<span class="na">…</span>', "valore indicativo", "stat-value")}
    </div>
    ${missingParts ? `<p class="small muted">Pezzi non disponibili per ${missingParts} ${missingParts === 1 ? "set costruito" : "set costruiti"}: non sono contati.</p>` : ""}
    <p class="small muted" id="value-note"></p>
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
  show(`${Math.round(total).toLocaleString("it-IT")} €`,
    `Valore indicativo = somma dei prezzi di listino originali in euro (prezzo LEGO in Germania, da Brickset). ` +
    (priced < owned.length ? `Calcolato su ${priced} set su ${owned.length}: per gli altri il prezzo non è disponibile.` : `Calcolato su tutti i ${priced} set posseduti.`));
}

function renderWishlist() {
  setHeader("Lista desideri");
  setTab("desideri");
  const list = collectionList((e) => e.s === "wish");
  $("#view").innerHTML = list.length
    ? `<p class="muted small">${list.length === 1 ? "1 set desiderato" : list.length + " set desiderati"}</p><ul class="list">${list.map(setItem).join("")}</ul>`
    : `<div class="empty"><b>La lista desideri è vuota</b>Apri un set dal <a href="#/catalogo">Catalogo</a> e tocca "Desiderato".</div>`;
}

function renderBackup() {
  setHeader("Backup");
  setTab("backup");
  const count = Object.keys(state.collection).length;
  const last = localStorage.getItem(BACKUP_KEY);
  $("#view").innerHTML = `
    <div class="card">
      <h2>Salva una copia della collezione</h2>
      <p class="small">La collezione è salvata su questo telefono. Ogni tanto salva una copia (per esempio in iCloud Drive o mandala a te stessa via email): se cambi telefono o cancelli l'app, potrai recuperare tutto.</p>
      <p class="small muted">Set nella collezione: ${count}. Foto: <span id="backup-photos">…</span>. Ultimo backup: ${last ? fmtDate(last) : "mai"}.</p>
      <p class="small muted">Le tue foto sono dentro il backup: con molte foto il file diventa grande (circa 0,3 MB per foto).</p>
      <button class="btn primary full" id="export">Esporta backup</button>
    </div>
    <div class="card">
      <h2>Recupera da un backup</h2>
      <p class="small">Scegli un file di backup salvato prima. La collezione attuale sarà sostituita da quella del file.</p>
      <input type="file" id="import" accept=".json,application/json" hidden>
      <button class="btn full" id="import-btn">Importa backup</button>
      ${localStorage.getItem(PREV_KEY) ? `<button class="btn full" id="undo-import" style="margin-top:8px">Annulla l'ultimo import</button>` : ""}
    </div>
    <div class="card small muted">
      Catalogo: ${fmtNum(state.catalog.sets.length)} set, aggiornato il ${fmtDate(state.catalog.generated)}.<br>
      Dati del catalogo da <a href="https://rebrickable.com" target="_blank" rel="noopener">Rebrickable</a>; codici a barre, età e prezzi da <a href="https://brickset.com" target="_blank" rel="noopener">Brickset</a>. Si aggiorna da solo.
    </div>`;
  $("#export").addEventListener("click", exportBackup);
  $("#import-btn").addEventListener("click", () => $("#import").click());
  $("#import").addEventListener("change", importBackup);
  if ($("#undo-import")) $("#undo-import").addEventListener("click", undoImport);
  loadPhotoCounts().then((c) => {
    if ($("#backup-photos")) $("#backup-photos").textContent = Object.values(c).reduce((a, b) => a + b, 0);
  });
}

async function exportBackup() {
  const btn = $("#export");
  let foto = [];
  try {
    btn.disabled = true;
    btn.textContent = "Preparo il backup…";
    for (const p of await allPhotos()) foto.push({ id: p.id, set: p.set, data: p.date, img: await blobToDataUrl(p.blob) });
  } catch (err) {
    if (!confirm("Non riesco a leggere le foto. Vuoi fare lo stesso il backup, ma senza foto?")) { renderBackup(); return; }
    foto = [];
  }
  btn.disabled = false;
  btn.textContent = "Esporta backup";
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
  if (!confirm(`Il backup del ${fmtDate(data.data) || "data sconosciuta"} contiene ${n} set${withPhotos}. Sostituire la collezione attuale?`)) return;
  // Le foto del backup si aggiungono a quelle già sul telefono: nessuna foto viene cancellata.
  let photoErrors = 0;
  for (const p of photos) {
    const blob = dataUrlToBlob(p.img);
    try {
      if (!blob) throw new Error("foto non valida");
      await putPhoto({ id: p.id, set: p.set, date: typeof p.data === "string" ? p.data : new Date().toISOString(), blob });
    } catch { photoErrors++; }
  }
  await loadPhotoCounts();
  if (photoErrors) alert(`Attenzione: ${photoErrors} foto non sono state recuperate (memoria del telefono piena?).`);
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
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushPending(); });

function route() {
  flushPending();
  stopScan();
  const hash = location.hash || "#/catalogo";
  if (currentRoute.startsWith("#/catalogo") || currentRoute === "") state.catalogScroll = window.scrollY;
  state.cameFromApp = currentRoute !== "";
  currentRoute = hash;
  const [, page, arg] = hash.split("/");
  if (page === "set" && arg) renderDetail(decodeURIComponent(arg));
  else if (page === "collezione") renderCollection();
  else if (page === "desideri") renderWishlist();
  else if (page === "backup") renderBackup();
  else if (page === "scansiona") renderScan();
  else renderCatalog();
  if (page !== "catalogo" && page !== undefined && page !== "") window.scrollTo(0, 0);
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
  loadPhotoCounts().then(() => { if ($("#results")) renderResults(); });
}

start();
