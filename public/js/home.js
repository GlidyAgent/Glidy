// Homepage: the product showcase. Ambient motion, the paper plane flying a live pool, a live pool tape, stats and the
// best pool per strategy. Everything you can use (agent, pools, Checkpoint, positions) lives in the app, behind a wallet.
import { api, avatar, esc, signed, usd } from "./lib.js";

const $ = (s) => document.querySelector(s);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const fmt = (x) => (x == null ? "–" : x >= 1000 ? x.toLocaleString("en-US", { maximumFractionDigits: 2 }) : x >= 1 ? x.toFixed(4) : x.toPrecision(4));
const money = (x, d = 2) => (x == null ? "–" : "$" + x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const logos = (p) => avatar(p.base.symbol, p.base.address, p.base.image, { stock: p.base.stock }) + avatar(p.quote.symbol, p.quote.address, p.quote.image, { stock: p.quote.stock });
const pairName = (p) => `${p.base.symbol} / ${p.quote.symbol}`;
const hasSol = (p) => [p.base.symbol, p.quote.symbol].includes("SOL");
const widthFor = (p) => { const m = Math.abs(p?.change24hPct || 0); return m < 1.5 ? 2 : m < 4 ? 5 : m < 9 ? 10 : m < 18 ? 20 : 50; };

// ---------- header, theme, ambient ----------
const hd = $("#hd");
const onScroll = () => hd.classList.toggle("scrolled", scrollY > 16);
addEventListener("scroll", onScroll, { passive: true }); onScroll();
$("#themeBtn").onclick = () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("glidy.theme", next); } catch {}
};
if (!reduced && matchMedia("(pointer: fine)").matches) {
  const spot = $("#spot"), card = document.querySelector(".art-card");
  addEventListener("pointermove", (e) => {
    spot.style.left = e.clientX + "px"; spot.style.top = e.clientY + "px";
    const r = card.getBoundingClientRect();
    if (e.clientX > r.left - 80 && e.clientX < r.right + 80 && e.clientY > r.top - 80 && e.clientY < r.bottom + 80) {
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      card.style.transform = `perspective(1200px) rotateY(${x * 6}deg) rotateX(${-y * 6}deg)`;
    } else card.style.transform = "";
  }, { passive: true });
  document.querySelectorAll(".tilt, .prod:not(.prod-hero)").forEach((el) => {
    el.addEventListener("pointermove", (e) => { const r = el.getBoundingClientRect(); el.style.transform = `perspective(900px) rotateY(${((e.clientX - r.left) / r.width - 0.5) * 6}deg) rotateX(${-((e.clientY - r.top) / r.height - 0.5) * 6}deg) translateY(-4px)`; });
    el.addEventListener("pointerleave", () => (el.style.transform = ""));
  });
}

// reveal on scroll
const onView = new Map();
const io = new IntersectionObserver((es) => es.forEach((e) => {
  if (!e.isIntersecting) return;
  e.target.classList.add("in");
  const fn = onView.get(e.target); if (fn) { onView.delete(e.target); fn(); }
  io.unobserve(e.target);
}), { threshold: 0.15 });
document.querySelectorAll(".rv").forEach((el) => io.observe(el));

