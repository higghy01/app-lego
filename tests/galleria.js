// Prova su TUTTI i set (sasha 1/11): la prima pagina della galleria della scheda è la stessa foto del fronte
// della scatola usata negli elenchi (extra.json "box"), con lo stesso ritaglio. Usa il programma vero dell'app
// (gallerySlides, boxPhoto) e i dati veri. Uso: node tests/galleria.js CARTELLA_SITO [file.json per il rapporto]
"use strict";
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("playwright");
const dir = path.resolve(process.argv[2] || "_site");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const srv = http.createServer((req, res) => {
  let f = path.join(dir, decodeURIComponent(req.url.split("?")[0]));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
});
srv.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.route((u) => !u.href.startsWith(base), (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto(base + "#/temi");
  await page.waitForFunction(() => window.state?.catalog || typeof state !== "undefined" && state.catalog, null, { timeout: 60000 });
  const r = await page.evaluate(async () => {
    await loadExtra();
    const figs = await loadMinifigs().catch(() => null);
    const out = { sets: 0, withBox: 0, withGallery: 0, galleryNoBox: 0, errors: [] };
    for (const s of state.catalog.sets) {
      out.sets++;
      const box = boxPhoto(s.setNum);
      const d = await loadDetails(s.setNum).catch(() => null);
      const slides = gallerySlides(s, d, figs);
      const first = firstSlides(s);
      if (d?.imgs?.length) out.withGallery++;
      const imgs = slides.filter((x) => x.img).map((x) => x.img + (x.crop ? "#r" : ""));
      if (new Set(imgs).size !== imgs.length) out.errors.push([s.setNum, "foto doppia in galleria"]);
      if (!box) { if (d?.imgs?.length) out.galleryNoBox++; continue; }
      out.withBox++;
      const bad = (what) => out.errors.push([s.setNum, what, box[0], slides[0]?.img]);
      if (slides[0]?.img !== box[0]) bad("la prima foto della galleria non è la scatola");
      else if (!!slides[0].crop !== !!box[2] || (box[2] && slides[0].crop.join() !== box[2].join())) bad("ritaglio diverso dagli elenchi");
      if (first[0]?.img !== box[0]) bad("la prima foto mostrata subito non è la scatola");
      if (boxThumb(s) !== box[1]) bad("miniatura degli elenchi diversa");
      if (box[2] && !slides.some((x, i) => i > 0 && x.img === box[0] && !x.crop) && d?.imgs?.some((x) => x.img === box[0])) bad("la foto intera col set montato è sparita");
    }
    return out;
  });
  await browser.close(); srv.close();
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(r, null, 1));
  console.log(`${r.sets} set, ${r.withGallery} con galleria, ${r.withBox} con la scatola, ${r.galleryNoBox} con galleria ma senza scatola`);
  for (const e of r.errors.slice(0, 30)) console.log("NON VA:", e.join(" | "));
  if (r.errors.length) { console.log(r.errors.length, "errori"); process.exit(1); }
  console.log("ok   in tutti i set con la scatola la prima foto della galleria è la scatola degli elenchi");
});
