// Temporaneo: screenshot dell'app vera (catalogo vero, foto vere) per controllare la scatola prima.
"use strict";
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium, devices } = require("playwright");
const dir = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
const SETS = ["21065-1", "72051-1", "42213-1", "60407-1", "71801-1", "71428-1", "10412-1", "41595-1", "75192-1", "76923-1"];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const srv = http.createServer((req, res) => {
  let f = path.join(dir, decodeURIComponent(req.url.split("?")[0]));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
});
srv.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();
  fs.mkdirSync(out, { recursive: true });
  const report = {};
  await page.goto(base + "#/temi"); await page.waitForSelector(".tile", { timeout: 30000 });
  for (const s of SETS) {
    await page.goto(base + "#/set/" + s); await page.waitForSelector(".status-btn", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(4000);
    report[s] = await page.evaluate(() => ({ count: document.querySelector(".gallery .count")?.textContent || "",
      first: document.querySelector(".gallery .slide img, .gallery .slide image")?.getAttribute("src") || document.querySelector(".gallery .slide image")?.getAttribute("href") }));
    await page.screenshot({ path: path.join(out, `scheda-${s}.png`) });
  }
  for (const q of ["Sagrada", "60407", "Donkey Kong"]) {
    await page.goto(base + "#/catalogo"); await page.waitForSelector("#q");
    await page.fill("#q", q); await page.waitForTimeout(5000);
    await page.screenshot({ path: path.join(out, `catalogo-${q.replace(/ /g, "")}.png`) });
  }
  await page.goto(base + "#/temi"); await page.waitForTimeout(1500);
  await page.locator('.tiles .tile:has-text("Architecture")').first().click().catch(() => {});
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(out, "tema-architecture.png") });
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 1));
  await browser.close(); srv.close();
});
