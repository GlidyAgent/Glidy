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
    live(r.pools, all.pools);
  } catch { $("#poolList").innerHTML = `<div class="fine">Pools load in a moment…</div>`; setTimeout(pools, 15000); }
}
// The floating cards and the agent demo use the same live pools: nothing on this page is made up.
const width = (p) => { const m = Math.abs(p.change24hPct || 0); return m < 1.5 ? 2 : m < 4 ? 5 : m < 9 ? 10 : m < 18 ? 20 : 50; };
let checked = false;
async function live(byApr, byTvl) {
  const top = byApr[0], mover = [...byTvl].filter((p) => p.tvlUsd > 20000).sort((a, b) => Math.abs(b.change24hPct || 0) - Math.abs(a.change24hPct || 0))[0];
  if (top) { const c = $("#fc1"); c.hidden = false; c.innerHTML = `<span class="tag pass">top fee APR</span><b>${esc(top.base.symbol)} / ${esc(top.quote.symbol)}</b><small><em class="up">${top.feeAprPct.toFixed(0)}% APR</em> · TVL ${usd(top.tvlUsd)}</small>`; }
  if (mover) { const c = $("#fc2"); c.hidden = false; c.innerHTML = `<span class="tag warn">moved ${mover.change24hPct > 0 ? "+" : ""}${(mover.change24hPct || 0).toFixed(1)}% today</span><b>${esc(mover.base.symbol)} / ${esc(mover.quote.symbol)}</b><small>Glidy: use a ±${width(mover)}% range</small>`; }
  $("#chatBest").innerHTML = `Top pools by fee APR right now:<br>${byApr.slice(0, 3).map((p) => `• <b>${esc(p.base.symbol)}/${esc(p.quote.symbol)}</b> ${p.feePct}% · ~${p.feeAprPct.toFixed(0)}% APR · TVL ${usd(p.tvlUsd)}`).join("<br>")}`;
  if (checked) return;
  const pick = byApr.find((p) => [p.base.symbol, p.quote.symbol].includes("WETH") && p.tvlUsd > 100000) || byTvl.find((p) => [p.base.symbol, p.quote.symbol].includes("WETH"));
  if (!pick) return;
  checked = true;
  const w = width(pick);
  $("#chatAsk").hidden = false; $("#chatAsk").textContent = `check 0.05 ETH into ${pick.base.symbol}/${pick.quote.symbol} ±${w}%`;
  $("#chatCheck").hidden = false; $("#chatCheck").innerHTML = `<span class="faint">Running the Checkpoint on the live pool…</span>`;
  try {
    const g = await api(`/tools/check_lp?${new URLSearchParams({ pool: pick.pool, token: "ETH", amount: "0.05", widthPct: String(w) })}`);
    const pl = g.plan;
    $("#chatCheck").innerHTML = pl
      ? `<b>Checkpoint: ${esc(g.status.toUpperCase())}.</b> Deposit ${esc(pl.amount0)} ${esc(pl.token0.symbol)} + ${esc(pl.amount1)} ${esc(pl.token1.symbol)}, range ${pl.price.lower.toPrecision(5)} – ${pl.price.upper.toPrecision(5)} ${esc(pl.price.unit)}.<br>${g.checks.filter((c) => ["depth", "fees", "il"].includes(c.id)).map((c) => `• ${esc(c.detail)}`).join("<br>")}<br><span class="faint">Connect your wallet in the app to turn this into a ticket.</span>`
      : `Checkpoint: ${esc(g.status)}. ${esc(g.checks[0]?.detail || "")}`;
  } catch { $("#chatCheck").innerHTML = `<span class="faint">The Checkpoint is busy; open the app to run it.</span>`; checked = false; }
}

pools();
setInterval(() => !document.hidden && pools(), 60000);