// ---------- hero art: the price line, the range band, the plane, fees popping while it is in range ----------
const pricePath = $("#pricePath"), plane = $("#plane"), trail = $("#trailPath"), feesG = $("#fees");
const BAND = [160, 360];
$("#heroBars").innerHTML = [40, 78, 120, 168, 200, 176, 132, 88, 52].map((h, i) => `<rect x="${166 + i * 21.4}" y="${290 - h}" width="15" height="${h}" rx="4" style="animation-delay:${i * 70}ms, ${1.2 + i * 0.2}s"/>`).join("");
function newPath() {
  let y = 150 + (Math.random() - 0.5) * 60, d = `M0 ${y.toFixed(1)}`;
  for (let x = 40; x <= 520; x += 40) { y = Math.min(250, Math.max(40, y + (Math.random() - 0.5) * 90)); d += ` S${x - 20} ${y.toFixed(1)} ${x} ${y.toFixed(1)}`; }
  pricePath.setAttribute("d", d);
  return pricePath.getTotalLength();
}
let pathLen = newPath(), t0 = performance.now(), lastFee = 0, feePerTick = 0.01, heroInRange = true;
function frame(now) {
  const k = reduced ? 0.45 : (now - t0) / 9000;
  if (k >= 1) { t0 = now; pathLen = newPath(); }
  const d = Math.min(1, k % 1) * pathLen, p = pricePath.getPointAtLength(d), q = pricePath.getPointAtLength(Math.min(pathLen, d + 2));
  const ang = (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI;
  const tf = `translate(${p.x} ${p.y - 26}) rotate(${ang - 16})`;
  plane.setAttribute("transform", tf); trail.setAttribute("transform", tf);
  const inside = p.x >= BAND[0] && p.x <= BAND[1];
  if (inside !== heroInRange) { heroInRange = inside; const t = $("#artTag"); t.className = `tag ${inside ? "pass" : "warn"}`; t.textContent = inside ? "in range · earning" : "price outside range"; }
  if (inside && now - lastFee > 520 && !reduced) {
    lastFee = now;
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", p.x); t.setAttribute("y", p.y - 44); t.setAttribute("class", "fee"); t.textContent = `+$${feePerTick.toFixed(feePerTick < 0.01 ? 4 : 2)}`;
    feesG.append(t); setTimeout(() => t.remove(), 1600);
  }
  if (!reduced) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- live data for the showcase ----------
let byApr = [], byTvl = [], hero = null;

function paintHero() {
  hero = byApr.find((p) => p.tvlUsd > 150000 && hasSol(p)) || byApr.find((p) => p.tvlUsd > 50000) || byApr[0];
  if (!hero) return;
  $("#artLogos").innerHTML = logos(hero);
  $("#artName").textContent = pairName(hero);
  $("#artSub").textContent = `Orca · ${hero.feePct}% fee · Solana`;
  $("#artApr").textContent = `${hero.feeAprPct.toFixed(1)}%`;
  $("#artTvl").textContent = usd(hero.tvlUsd);
  $("#artVol").textContent = usd(hero.volume24hUsd);
  const perDay = (1000 * hero.feeAprPct) / 100 / 365;
  $("#artDay").textContent = money(perDay);
  feePerTick = (perDay / 86400) * 600;
  const w = widthFor(hero);
  api(`/tools/pool_state?pool=${hero.pool}`).then((s) => { $("#artLo").textContent = fmt(s.price * (1 - w / 100)); $("#artHi").textContent = fmt(s.price * (1 + w / 100)); }).catch(() => {});
  const top = byApr[0], mover = [...byTvl].filter((p) => p.tvlUsd > 100000 && Math.abs(p.change24hPct || 0) < 300).sort((a, b) => Math.abs(b.change24hPct || 0) - Math.abs(a.change24hPct || 0))[0];
  if (top) { const c = $("#fc1"); c.hidden = false; c.innerHTML = `<span class="tag pass">#1 fee APR</span><b>${esc(pairName(top))}</b><small><em class="up">${top.feeAprPct.toFixed(0)}% APR</em> · TVL ${usd(top.tvlUsd)}</small>`; }
  if (mover) { const c = $("#fc2"); c.hidden = false; c.innerHTML = `<span class="tag warn">${mover.change24hPct > 0 ? "▲" : "▼"} ${Math.abs(mover.change24hPct || 0).toFixed(1)}% today</span><b>${esc(pairName(mover))}</b><small>Glidy suggests a ±${widthFor(mover)}% range</small>`; }
}

function paintTape() {
  const items = byApr.slice(0, 18).map((p) => `<a class="tp" href="/app/"><span class="pl">${logos(p)}</span><b>${esc(pairName(p))}</b><em class="apr">${p.feeAprPct.toFixed(0)}% APR</em>${signed(p.change24hPct, 1)}</a>`).join("");
  $("#tape").innerHTML = items + items;
}

function countUp(el, to, f) {
  if (reduced) { el.textContent = f(to); return; }
  const s = performance.now(), dur = 1600;
  const step = (now) => { const k = Math.min(1, (now - s) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = f(to * e); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
let statsDone = false;
function paintStats() {
  if (statsDone || !byTvl.length) return;
  statsDone = true;
  const tvl = byTvl.reduce((s, p) => s + (p.tvlUsd || 0), 0), vol = byTvl.reduce((s, p) => s + (p.volume24hUsd || 0), 0);
  countUp($("#stTvl"), tvl, usd); countUp($("#stVol"), vol, usd);
  countUp($("#stApr"), byApr[0]?.feeAprPct || 0, (x) => `${x.toFixed(0)}%`); countUp($("#stPools"), byTvl.length, (x) => String(Math.round(x)));
}

// strategies: the best live pool in each bucket; starting one opens the app (wallet first)
const MAJORS = new Set(["SOL", "WSOL", "USDC", "USDT", "JUP", "JITOSOL", "MSOL", "BSOL", "JUPSOL", "USDS", "PYUSD"]);
const kindOf = (p) => (p.base.stock || p.quote.stock ? "stocks" : MAJORS.has(p.base.symbol) && MAJORS.has(p.quote.symbol) ? "calm" : "coins");
function paintStrats() {
  document.querySelectorAll("#strat3 .scard").forEach((card) => {
    const k = card.dataset.k;
    const best = byTvl.filter((p) => p.feeAprPct != null && kindOf(p) === k && p.tvlUsd > (k === "coins" ? 30000 : 50000)).sort((a, b) => b.feeAprPct - a.feeAprPct)[0];
    if (!best) return;
    const w = Math.max({ calm: 2, stocks: 10, coins: 50 }[k], widthFor(best));
    card.href = `/app/#/pool?address=${best.pool}&width=${w}`;
    card.querySelector(".sc-pool").innerHTML = `<span class="pl">${logos(best)}</span><span><b>${esc(pairName(best))}</b><small>TVL ${usd(best.tvlUsd)} · range ±${w}%</small></span><span style="text-align:right"><b class="apr">${best.feeAprPct.toFixed(0)}%</b><small>fee APR</small></span>`;
  });
}

async function load() {
  try {
    const [a, t] = await Promise.all([api("/tools/list_lp_pools?sort=apr&limit=40"), api("/tools/list_lp_pools?sort=tvl&limit=60")]);
    byApr = a.pools.filter((p) => p.feeAprPct != null && p.tvlUsd > 20000); byTvl = t.pools;
    paintHero(); paintTape(); paintStrats();
    if ($(".statband").classList.contains("in")) paintStats();
  } catch { setTimeout(load, 8000); }
}
onView.set($(".statband"), () => paintStats()); io.observe($(".statband"));
load();
setInterval(() => { if (!document.hidden) load(); }, 60000);
