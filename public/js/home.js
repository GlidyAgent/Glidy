// Homepage: animated range + paper plane, live pool list and stats from Robinhood Chain.
import { api, avatar, esc, signed, usd } from "./lib.js";

const $ = (s) => document.querySelector(s);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// header + theme
const hd = $("#hd");
const onScroll = () => hd.classList.toggle("scrolled", scrollY > 20);
addEventListener("scroll", onScroll, { passive: true }); onScroll();
$("#themeBtn").onclick = () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("glidy.theme", next); } catch {}
};

// liquidity bars inside the range, and the plane gliding along the price line
const bars = [70, 120, 190, 250, 300, 260, 200, 130];
$("#heroBars").innerHTML = bars.map((h, i) => `<rect x="${162 + i * 24.5}" y="${400 - h}" width="18" height="${h}" rx="5" style="animation-delay:${i * 90}ms"/>`).join("");
const path = document.querySelector(".glide-svg .price"), plane = document.querySelector(".glide-svg .plane"), trail = document.querySelector(".glide-svg .trail");
const len = path.getTotalLength();
let t0 = performance.now();
function frame(now) {
  const k = reduced ? 0.42 : ((now - t0) / 9000) % 1;
  const d = k * len, p = path.getPointAtLength(d), q = path.getPointAtLength(Math.min(len, d + 2));
  const ang = (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI;
  plane.setAttribute("transform", `translate(${p.x} ${p.y - 30}) rotate(${ang - 18})`);
  trail.setAttribute("transform", `translate(${p.x} ${p.y - 30}) rotate(${ang - 18})`);
  if (!reduced) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// works-with marquee
const works = ["Robinhood Chain", "Uniswap v3", "WETH", "USDG", "NVDA", "TSLA", "SPY", "MetaMask", "Rabby", "Coinbase Wallet", "GeckoTerminal", "KyberSwap", "Claude", "MCP"];
$("#worksTrack").innerHTML = [...works, ...works].map((w) => `<span>${esc(w)}</span>`).join("");

// live pools
async function pools() {
  try {
    const r = await api("/tools/list_lp_pools?sort=apr&limit=8");
    $("#poolList").innerHTML = r.pools.map((p) => `<a class="prow" href="/app/#/pool?address=${esc(p.pool)}">
      <span class="pl">${avatar(p.base.symbol, p.base.address, p.base.image, { stock: p.base.stock })}${avatar(p.quote.symbol, p.quote.address, p.quote.image, { stock: p.quote.stock })}</span>
      <span class="pn"><b>${esc(p.base.symbol)} / ${esc(p.quote.symbol)}</b><small>${p.feePct}% fee · TVL ${usd(p.tvlUsd)}</small></span>
      <span class="pv hide-sm"><small>24h volume</small>${usd(p.volume24hUsd)}</span>
      <span class="pc hide-sm">${signed(p.change24hPct)}</span>
      <span class="pa"><b class="apr">${p.feeAprPct == null ? "–" : p.feeAprPct.toFixed(1) + "%"}</b><small>fee APR</small></span></a>`).join("");
    const all = await api("/tools/list_lp_pools?sort=tvl&limit=60").catch(() => r);
    $("#hsApr").textContent = r.pools[0]?.feeAprPct != null ? `${r.pools[0].feeAprPct.toFixed(0)}%` : "–";
    $("#hsTvl").textContent = usd(all.pools.reduce((s, p) => s + (p.tvlUsd || 0), 0));
    $("#hsPools").textContent = String(all.pools.length);
  } catch { $("#poolList").innerHTML = `<div class="fine">Pools load in a moment…</div>`; setTimeout(pools, 15000); }
}
pools();
setInterval(() => !document.hidden && pools(), 60000);
