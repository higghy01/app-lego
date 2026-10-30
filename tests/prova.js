// Prova automatica prima di ogni pubblicazione: apre l'app come su un iPhone e controlla le cose essenziali.
// Uso: node tests/prova.js CARTELLA_SITO   (la cartella con index.html e data/, es. _site)
// Se qualcosa non va, esce con errore e la pubblicazione si ferma.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium, devices } = require("playwright");

const dir = path.resolve(process.argv[2] || "_site");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let file = path.join(dir, decodeURIComponent(req.url.split("?")[0].split("#")[0]));
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
      if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

const check = (ok, msg) => { if (!ok) throw new Error("NON VA: " + msg); console.log("ok   " + msg); };

(async () => {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  // Le immagini esterne non servono alla prova (e non sempre si raggiungono).
  await ctx.route((u) => !u.href.startsWith(base), (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(base + "#/temi");
    await page.waitForSelector(".tile", { timeout: 20000 });
    check((await page.locator(".tiles .tile").count()) >= 20, "pagina Temi con le caselle dei temi");

    await page.click('.tabs a[data-tab="catalogo"]');
    await page.waitForSelector("#results li");
    const count = Number((await page.textContent("#count")).replace(/\D/g, ""));
    check(count > 10000, `catalogo con ${count} set`);

    await page.fill("#q", "75192");
    await page.waitForFunction(() => document.querySelector("#results li .name")?.textContent.includes("Millennium"));
    check(true, "ricerca per codice trova il Millennium Falcon");

    await page.click("#results li a");
    await page.waitForSelector(".status-btn");
    check((await page.locator(".status-btn").count()) === 6, "scheda del set con i 6 stati");
    await page.waitForFunction(() => !document.querySelector("#x-desc .mini-load"), null, { timeout: 15000 });
    check(/\d/.test(await page.textContent("#x-barcode")), "dati Brickset (codice a barre) nella scheda");

    await page.click('.status-btn[data-status="built"]');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("lego-collezione-v1")));
    check(saved["75192-1"]?.s === "built", "stato salvato sul telefono");

    await page.click('.tabs a[data-tab="collezione"]');
    await page.waitForSelector(".stat");
    await page.waitForTimeout(900);
    check((await page.locator(".stat b").first().textContent()) === "1", "Collezione: 1 set posseduto");

    await page.click('.tabs a[data-tab="backup"]');
    await page.waitForSelector("#export");
    check(/Catalogo: [\d.]+ set/.test(await page.textContent("#view")), "pagina Backup con la data del catalogo");

    check(errors.length === 0, "nessun errore di programma" + (errors.length ? ": " + errors.join(" | ") : ""));
    console.log("Tutto bene.");
  } finally {
    await browser.close();
    srv.close();
  }
})().catch((err) => { console.error(err.message); process.exit(1); });
