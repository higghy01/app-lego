// Temporaneo: telefono con la versione VECCHIA già installata, poi si pubblica quella nuova e si riapre l'app.
// node tmp-fogli/aggiorna.js VECCHIA NUOVA OUT NOME
"use strict";
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium, devices } = require("playwright");
let root = path.resolve(process.argv[2]);
const nuova = path.resolve(process.argv[3]), out = path.resolve(process.argv[4]), nome = process.argv[5];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const srv = http.createServer((req, res) => {
  let f = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  // come GitHub Pages: il browser può tenere la copia per 10 minuti
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "max-age=600" });
  fs.createReadStream(f).pipe(res);
});
const SETS = ["60481-1", "80113-1", "21065-1"];
srv.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const first = (p) => p.evaluate(() => [...document.querySelectorAll(".gallery .slide")].map((e) => (e.dataset.full || "figs").split("/").pop()).slice(0, 2).join(" , "));
  const rep = { nome, prima: {}, riapertura: {}, dopo8s: {}, ricaricata: false };
  let page = await ctx.newPage();
  await page.goto(base + "#/temi"); await page.waitForSelector(".tile", { timeout: 60000 });
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  for (const s of SETS) { await page.goto(base + "#/set/" + s); await page.waitForTimeout(2500); rep.prima[s] = await first(page); }
  await page.close();
  root = nuova; // si pubblica la versione nuova
  page = await ctx.newPage();
  await page.addInitScript(() => { window.__loads = (Number(sessionStorage.getItem("loads") || 0) + 1); sessionStorage.setItem("loads", window.__loads); });
  await page.goto(base + "#/set/" + SETS[0]); await page.waitForTimeout(1200);
  rep.riapertura[SETS[0]] = await first(page);
  await page.waitForTimeout(12000);
  rep.dopo8s[SETS[0]] = await first(page);
  rep.ricaricata = await page.evaluate(() => window.__loads > 1);
  await page.screenshot({ path: path.join(out, `aggiorna-${nome}-${SETS[0]}.png`) });
  for (const s of SETS.slice(1)) { await page.goto(base + "#/set/" + s); await page.waitForTimeout(2500); rep.dopo8s[s] = await first(page);
    await page.screenshot({ path: path.join(out, `aggiorna-${nome}-${s}.png`) }); }
  fs.writeFileSync(path.join(out, `aggiorna-${nome}.json`), JSON.stringify(rep, null, 1));
  console.log(JSON.stringify(rep));
  await browser.close(); srv.close();
});
