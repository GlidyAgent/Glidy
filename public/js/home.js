// Homepage: ambient motion, a live pool flown by the paper plane, a fee calculator, a live Checkpoint run and an agent
// conversation built from real tool results. Every number on this page comes from Robinhood Chain right now.
import { api, avatar, esc, signed, usd } from "./lib.js";

const $ = (s) => document.querySelector(s);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));
const fmt = (x) => (x == null ? "–" : x >= 1000 ? x.toLocaleString("en-US", { maximumFractionDigits: 2 }) : x >= 1 ? x.toFixed(4) : x.toPrecision(4));
const money = (x, d = 2) => (x == null ? "–" : "$" + x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const logos = (p) => avatar(p.base.symbol, p.base.address, p.base.image, { stock: p.base.stock }) + avatar(p.quote.symbol, p.quote.address, p.quote.image, { stock: p.quote.stock });
const pairName = (p) => `${p.base.symbol} / ${p.quote.symbol}`;
const hasWeth = (p) => [p.base.symbol, p.quote.symbol].includes("WETH");
/** a range width that fits today's move: calm pairs tight, wild ones wide */
const widthFor = (p) => { const m = Math.abs(p?.change24hPct || 0); return m < 1.5 ? 2 : m < 4 ? 5 : m < 9 ? 10 : m < 18 ? 20 : 50; };
/** random-walk estimate of days until price first leaves ±w, from today's move as the daily volatility */
const daysInRange = (w, move) => Math.max(0.2, Math.pow(w / Math.max(0.8, Math.abs(move || 0)), 2));

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
  document.querySelectorAll(".tilt").forEach((el) => {
    el.addEventListener("pointermove", (e) => { const r = el.getBoundingClientRect(); el.style.transform = `perspective(900px) rotateY(${((e.clientX - r.left) / r.width - 0.5) * 6}deg) rotateX(${-((e.clientY - r.top) / r.height - 0.5) * 6}deg) translateY(-4px)`; });
    el.addEventListener("pointerleave", () => (el.style.transform = ""));
  });
}

// reveal on scroll, and run a section's live part once when it comes into view
const onView = new Map();
const io = new IntersectionObserver((es) => es.forEach((e) => {
  if (!e.isIntersecting) return;
  e.target.classList.add("in");
  const fn = onView.get(e.target); if (fn) { onView.delete(e.target); fn(); }
  io.unobserve(e.target);
}), { threshold: 0.18 });
document.querySelectorAll(".rv").forEach((el) => io.observe(el));
const whenSeen = (el, fn) => { onView.set(el, fn); io.observe(el); };

