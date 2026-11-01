// Temporaneo: l'app PUBBLICATA (higghy01.github.io) su alcuni set: prima foto della galleria e screenshot.
"use strict";
const fs = require("fs"), path = require("path");
const { chromium, devices } = require("playwright");
const out = path.resolve(process.argv[2]);
const SETS = (process.argv[3] || "60481-1,80113-1,21065-1").split(",");
const BASE = process.argv[4] || "https://higghy01.github.io/app-lego/";
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();
  fs.mkdirSync(out, { recursive: true });
  const report = {};
  await page.goto(BASE + "#/temi"); await page.waitForSelector(".tile", { timeout: 60000 });
  report.extra = await page.evaluate(async (sets) => {
    const x = await (await fetch("data/extra.json", { cache: "no-store" })).json();
    return { generated: x.generated, sets: Object.fromEntries(sets.map((s) => [s, { box: x.sets[s]?.box, crop: x.sets[s]?.crop }])) };
  }, SETS);
  for (const s of SETS) {
    await page.goto(BASE + "#/set/" + s); await page.waitForSelector(".status-btn", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000);
    report[s] = await page.evaluate(() => ({ count: document.querySelector(".gallery .count")?.textContent || "",
      slides: [...document.querySelectorAll(".gallery .slide")].map((e) => e.dataset.full || "figs") }));
    await page.screenshot({ path: path.join(out, `${process.argv[5] || "sito"}-${s}.png`) });
  }
  fs.writeFileSync(path.join(out, (process.argv[5] || "sito") + ".json"), JSON.stringify(report, null, 1));
  await browser.close();
})();
