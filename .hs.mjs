import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const { chromium } = createRequire(import.meta.url)(execSync("npm root -g").toString().trim() + "/playwright/index.js");
const SP = process.argv[2], B = "http://127.0.0.1:9470", name = process.argv[3] || "gate";
const b = await chromium.launch(); const errs = [];
for (const [w, h, sfx] of [[1562, 827, ""], [390, 844, "-m"]]) {
  const p = await b.newPage({ viewport: { width: w, height: h } }); p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(B + "/app/#/desk"); await p.waitForTimeout(4000);
  await p.screenshot({ path: `${SP}/${name}${sfx}.png` });
  if (!sfx) console.log(await p.evaluate(() => [...document.querySelectorAll("*")].filter((e) => { const r = e.getBoundingClientRect(); return r.width <= 4 && r.height > 300 && r.left > 1400 && r.left < 1560; }).map((e) => e.className + " " + e.tagName + " " + Math.round(e.getBoundingClientRect().left))));
}
console.log("errors", errs); await b.close();
