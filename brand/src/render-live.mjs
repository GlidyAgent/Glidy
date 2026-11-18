// Renders the "$GLIDY is live" post image (1600x900, plus @2x): node brand/src/render-live.mjs
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)), out = path.resolve(here, "..");
const { chromium } = createRequire(import.meta.url)(execSync("npm root -g").toString().trim() + "/playwright/index.js");
const b = await chromium.launch();
for (const s of [1, 2]) {
  const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: s });
  await p.goto("file://" + path.join(here, "live-banner.html"));
  await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(400);
  await (await p.$("#live")).screenshot({ path: path.join(out, `glidy-live-1600x900${s === 2 ? "@2x" : ""}.png`) });
}
await b.close();
console.log("rendered");
