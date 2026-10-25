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
const NA = '<span class="na">non disponibile</span>';

// ---------- Stato ----------

const state = {
  catalog: null,        // { generated, sets: [...], bySetNum, themes }
  minifigs: null,       // caricato solo quando serve
  collection: loadCollection(),
  filters: { q: "", theme: "", yearFrom: "", yearTo: "", partsMin: "", partsMax: "", status: "", sort: "year" },
  showFilters: false,
  shown: PAGE,
  catalogScroll: 0,
  collectionChip: "all",
};

// ---------- Utilità ----------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const fmtNum = (n) => (n == null ? null : n.toLocaleString("it-IT"));
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" }) : "");

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

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
  localStorage.setItem(STORE_KEY, JSON.stringify(state.collection));
}

function entry(setNum) {
  return state.collection[setNum] || { s: "none" };
}

function updateEntry(setNum, changes) {
  const e = { ...entry(setNum), ...changes, u: new Date().toISOString() };
  if (e.s === "none" && !e.f && !e.n && !e.d) delete state.collection[setNum];
  else state.collection[setNum] = e;
  saveCollection();
}

// ---------- Catalogo ----------

async function loadCatalog() {
  const res = await fetch("data/catalog.json");
  if (!res.ok) throw new Error("catalogo non trovato");
  const raw = await res.json();
  const themes = {};
  for (const [id, [name, parent]] of Object.entries(raw.themes)) themes[id] = { id: +id, name, parent };
  const rootOf = (id) => {
    let t = themes[id];
    while (t && t.parent != null && themes[t.parent]) t = themes[t.parent];
    return t ? t.id : null;
  };
  const sets = raw.sets.map(([setNum, name, year, themeId, parts, img, figs]) => ({
    setNum, name, year, themeId, parts, figs,
    img: imgUrl(img, raw.imgBase),
    root: rootOf(themeId),
    key: norm(name) + " " + norm(setNum),
  }));
  const bySetNum = new Map(sets.map((s) => [s.setNum, s]));
  const rootThemes = [...new Set(sets.map((s) => s.root))]
    .filter((id) => id != null)
    .map((id) => themes[id])
    .sort((a, b) => a.name.localeCompare(b.name, "it"));
  state.catalog = { generated: raw.generated, sets, bySetNum, themes, rootThemes, imgBase: raw.imgBase };
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

function filteredSets() {
  const f = state.filters;
  const q = norm(f.q.trim());
  const words = q.split(/\s+/).filter(Boolean);
  const num = (v) => (v === "" ? null : Number(v));
  const yFrom = num(f.yearFrom), yTo = num(f.yearTo), pMin = num(f.partsMin), pMax = num(f.partsMax);
  const theme = f.theme === "" ? null : Number(f.theme);
  let list = state.catalog.sets.filter((s) => {
    if (words.length && !words.every((w) => s.key.includes(w))) return false;
    if (theme != null && s.root !== theme) return false;
    if (yFrom != null && !(s.year >= yFrom)) return false;
    if (yTo != null && !(s.year <= yTo)) return false;
    if (pMin != null && !(s.parts >= pMin)) return false;
    if (pMax != null && !(s.parts <= pMax)) return false;
    if (f.status) {
      const st = entry(s.setNum).s;
      if (f.status === "fav" ? !entry(s.setNum).f : st !== f.status) return false;
    }
    return true;
  });
  // Se si cerca un codice (es. 10294) i set con quel numero vanno in cima.
  const codeMatch = (s) => (q && (norm(s.setNum) === q || norm(s.setNum).startsWith(q + "-")) ? 0 : 1);
  const sorters = {
    year: (a, b) => (b.year || 0) - (a.year || 0) || a.setNum.localeCompare(b.setNum, "it", { numeric: true }),
    yearAsc: (a, b) => (a.year || 0) - (b.year || 0) || a.setNum.localeCompare(b.setNum, "it", { numeric: true }),
    name: (a, b) => a.name.localeCompare(b.name, "it"),
    parts: (a, b) => (b.parts || 0) - (a.parts || 0),
  };
  const sorter = sorters[f.sort] || sorters.year;
  return list.sort((a, b) => codeMatch(a) - codeMatch(b) || sorter(a, b));
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
    ${e.f ? '<span class="fav">❤️</span>' : ""}
  </a></li>`;
}

function renderCatalog() {
  setHeader("Catalogo LEGO");
  setTab("catalogo");
  const f = state.filters;
  const themeOpts = state.catalog.rootThemes
    .map((t) => `<option value="${t.id}" ${String(t.id) === f.theme ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  const statusOpts = [...STATUSES.map((s) => [s.id, s.label]), ["fav", "Preferiti ❤️"]]
    .map(([id, label]) => `<option value="${id}" ${id === f.status ? "selected" : ""}>${esc(label)}</option>`).join("");
  const activeFilters = ["theme", "yearFrom", "yearTo", "partsMin", "partsMax", "status"].filter((k) => f[k] !== "").length;

  $("#view").innerHTML = `
    <div class="search-row">
      <input type="search" id="q" placeholder="Cerca per nome o codice (es. 10294)" value="${esc(f.q)}" autocomplete="off" enterkeyhint="search">
      <button class="btn" id="toggle-filters">Filtri${activeFilters ? ` (${activeFilters})` : ""}</button>
    </div>
    <div class="filters" id="filters" ${state.showFilters ? "" : "hidden"}>
      <div class="wide"><label>Tema</label><select data-f="theme"><option value="">Tutti i temi</option>${themeOpts}</select></div>
      <div><label>Anno da</label><input type="number" inputmode="numeric" data-f="yearFrom" value="${esc(f.yearFrom)}" placeholder="es. 2010"></div>
      <div><label>Anno a</label><input type="number" inputmode="numeric" data-f="yearTo" value="${esc(f.yearTo)}" placeholder="es. 2024"></div>
      <div><label>Pezzi minimo</label><input type="number" inputmode="numeric" data-f="partsMin" value="${esc(f.partsMin)}"></div>
      <div><label>Pezzi massimo</label><input type="number" inputmode="numeric" data-f="partsMax" value="${esc(f.partsMax)}"></div>
      <div class="wide"><label>Stato nella mia collezione</label><select data-f="status"><option value="">Qualsiasi</option>${statusOpts}</select></div>
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
      updateFilterButton();
      refresh();
    }, 250)));
  $("#toggle-filters").addEventListener("click", () => {
    state.showFilters = !state.showFilters;
    $("#filters").hidden = !state.showFilters;
  });
  $("#reset-filters").addEventListener("click", () => {
    Object.assign(f, { theme: "", yearFrom: "", yearTo: "", partsMin: "", partsMax: "", status: "" });
    renderCatalog();
  });
  renderResults();
  window.scrollTo(0, state.catalogScroll);
}

function updateFilterButton() {
  const f = state.filters;
  const n = ["theme", "yearFrom", "yearTo", "partsMin", "partsMax", "status"].filter((k) => f[k] !== "").length;
  $("#toggle-filters").textContent = `Filtri${n ? ` (${n})` : ""}`;
}

function renderResults() {
  const list = filteredSets();
  $("#count").textContent = list.length === 1 ? "1 set" : `${fmtNum(list.length)} set`;
  if (!list.length) {
    $("#results").innerHTML = `<li class="empty"><b>Nessun set trovato</b>Prova a cambiare la ricerca o i filtri.</li>`;
    $("#more").innerHTML = "";
    return;
  }
  $("#results").innerHTML = list.slice(0, state.shown).map(setItem).join("");
  if (list.length > state.shown) {
    $("#more").innerHTML = `<button class="btn full more">Mostra altri</button>`;
    const btn = $("#more button");
    btn.addEventListener("click", () => { state.shown += PAGE; renderResults(); });
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); state.shown += PAGE; renderResults(); }
    }, { rootMargin: "400px" });
    io.observe(btn);
  } else {
    $("#more").innerHTML = "";
  }
}

function renderDetail(setNum) {
  const s = state.catalog.bySetNum.get(setNum);
  setHeader(s ? s.setNum : setNum, "#/catalogo");
  setTab("");
  window.scrollTo(0, 0);
  if (!s) {
    $("#view").innerHTML = `<div class="empty"><b>Set non trovato</b>Il codice ${esc(setNum)} non è nel catalogo.</div>`;
    return;
  }
  const e = entry(setNum);
  const { theme, sub } = themePath(s.themeId);
  const base = s.setNum.replace(/-\d+$/, "");
  const variants = state.catalog.sets.filter((x) => x.setNum !== s.setNum && x.setNum.replace(/-\d+$/, "") === base);
  const val = (v) => (v == null || v === "" ? NA : esc(v));
  const showDate = e.s === "built" || e.s === "apart" || e.d;

  $("#view").innerHTML = `
    ${imgTag(s, "hero")}
    <h2 class="set-title">${esc(s.name)}</h2>
    <div class="muted">${esc(s.setNum)}${s.year ? " · " + s.year : ""}</div>

    <div class="card" style="margin-top:14px">
      <h2>La mia collezione</h2>
      <div class="status-grid">
        ${STATUSES.map((st) => `<button class="status-btn ${e.s === st.id ? "on st-" + st.id : ""}" data-status="${st.id}">${esc(st.label)}</button>`).join("")}
      </div>
      <div class="field" id="date-field" ${showDate ? "" : "hidden"}>
        <label for="built-date">Data in cui l'ho costruito</label>
        <input type="date" id="built-date" value="${esc(e.d || "")}">
      </div>
      <div class="field">
        <label for="notes">Note</label>
        <textarea id="notes" placeholder="es. manca un pezzo, regalo di Natale…">${esc(e.n || "")}</textarea>
      </div>
      <button class="btn fav-btn" id="fav">${e.f ? "❤️ Nei preferiti" : "🤍 Aggiungi ai preferiti"}</button>
      <div class="saved" id="saved"></div>
    </div>

    <div class="card">
      <h2>Dati del set</h2>
      <dl class="data">
        <dt>Codice</dt><dd>${esc(s.setNum)}</dd>
        <dt>Tema</dt><dd>${val(theme)}</dd>
        <dt>Sottotema</dt><dd>${sub ? esc(sub) : NA}</dd>
        <dt>Anno</dt><dd>${val(s.year)}</dd>
        <dt>Pezzi</dt><dd>${val(fmtNum(s.parts))}</dd>
        <dt>Minifigure</dt><dd>${val(s.figs)}</dd>
        <dt>Codice a barre</dt><dd>${NA}</dd>
        <dt>Fascia d'età</dt><dd>${NA}</dd>
        <dt>Prezzo di listino</dt><dd>${NA}</dd>
        <dt>Istruzioni</dt><dd><a href="https://www.lego.com/it-it/service/building-instructions/${encodeURIComponent(base)}" target="_blank" rel="noopener">Cerca sul sito LEGO</a></dd>
        <dt>Scheda</dt><dd><a href="https://rebrickable.com/sets/${encodeURIComponent(s.setNum)}/" target="_blank" rel="noopener">Apri su Rebrickable</a></dd>
      </dl>
    </div>

    ${s.figs ? `<div class="card"><h2>Minifigure</h2><div id="figs" class="muted small">Caricamento…</div></div>` : ""}

    ${variants.length ? `<div class="card"><h2>Varianti</h2><ul class="list">${variants.map(setItem).join("")}</ul></div>` : ""}`;

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
    if (st === "built" && !entry(setNum).d) changes.d = new Date().toISOString().slice(0, 10);
    updateEntry(setNum, changes);
    document.querySelectorAll(".status-btn").forEach((b) => { b.className = "status-btn" + (b.dataset.status === st ? " on st-" + st : ""); });
    const cur = entry(setNum);
    $("#date-field").hidden = !(st === "built" || st === "apart" || cur.d);
    $("#built-date").value = cur.d || "";
    flash();
  }));
  $("#built-date").addEventListener("change", (ev) => { updateEntry(setNum, { d: ev.target.value || undefined }); flash(); });
  $("#notes").addEventListener("input", debounce((ev) => { updateEntry(setNum, { n: ev.target.value.trim() ? ev.target.value : undefined }); flash(); }, 400));
  $("#fav").addEventListener("click", (ev) => {
    const f = !entry(setNum).f;
    updateEntry(setNum, { f: f || undefined });
    ev.target.textContent = f ? "❤️ Nei preferiti" : "🤍 Aggiungi ai preferiti";
    flash();
  });

  if (s.figs) {
    loadMinifigs().then((m) => {
      const list = m.sets[s.setNum] || [];
      const el = $("#figs");
      if (!el) return;
      if (!list.length) { el.innerHTML = NA; return; }
      el.classList.remove("muted", "small");
      el.innerHTML = `<ul class="figs">${list.map(([fig, qty]) => {
        const [name, , img] = m.figs[fig] || [fig];
        const src = imgUrl(img, m.imgBase);
        return `<li>${src ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ""}<span>${qty > 1 ? qty + " × " : ""}${esc(name)}</span></li>`;
      }).join("")}</ul>`;
    }).catch(() => { const el = $("#figs"); if (el) el.innerHTML = "Elenco non disponibile senza internet."; });
  }
}

function collectionList(filter) {
  return Object.entries(state.collection)
    .filter(([, e]) => filter(e))
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
  ];
  const draw = () => {
    const [, , filter] = chips.find((c) => c[0] === state.collectionChip) || chips[0];
    const list = collectionList(filter);
    $("#view").innerHTML = `
      <div class="chips">${chips.map(([id, label, fn]) =>
        `<button class="chip ${id === state.collectionChip ? "on" : ""}" data-chip="${id}">${esc(label)} (${collectionList(fn).length})</button>`).join("")}</div>
      ${list.length ? `<ul class="list">${list.map(setItem).join("")}</ul>` :
        `<div class="empty"><b>Ancora niente qui</b>Cerca un set nel <a href="#/catalogo">Catalogo</a>, aprilo e scegli il suo stato (per esempio "Costruito").</div>`}`;
    document.querySelectorAll("[data-chip]").forEach((b) => b.addEventListener("click", () => { state.collectionChip = b.dataset.chip; draw(); }));
  };
  draw();
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
      <p class="small muted">Set nella collezione: ${count}. Ultimo backup: ${last ? fmtDate(last) : "mai"}.</p>
      <button class="btn primary full" id="export">Esporta backup</button>
    </div>
    <div class="card">
      <h2>Recupera da un backup</h2>
      <p class="small">Scegli un file di backup salvato prima. La collezione attuale sarà sostituita da quella del file.</p>
      <input type="file" id="import" accept=".json,application/json" hidden>
      <button class="btn full" id="import-btn">Importa backup</button>
    </div>
    <div class="card small muted">
      Catalogo: ${fmtNum(state.catalog.sets.length)} set, aggiornato il ${fmtDate(state.catalog.generated)}.<br>
      Dati del catalogo da <a href="https://rebrickable.com" target="_blank" rel="noopener">Rebrickable</a>. Si aggiorna da solo ogni settimana.
    </div>`;
  $("#export").addEventListener("click", exportBackup);
  $("#import-btn").addEventListener("click", () => $("#import").click());
  $("#import").addEventListener("change", importBackup);
}

async function exportBackup() {
  const data = { app: "i-miei-lego", versione: 1, data: new Date().toISOString(), collezione: state.collection };
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

async function importBackup(ev) {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.collezione !== "object") throw new Error("il file non è un backup di questa app");
    const n = Object.keys(data.collezione).length;
    if (!confirm(`Il backup del ${fmtDate(data.data)} contiene ${n} set. Sostituire la collezione attuale?`)) return;
    state.collection = data.collezione;
    saveCollection();
    alert("Collezione recuperata!");
    renderBackup();
  } catch (err) {
    alert("Non riesco a leggere il file: " + err.message);
  }
}

// ---------- Navigazione ----------

let currentRoute = "";
function route() {
  const hash = location.hash || "#/catalogo";
  if (currentRoute.startsWith("#/catalogo") || currentRoute === "") state.catalogScroll = window.scrollY;
  state.cameFromApp = currentRoute !== "";
  currentRoute = hash;
  const [, page, arg] = hash.split("/");
  if (page === "set" && arg) renderDetail(decodeURIComponent(arg));
  else if (page === "collezione") renderCollection();
  else if (page === "desideri") renderWishlist();
  else if (page === "backup") renderBackup();
  else renderCatalog();
  if (page !== "catalogo" && page !== undefined && page !== "") window.scrollTo(0, 0);
}

function setupInstallHint() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  let dismissed = false;
  try { dismissed = localStorage.getItem("lego-hint-chiuso") === "1"; } catch {}
  if (ios && !standalone && !dismissed) {
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
}

start();
