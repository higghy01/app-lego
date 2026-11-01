"use strict";
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium, devices } = require("playwright");
let root = path.resolve(process.argv[2]); const nuova = path.resolve(process.argv[3]);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const srv = http.createServer((req, res) => {
  let f = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "max-age=600" });
  fs.createReadStream(f).pipe(res);
});
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
srv.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });

  const t0 = Date.now(); let navs = 0;
  const slides = (p) => p.evaluate(() => [...document.querySelectorAll(".gallery .slide")].map((e) => (e.dataset.full || "").split("/").pop()).join(","));
  let page = await ctx.newPage();
  await page.goto(base + "#/temi"); await page.waitForTimeout(2000);
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 });
  await page.goto(base + "#/set/60481-1"); await page.waitForTimeout(2000);
  console.log("vecchia:", await slides(page));
  await page.close();
  root = nuova;
  page = await ctx.newPage();
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) { navs++; console.log("navigazione", navs, ((Date.now() - t0) / 1000).toFixed(1) + "s"); } });
  page.on("console", (m) => console.log("console:", m.text()));
  await page.goto(base + "#/set/60481-1");
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(1500); try { console.log((i * 1.5 + 1.5) + "s:", await slides(page)); } catch (e) { console.log("ricarica in corso"); } }
  console.log("navigazioni totali", navs);
  for (const s of ["80113-1", "21065-1"]) { await page.goto(base + "#/set/" + s); await page.waitForTimeout(3000); console.log(s, await slides(page)); await page.screenshot({ path: process.argv[4] + "/aggiorna-" + s + ".png" }); }
  await page.goto(base + "#/set/60481-1"); await page.waitForTimeout(3000); await page.screenshot({ path: process.argv[4] + "/aggiorna-60481-1.png" });
  await browser.close(); srv.close();
});