// ---------- hero art: the price line, the range band, the plane, and fees popping out while it is in range ----------
const svg = $("#glideSvg"), pricePath = $("#pricePath"), plane = $("#plane"), trail = $("#trailPath"), feesG = $("#fees");
const BAND = [160, 360];
$("#heroBars").innerHTML = [40, 78, 120, 168, 200, 176, 132, 88, 52].map((h, i) => `<rect x="${166 + i * 21.4}" y="${290 - h}" width="15" height="${h}" rx="4" style="animation-delay:${i * 70}ms, ${1.2 + i * 0.2}s"/>`).join("");
function newPath() {
  // a walk that drifts through the band and sometimes out of it
  let y = 150 + (Math.random() - 0.5) * 60, d = `M0 ${y.toFixed(1)}`;
  const pts = [];
  for (let x = 40; x <= 520; x += 40) { y = Math.min(250, Math.max(40, y + (Math.random() - 0.5) * 90)); pts.push([x, y]); }
  for (let i = 0; i < pts.length; i++) { const [x, yy] = pts[i], px = x - 20; d += ` S${px.toFixed(0)} ${yy.toFixed(1)} ${x} ${yy.toFixed(1)}`; }
  pricePath.setAttribute("d", d);
  return pricePath.getTotalLength();
}
let pathLen = newPath(), t0 = performance.now(), lastFee = 0, feePerTick = 0.01, heroInRange = true;
function frame(now) {
  const dur = 9000, k = reduced ? 0.45 : (now - t0) / dur;
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

// ---------- live data ----------
let byApr = [], byTvl = [], hero = null;

function paintHero() {
  hero = byApr.find((p) => p.tvlUsd > 150000 && hasWeth(p)) || byApr.find((p) => p.tvlUsd > 50000) || byApr[0];
  if (!hero) return;
  $("#artLogos").innerHTML = logos(hero);
  $("#artName").textContent = pairName(hero);
  $("#artSub").textContent = `Uniswap v3 · ${hero.feePct}% fee · Robinhood Chain`;
  $("#artApr").textContent = `${hero.feeAprPct.toFixed(1)}%`;
  $("#artTvl").textContent = usd(hero.tvlUsd);
  $("#artVol").textContent = usd(hero.volume24hUsd);
  const perDay = (1000 * hero.feeAprPct) / 100 / 365;
  $("#artDay").textContent = money(perDay);
  feePerTick = perDay / 86400 * 600; // a fee pop roughly every few seconds of simulated time
  const w = widthFor(hero);
  api(`/tools/pool_state?pool=${hero.pool}`).then((s) => { $("#artLo").textContent = fmt(s.price * (1 - w / 100)); $("#artHi").textContent = fmt(s.price * (1 + w / 100)); }).catch(() => {});
  const top = byApr[0], mover = [...byTvl].filter((p) => p.tvlUsd > 100000 && Math.abs(p.change24hPct || 0) < 300).sort((a, b) => Math.abs(b.change24hPct || 0) - Math.abs(a.change24hPct || 0))[0];
  if (top) { const c = $("#fc1"); c.hidden = false; c.innerHTML = `<span class="tag pass">#1 fee APR</span><b>${esc(pairName(top))}</b><small><em class="up">${top.feeAprPct.toFixed(0)}% APR</em> · TVL ${usd(top.tvlUsd)}</small>`; }
  if (mover) { const c = $("#fc2"); c.hidden = false; c.innerHTML = `<span class="tag warn">${mover.change24hPct > 0 ? "▲" : "▼"} ${Math.abs(mover.change24hPct || 0).toFixed(1)}% today</span><b>${esc(pairName(mover))}</b><small>Glidy suggests a ±${widthFor(mover)}% range</small>`; }
}

function paintTape() {
  const items = byApr.slice(0, 18).map((p) => `<a class="tp" href="/app/#/pool?address=${esc(p.pool)}"><span class="pl">${logos(p)}</span><b>${esc(pairName(p))}</b><em class="apr">${p.feeAprPct.toFixed(0)}% APR</em>${signed(p.change24hPct, 1)}</a>`).join("");
  $("#tape").innerHTML = items + items;
}

function countUp(el, to, f) {
  if (reduced) { el.textContent = f(to); return; }
  const t0 = performance.now(), dur = 1600;
  const step = (now) => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = f(to * e); if (k < 1) requestAnimationFrame(step); };
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

// ---------- calculator ----------
const calc = { pool: null, amt: 1000, w: 10 };
const WIDTHS = [2, 5, 10, 20, 50];
function paintCalcPools() {
  const list = byApr.filter((p) => p.tvlUsd > 50000).slice(0, 12);
  if (!calc.pool) { calc.pool = hero || list[0]; calc.w = widthFor(calc.pool); }
  $("#calcPools").innerHTML = list.map((p) => `<button type="button" class="pp${p.pool === calc.pool?.pool ? " on" : ""}" data-p="${esc(p.pool)}"><span class="pl">${logos(p)}</span><span><b>${esc(pairName(p))}</b><small>${p.feeAprPct.toFixed(0)}% APR · ${usd(p.tvlUsd)}</small></span></button>`).join("");
  $("#calcPools").querySelectorAll(".pp").forEach((b) => (b.onclick = () => { calc.pool = list.find((p) => p.pool === b.dataset.p); calc.w = widthFor(calc.pool); paintCalcPools(); paintCalcW(); updCalc(); }));
}
function paintCalcW() {
  $("#calcW").innerHTML = WIDTHS.map((w) => `<button type="button" data-w="${w}" class="${w === calc.w ? "on" : ""}">±${w}%</button>`).join("");
  $("#calcW").querySelectorAll("button").forEach((b) => (b.onclick = () => { calc.w = Number(b.dataset.w); paintCalcW(); updCalc(); }));
}
function updCalc() {
  const p = calc.pool; if (!p) return;
  const year = (calc.amt * p.feeAprPct) / 100;
  $("#calcAmtV").textContent = money(calc.amt, 0);
  const s = $("#calcAmt"); s.style.setProperty("--fill", `${((calc.amt - s.min) / (s.max - s.min)) * 100}%`);
  $("#cYear").textContent = money(year, 0); $("#cDay").textContent = money(year / 365); $("#cMonth").textContent = money(year / 12, 0);
  $("#cApr").textContent = `${p.feeAprPct.toFixed(1)}%`;
  const days = daysInRange(calc.w, p.change24hPct);
  $("#cDays").textContent = days >= 365 ? "1y+" : days >= 1 ? `~${Math.round(days)}d` : `~${Math.round(days * 24)}h`;
  $("#cvIn").style.left = `${50 - calc.w}%`; $("#cvIn").style.width = `${2 * calc.w}%`;
  $("#cvLo").textContent = `−${calc.w}%`; $("#cvHi").textContent = `+${calc.w}%`;
  $("#calcGo").href = `/app/#/pool?address=${p.pool}&width=${calc.w}`;
  $("#calcGo").innerHTML = `Open ${esc(pairName(p))} <span class="arr">→</span>`;
}
$("#calcAmt").oninput = (e) => { calc.amt = Number(e.target.value); updCalc(); };
let wobble = 0;
setInterval(() => { if (document.hidden || !calc.pool) return; wobble += 0.4; $("#cvNow").style.left = `${50 + Math.sin(wobble) * calc.w * 0.45}%`; }, 900);

// ---------- product preview: $1,000 in the hero pool, fees ticking at its live APR ----------
let pvStart = 0;
function paintPreview() {
  if (!hero) return;
  $("#pvLogos").innerHTML = logos(hero); $("#pvName").textContent = pairName(hero);
  $("#pvSub").textContent = `${hero.feePct}% fee · range ±${widthFor(hero)}%`; $("#pvVal").textContent = "$1,000.00";
  $("#pvLo").textContent = `−${widthFor(hero)}%`; $("#pvHi").textContent = `+${widthFor(hero)}%`;
  if (pvStart) return;
  pvStart = performance.now();
  const perSec = (1000 * hero.feeAprPct) / 100 / 365 / 86400;
  const tick = (now) => { const s = (now - pvStart) / 1000; $("#pvFees").textContent = "$" + (perSec * s * 60).toFixed(4); $("#pvNow").style.left = `${50 + Math.sin(s / 2.2) * 22}%`; requestAnimationFrame(tick); };
  if (!reduced) requestAnimationFrame(tick);
}

// ---------- the Checkpoint, run live on the hero pool ----------
async function runCheckpoint() {
  const p = hero || byApr[0]; if (!p) return;
  const w = widthFor(p);
  $("#ckFor").innerHTML = `Live now: 0.05 ETH into <b>${esc(pairName(p))}</b>, range ±${w}%.`;
  let g;
  try { g = await api(`/tools/check_lp?${new URLSearchParams({ pool: p.pool, token: hasWeth(p) ? "ETH" : p.base.symbol, amount: hasWeth(p) ? "0.05" : "100", widthPct: String(w) })}`); }
  catch { $("#ckFor").textContent = "The Checkpoint is busy right now; open the app to run it."; return; }
  const lis = [...document.querySelectorAll("#checklist li")];
  for (const li of lis) {
    const c = g.checks.find((x) => x.id === li.dataset.id);
    await sleep(380);
    li.classList.add("on", c ? c.status : "pass");
    if (c) li.insertAdjacentHTML("beforeend", `<span class="live">${esc(c.detail)}</span>`);
  }
  $("#ckFor").innerHTML += ` Result: <b class="${g.status === "fail" ? "down" : "up"}">${esc(g.status.toUpperCase())}</b>.`;
}

// ---------- the agent: a real conversation built from live tool results ----------
const log = $("#awLog");
const add = (html, cls) => { const d = document.createElement("div"); d.className = cls; d.innerHTML = html; log.append(d); while (log.children.length > 14) log.firstChild.remove(); return d; };
async function type(text) {
  const el = $("#awTyping"); el.style.color = "var(--text)";
  for (let i = 1; i <= text.length; i++) { el.textContent = text.slice(0, i); await sleep(26); }
  await sleep(260); el.textContent = "Ask anything about your liquidity…"; el.style.color = "";
  add(esc(text), "bubble user");
}
async function tool(label, run) {
  const chip = add(`<span class="spin"></span>${esc(label)}`, "tool-chip");
  const t = performance.now(); const out = await run();
  chip.innerHTML = `<span class="ok">✓</span>${esc(label)} <span class="faint">${((performance.now() - t) / 1000).toFixed(1)}s</span>`;
  return out;
}
async function thinking(ms) { const d = add("<i></i><i></i><i></i>", "typing"); await sleep(ms); d.remove(); }

async function runAgent() {
  try {
    await type("what are the best pools to LP right now?");
    const r = await tool("list_lp_pools · ranking every Uniswap v3 pool", () => api("/tools/list_lp_pools?sort=apr&limit=8"));
    await thinking(700);
    const top = r.pools.filter((p) => p.tvlUsd > 50000).slice(0, 3);
    add(`Here are the top pools by fee income right now. I skip anything under $20K deep.<div class="mini-pools">${top.map((p, i) => `<div class="mp"><span class="pl">${logos(p)}</span><span><b>${i + 1}. ${esc(pairName(p))}</b><small>${p.feePct}% fee · TVL ${usd(p.tvlUsd)} · vol ${usd(p.volume24hUsd)}</small></span><b class="apr">${p.feeAprPct.toFixed(0)}%</b></div>`).join("")}</div>`, "bubble bot");
    await sleep(1400);
    const pick = top.find(hasWeth) || hero || top[0];
    const w = widthFor(pick);
    await type(`put 0.05 ETH into ${pick.base.symbol}/${pick.quote.symbol}, you pick the range`);
    const g = await tool(`check_lp · ${pairName(pick)} ±${w}%`, () => api(`/tools/check_lp?${new URLSearchParams({ pool: pick.pool, token: "ETH", amount: "0.05", widthPct: String(w) })}`));
    await thinking(800);
    const pl = g.plan;
    const days = daysInRange(w, pick.change24hPct);
    add(`${esc(pick.base.symbol)} moved ${Math.abs(pick.change24hPct || 0).toFixed(1)}% in the last 24h, so I'd use <b>±${w}%</b>: at today's pace price usually stays inside for ${days >= 1 ? `about ${Math.round(days)} days` : `about ${Math.round(days * 24)} hours`}. The Checkpoint says <b class="${g.status === "fail" ? "down" : "up"}">${esc(g.status.toUpperCase())}</b>.
      ${pl ? `<div class="mini-ticket"><div class="mt-h"><span>Ticket · add liquidity</span><span>Robinhood Chain</span></div><div class="mt-b">
        <div class="mt-legs">${avatar(pl.token0.symbol, pl.token0.address)}${esc(fmt(Number(pl.amount0)))} ${esc(pl.token0.symbol)} <span class="faint">+</span> ${avatar(pl.token1.symbol, pl.token1.address)}${esc(fmt(Number(pl.amount1)))} ${esc(pl.token1.symbol)}</div>
        <span class="faint">Range ${esc(fmt(pl.price.lower))} – ${esc(fmt(pl.price.upper))} ${esc(pl.price.unit)}</span>
        <div class="mt-f"><span class="faint">${g.checks.filter((c) => c.status === "pass").length} checks passed</span><span class="btn-mini solid">Sign in wallet</span></div></div></div>` : ""}`, "bubble bot");
    await sleep(1800);
    await type("and if price leaves my range?");
    await thinking(900);
    add(`Then the position stops earning, and I flag it on <b>My positions</b>. I'll prepare a rebalance: remove it, collect the fees, and add a fresh ±${w}% range around the new price. Two tickets, and you sign both. I never hold your keys.`, "bubble bot");
  } catch {
    add("The data source is busy right now. Open the app and ask me there.", "bubble bot");
  }
}

// ---------- strategies: the best live pool in each bucket ----------
const MAJORS = new Set(["WETH", "ETH", "USDG"]);
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

// ---------- load ----------
async function load() {
  try {
    const [a, t] = await Promise.all([api("/tools/list_lp_pools?sort=apr&limit=40"), api("/tools/list_lp_pools?sort=tvl&limit=60")]);
    byApr = a.pools.filter((p) => p.feeAprPct != null && p.tvlUsd > 20000); byTvl = t.pools;
    paintHero(); paintTape(); paintStrats(); paintCalcPools(); paintCalcW(); updCalc(); paintPreview();
    if ($(".statband").classList.contains("in")) paintStats();
    return true;
  } catch { setTimeout(load, 8000); return false; }
}
whenSeen($(".statband"), () => paintStats());
let firstLoad = load();
whenSeen($("#checklist"), async () => { await firstLoad; if (!byApr.length) await new Promise((r) => setTimeout(r, 4000)); runCheckpoint(); });
whenSeen($(".agent-win"), async () => { await firstLoad; runAgent(); });
setInterval(() => { if (!document.hidden) load(); }, 60000);
