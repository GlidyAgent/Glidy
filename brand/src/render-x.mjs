// Renders the X profile picture and banner from x-kit.html: node brand/src/render-x.mjs
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)), out = path.resolve(here, "..");
const { chromium } = createRequire(import.meta.url)(execSync("npm root -g").toString().trim() + "/playwright/index.js");
const b = await chromium.launch();
for (const s of [1, 2]) {
  const p = await b.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: s });
  await p.goto("file://" + path.join(here, "x-kit.html"));
  await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(400);
  const sfx = s === 2 ? "@2x" : "";
  await (await p.$("#banner")).screenshot({ path: path.join(out, `glidy-x-banner-1500x500${sfx}.png`) });
  await (await p.$("#pfp")).screenshot({ path: path.join(out, `glidy-x-profile-400${sfx}.png`) });
}
await b.close();
console.log("rendered to", out);
