// Glidy app: hash-routed views, LP pools and positions on Robinhood Chain, the agent drawer, and ticket signing in the
// user's own wallet.
import {
  ago, api, avatar, checkpointHtml, connectWallet, disconnectWallet, ensureChain, esc, fmtPrice, initTheme,
  sendTx, short, signed, state, toast, usd, waitReceipt,
} from "./lib.js";

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
let timers = []; // per-view refresh intervals, cleared on navigation
const every = (ms, fn) => { timers.push(setInterval(() => { if (!document.hidden) fn(); }, ms)); };

// ---------------- boot ----------------

async function boot() {
  initTheme($("#themeBtn"));
  const [health, chains, me] = await Promise.all([api("/health"), api("/chains"), api("/auth/me").catch(() => ({}))]);
  state.health = health; state.chains = chains; state.address = me.address || null;
  // The website is Robinhood Chain only. (The API still accepts base, arbitrum and ethereum for developers.)
  state.chain = "robinhood";
  if (health.mock) { const p = $("#modePill"); p.hidden = false; p.textContent = "demo data"; p.title = "GLIDY_MOCK=1: quotes and chain reads are simulated"; }
  $("#chatMode").textContent = health.llm ? "AI" : "command mode";

  renderWallet();
  $("#walletBtn").onclick = onWallet;
  $("#askBtn").onclick = () => openDrawer();
  $("#sideAsk").onclick = () => { document.body.classList.remove("nav-open"); openDrawer(); };
  sideBadges(); setInterval(() => !document.hidden && sideBadges(), 60000);
  $("#drawerClose").onclick = closeDrawer;
  $("#chatNew").onclick = welcome;
  $("#scrim").onclick = () => { closeDrawer(); document.body.classList.remove("nav-open"); };
  $("#menuBtn").onclick = () => { document.body.classList.toggle("nav-open"); $("#scrim").hidden = !document.body.classList.contains("nav-open"); };
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openDrawer(); }
    if (e.key === "Escape") closeDrawer();
  });
  $("#chatForm").onsubmit = (e) => { e.preventDefault(); sendChat(); };
  $("#chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  $("#chatInput").addEventListener("input", (e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(140, e.target.scrollHeight) + "px"; });
  window.ethereum?.on?.("accountsChanged", async (accs) => {
    if (state.address && accs[0]?.toLowerCase() !== state.address) { await disconnectWallet().catch(() => {}); renderWallet(); route(); toast("Wallet changed. Sign in again."); }
  });
  window.addEventListener("hashchange", route);
  tickBlock(); setInterval(() => !document.hidden && tickBlock(), 6000);
  route();
}

/** Live sidebar badges: the top fee APR right now, and the wallet's open positions (amber when one is out of range). */
async function sideBadges() {
  api("/tools/list_lp_pools?sort=apr&limit=1").then((r) => {
    const p = r.pools[0];
    if (p?.feeAprPct != null) { $("#bPools").textContent = `${p.feeAprPct.toFixed(0)}%`; $("#bPools").title = `Top fee APR now: ${p.name}`; }
  }).catch(() => {});
  const b = $("#bPos");
  if (!state.address) { b.hidden = true; return; }
  try {
    const r = await api("/tools/lp_positions");
    const open = r.positions.filter((x) => !x.closed), out = open.filter((x) => x.inRange === false).length;
    b.hidden = !open.length; b.classList.toggle("warn", out > 0);
    b.textContent = out ? `${out} out` : String(open.length);
    b.title = out ? `${out} out of range` : `${open.length} open`;
  } catch { b.hidden = true; }
}

async function tickBlock() {
  try {
    const s = await api("/tools/chain_status");
    $("#blockNum").textContent = "Robinhood Chain · live";
    $("#blockPill").title = `Live on Robinhood Chain. Latest block #${s.block.toLocaleString("en-US")}, ${s.ageSec}s ago, base fee ${s.baseFeeGwei?.toFixed(4)} gwei. Click to open it in the explorer.`;
    $("#blockPill").href = `https://robinhoodchain.blockscout.com/block/${s.block}`;
    $("#blockPill").classList.remove("offline");
  } catch { $("#blockNum").textContent = "Robinhood Chain · offline"; $("#blockPill").classList.add("offline"); }
}

function renderWallet() {
  const b = $("#walletBtn");
  b.innerHTML = state.address ? `${ident(state.address)}${esc(short(state.address))}` : "Connect wallet";
  const sw = $("#sideWallet");
  if (sw) sw.innerHTML = state.address ? `<div class="sw-row">${ident(state.address)}<div><b>${esc(short(state.address))}</b><small><i class="live-dot"></i> Robinhood Chain</small></div></div><button type="button" class="sw-out" id="swOut">Disconnect</button>` : "";
  $("#swOut")?.addEventListener("click", onWallet);
  b.classList.toggle("primary", !state.address);
  b.title = state.address ? "Signed in. Click to sign out." : "Connect and sign in with your wallet";
  document.body.classList.toggle("locked", !state.address);
}

async function onWallet() {
  try {
    if (state.address) { await disconnectWallet(); toast("Signed out"); }
    else { await connectWallet(); toast(`Signed in as ${short(state.address)}`); }
    renderWallet(); route(); sideBadges();
  } catch (e) { toast(e.message || String(e)); }
}

// ---------------- routing ----------------

// The whole app needs a connected wallet; the homepage at / stays public.
const OPEN_ROUTES = new Set();
const ROUTE_NAMES = { desk: "The desk", pools: "Pools", pool: "Pool", positions: "My positions", swap: "Swap", check: "Checkpoint", live: "Onchain live", new: "New pairs", stocks: "Stocks", token: "Token", portfolio: "Portfolio", limits: "Limits", journal: "Journal", api: "API & MCP", ask: "The agent" };

function gate(r) {
  const hasWallet = !!window.ethereum;
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  const dappUrl = location.host + location.pathname + location.hash;
  view.innerHTML = `
    <section class="gate">
      <div class="gate-card card">
        <img src="/img/glidy.svg" alt="" width="56" height="56" style="border-radius:14px">
        <span class="eyebrow">${esc(ROUTE_NAMES[r] || "Glidy")} is locked</span>
        <h1>Connect your wallet<br><em>to start gliding.</em></h1>
        <p>Signing in is a free signature over a one-time message. It cannot move funds, and Glidy never sees your keys.</p>
        <button class="btn primary" id="gateConnect" type="button" style="padding:14px 22px">${hasWallet ? "Connect wallet" : "Connect wallet"}</button>
        ${!hasWallet ? `<p class="muted" style="font-size:13.5px;margin:4px 0 0">No browser wallet found. ${mobile
          ? `Open Glidy in your wallet app: <a href="https://metamask.app.link/dapp/${esc(dappUrl)}" style="text-decoration:underline">MetaMask</a> · <a href="https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(location.href)}" style="text-decoration:underline">Coinbase Wallet</a>`
          : `Install <a href="https://metamask.io/download/" target="_blank" rel="noopener" style="text-decoration:underline">MetaMask</a> or <a href="https://rabby.io" target="_blank" rel="noopener" style="text-decoration:underline">Rabby</a>, then come back.`}</p>` : ""}
        <ul class="gate-list">
          <li>The best Uniswap v3 pools on Robinhood Chain, ranked by fee APR</li>
          <li>Add liquidity with a range picked for you, checked before you sign</li>
          <li>Your positions: in range or not, fees ready, one-click collect and rebalance</li>
          <li>Ask the agent; it writes tickets you sign</li>
        </ul>
      </div>
    </section>`;
  $("#gateConnect").onclick = onWallet;
}

const ROUTES = { desk, pools: poolsView, pool: poolView, positions: positionsView, swap, check, live, new: newPairs, stocks: stocksView, token: tokenView, portfolio, limits, journal, api: apiDocs };

function route() {
  timers.forEach(clearInterval); timers = [];
  document.body.classList.remove("nav-open"); $("#scrim").hidden = !$("#drawer").classList.contains("open");
  const [name, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const r = ROUTES[name] ? name : "desk";
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("on", a.dataset.route === r || (r === "token" && a.dataset.route === "live") || (r === "pool" && a.dataset.route === "pools")));
  if (!state.address && !OPEN_ROUTES.has(r)) gate(r);
  else ROUTES[r](new URLSearchParams(query));
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

const chainName = () => state.chains.find((c) => c.key === state.chain)?.name || state.chain;
const head = (title, sub, right = "") => `<div class="page-head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</div>${right}</div>`;
const errorBox = (e) => `<div class="empty">${esc(e.message || e)}</div>`;

// ---------------- pool tables ----------------

function poolRows(pools, { showAge = false } = {}) {
  if (!pools.length) return `<div class="empty">No pools right now.</div>`;
  return `<div class="table-wrap"><table><thead><tr>
    <th>Token</th><th class="num">Price</th><th class="num hide-sm">5m</th><th class="num">1h</th><th class="num">24h</th>
    <th class="num">Volume</th><th class="num hide-sm">Liquidity</th><th class="num hide-sm">${showAge ? "Age" : "FDV"}</th><th class="num hide-sm">Txns</th></tr></thead><tbody>
    ${pools.map((p) => `
    <tr class="clickable" data-token="${esc(p.token.address || "")}">
      <td><div class="token-cell">${avatar(p.token.symbol, p.token.address, p.token.image)}<div><b>${esc(p.token.symbol)}${p.token.stock ? ' <span class="tag neutral">stock</span>' : ""}</b><small>${esc(p.dex)}${p.token.name && p.token.name !== p.token.symbol ? ` · ${esc(p.token.name)}` : ""}</small></div></div></td>
      <td class="num">${fmtPrice(p.priceUsd)}</td>
      <td class="num hide-sm">${signed(p.change.m5)}</td><td class="num">${signed(p.change.h1)}</td><td class="num">${signed(p.change.h24)}</td>
      <td class="num">${usd(p.volume24hUsd)}</td><td class="num hide-sm">${usd(p.liquidityUsd)}</td>
      <td class="num hide-sm">${showAge ? ago(p.createdAt) : usd(p.fdvUsd)}</td>
      <td class="num hide-sm"><span class="up">${p.txns24h.buys ?? "–"}</span><span class="faint"> / </span><span class="down">${p.txns24h.sells ?? "–"}</span></td>
    </tr>`).join("")}</tbody></table></div>`;
}

function bindTokenRows(el) {
  el.querySelectorAll("tr[data-token]").forEach((tr) => tr.addEventListener("click", () => { if (tr.dataset.token) location.hash = `#/token?address=${tr.dataset.token}`; }));
}

async function loadPools(target, kind, limit, opts) {
  try {
    const r = await api(`/tools/onchain_pools?kind=${kind}&limit=${limit}`);
    target.innerHTML = poolRows(r.pools, opts) + (r.stale ? `<p class="muted" style="font-size:12px;margin:10px 0 0">Showing the last good copy: the data source is busy.</p>` : "");
    bindTokenRows(target);
    return r;
  } catch (e) { target.innerHTML = errorBox(e); }
}

// ---------------- views ----------------

// ---------------- liquidity ----------------

const pct = (n, d = 1) => (n == null ? "–" : `${n.toFixed(d)}%`);
const pair = (a, b) => `<span class="pair-logos">${avatar(a.symbol, a.address, a.image, { stock: a.stock })}${avatar(b.symbol, b.address, b.image, { stock: b.stock })}</span>`;
const fmtAmt = (x) => (x == null ? "–" : x >= 1000 ? x.toLocaleString("en-US", { maximumFractionDigits: 2 }) : x >= 1 ? x.toFixed(4) : x > 0 ? x.toPrecision(4) : "0");

// Strategy buckets: majors and stables (tight ranges), tokenized stocks (medium), coins (wide).
const MAJORS = new Set(["WETH", "ETH", "USDG"]);
const kindOf = (p) => (p.base.stock || p.quote.stock ? "stocks" : MAJORS.has(p.base.symbol) && MAJORS.has(p.quote.symbol) ? "calm" : "coins");
const STRATS = {
  calm: { name: "Calm", tag: "Majors & stables", w: 5, blurb: "WETH and USDG pairs. Deep pools, tight ranges, steady fees." },
  stocks: { name: "Stocks", tag: "Tokenized equities", w: 10, blurb: "NVDA, TSLA and friends, 24/7 on-chain. Earn fees on the trading." },
  coins: { name: "Degen", tag: "New coins", w: 50, blurb: "The hottest coins. Wild APRs, wide ranges, real risk. Checkpoint first." },
};
const wFor = (p) => { const m = Math.abs(p?.change24hPct || 0); return m < 1.5 ? 2 : m < 4 ? 5 : m < 9 ? 10 : m < 18 ? 20 : 50; };
const ident = (a) => { const h1 = parseInt(String(a).slice(2, 8), 16) % 360, h2 = parseInt(String(a).slice(8, 14), 16) % 360; return `<span class="ident" style="background:conic-gradient(from 40deg, hsl(${h1} 80% 62%), hsl(${h2} 85% 58%), hsl(${h1} 80% 62%))"></span>`; };

function lpPoolRows(list, { compact = false } = {}) {
  if (!list.length) return `<div class="empty">No pools match.</div>`;
  const max = Math.max(1, ...list.map((p) => p.feeAprPct || 0));
  return `<div class="table-wrap"><table class="pools-t"><thead><tr><th>Pool</th><th>Fee APR</th><th class="num">TVL</th>${compact ? "" : `<th class="num">Volume 24h</th>`}<th class="num hide-sm">24h</th><th class="num"></th></tr></thead><tbody>
    ${list.map((p) => `<tr class="clickable" data-pool="${esc(p.pool)}">
      <td><div class="token-cell">${pair(p.base, p.quote)}<div><b>${esc(p.base.symbol)} / ${esc(p.quote.symbol)}</b><small>Uniswap v3 · ${p.feePct ?? "–"}% fee · <span class="kind k-${kindOf(p)}">${STRATS[kindOf(p)].name}</span></small></div></div></td>
      <td class="apr-cell">${p.feeAprPct != null ? `<b class="apr">${pct(p.feeAprPct)}</b><span class="apr-bar"><i style="width:${Math.max(3, (p.feeAprPct / max) * 100)}%"></i></span>` : `<span class="tag ${p.aprFlag === "thin" ? "neutral" : "warn"}" title="${p.aprFlag === "thin" ? "Under $10K of liquidity: an APR here is not meaningful" : "Volume is far above the liquidity (bots or wash trading): the APR would be misleading"}">${p.aprFlag === "thin" ? "thin pool" : "APR unreliable"}</span>`}</td><td class="num">${usd(p.tvlUsd)}</td>${compact ? "" : `<td class="num">${usd(p.volume24hUsd)}</td>`}
      <td class="num hide-sm">${signed(p.change24hPct)}</td>
      <td class="num"><a class="btn sm primary" href="#/pool?address=${esc(p.pool)}" onclick="event.stopPropagation()">Add</a></td></tr>`).join("")}</tbody></table></div>`;
}
function bindPoolRows(el) {
  el.querySelectorAll("tr[data-pool]").forEach((tr) => tr.addEventListener("click", () => (location.hash = `#/pool?address=${tr.dataset.pool}`)));
}

function desk() {
  const hour = new Date().getHours();
  const kpi = (id, k, icon) => `<div class="card kpi" id="${id}"><div class="kpi-i">${icon}</div><div class="k">${k}</div><div class="v"><div class="skeleton" style="width:60%;height:24px"></div></div><div class="s">&nbsp;</div></div>`;
  view.innerHTML = `
    <section class="welcome card">
      <div class="wl-id">${ident(state.address)}<div><span class="eyebrow">${hour < 12 ? "gm" : hour < 18 ? "Good afternoon" : "Good evening"}</span><h1>${esc(short(state.address))}</h1><small class="muted">Robinhood Chain · <span id="wlBlock">live</span></small></div></div>
      <div class="wl-act"><button class="btn primary" data-ask="">✈ Ask Glidy</button><a class="btn" href="#/pools">+ New position</a></div>
      <div class="wl-glow" aria-hidden="true"></div>
    </section>
    <div class="kpis">
      ${kpi("kWallet", "Wallet value", "◎")}${kpi("kLiq", "In liquidity", "≋")}${kpi("kFees", "Fees ready", "✦")}${kpi("kRange", "In range", "◉")}
    </div>
    <div class="grid">
      <div class="card span-7">
        <div class="panel-head"><span class="panel-title">✈ Glidy suggests</span><span class="muted" style="font-size:12px">from your wallet and positions, live</span></div>
        <div id="insights" class="insights"><div class="skeleton"></div><div class="skeleton" style="margin-top:8px"></div></div>
      </div>
      <div class="card span-5">
        <div class="panel-head"><span class="panel-title">Your wallet</span><a class="muted" href="#/portfolio" style="font-size:13px">All →</a></div>
        <div id="wallet"><div class="skeleton"></div></div>
      </div>
    </div>
    <div class="panel-head" style="margin:26px 0 12px"><span class="panel-title" style="font-size:13px">Strategies · best pool for each, live</span><a class="muted" href="#/pools" style="font-size:13px">All pools →</a></div>
    <div class="strats" id="strats">${Object.keys(STRATS).map(() => `<div class="card strat"><div class="skeleton"></div></div>`).join("")}</div>
    <div class="grid" style="margin-top:18px">
      <div class="card span-8">
        <div class="panel-head"><span class="panel-title"><i class="live-dot"></i>&nbsp; Top pools by fee APR</span><a class="muted" href="#/pools" style="font-size:13px">All →</a></div>
        <div id="deskPools"><div class="skeleton"></div></div>
      </div>
      <div class="card span-4">
        <div class="panel-head"><span class="panel-title">Your positions</span><a class="muted" href="#/positions" style="font-size:13px">All →</a></div>
        <div id="deskPos"><div class="skeleton"></div></div>
      </div>
    </div>`;
  view.querySelectorAll("[data-ask]").forEach((b) => (b.onclick = () => openDrawer(b.dataset.ask)));
  api("/tools/chain_status").then((s) => ($("#wlBlock").textContent = `block #${s.block.toLocaleString("en-US")}`)).catch(() => {});
  const setK = (id, v, s, cls = "") => { const el = $("#" + id); if (!el) return; el.querySelector(".v").innerHTML = `<span class="${cls}">${v}</span>`; el.querySelector(".s").innerHTML = s; };

  let pools = [], posR = null, pf = null;
  const insights = () => {
    if (!posR || !pf || !pools.length) return;
    const tips = [];
    const tip = (kind, icon, title, body, btn) => tips.push(`<div class="ins ins-${kind}"><span class="ins-i">${icon}</span><div><b>${title}</b><small>${body}</small></div>${btn || ""}</div>`);
    for (const p of posR.positions.filter((x) => !x.closed && x.inRange === false)) tip("warn", "!", `#${esc(p.tokenId)} ${esc(p.token0.symbol)}/${esc(p.token1.symbol)} is out of range`, `Not earning fees right now. Move it back around the price.`, `<button class="btn sm primary" data-ask="rebalance ${esc(p.tokenId)}">Rebalance</button>`);
    for (const p of posR.positions.filter((x) => (x.feesUsd || 0) >= 0.5).slice(0, 3)) tip("good", "$", `${usd(p.feesUsd)} in fees ready on #${esc(p.tokenId)}`, `${esc(p.token0.symbol)}/${esc(p.token1.symbol)} · collect any time, your liquidity stays.`, `<button class="btn sm primary" data-ask="collect ${esc(p.tokenId)}">Collect</button>`);
    for (const p of posR.positions.filter((x) => !x.closed && x.inRange && x.price?.now)) {
      const k = (p.price.now - p.price.lower) / (p.price.upper - p.price.lower);
      if (k < 0.1 || k > 0.9) tip("info", "↔", `#${esc(p.tokenId)} is close to the edge of its range`, `Price is ${k < 0.1 ? "near the lower" : "near the upper"} end. Glidy will flag it if it leaves.`, `<a class="btn sm" href="#/positions">View</a>`);
    }
    const eth = pf.holdings.find((h) => h.symbol === "ETH");
    const calm = pools.filter((p) => kindOf(p) === "calm" && p.tvlUsd > 100000).sort((a, b) => b.feeAprPct - a.feeAprPct)[0];
    if (eth && eth.valueUsd > 5 && calm) tip("idea", "✦", `${fmtAmt(eth.amount)} ETH is sitting idle`, `${esc(calm.base.symbol)}/${esc(calm.quote.symbol)} pays ~${pct(calm.feeAprPct, 0)} APR right now. Put half to work?`, `<a class="btn sm primary" href="#/pool?address=${esc(calm.pool)}&token=ETH&amount=${(eth.amount / 2).toFixed(4)}&width=${wFor(calm)}">Add</a>`);
    for (const h of pf.holdings.filter((x) => x.stock && x.valueUsd > 5).slice(0, 2)) {
      const sp = pools.filter((p) => [p.base.symbol, p.quote.symbol].includes(h.symbol)).sort((a, b) => b.feeAprPct - a.feeAprPct)[0];
      if (sp) tip("idea", "↗", `Your ${esc(h.symbol)} could earn fees`, `${esc(sp.base.symbol)}/${esc(sp.quote.symbol)} pays ~${pct(sp.feeAprPct, 0)} APR. Provide liquidity with it.`, `<a class="btn sm primary" href="#/pool?address=${esc(sp.pool)}&token=${esc(h.symbol)}&width=${wFor(sp)}">Add</a>`);
    }
    if (!posR.positions.length && !tips.length) tip("idea", "✈", "Start with a Calm position", calm ? `${esc(calm.base.symbol)}/${esc(calm.quote.symbol)}: ~${pct(calm.feeAprPct, 0)} APR, ${usd(calm.tvlUsd)} deep. Top up ETH and add.` : "Pick a deep WETH/USDG pool first.", calm ? `<a class="btn sm primary" href="#/pool?address=${esc(calm.pool)}&width=${wFor(calm)}">Start</a>` : "");
    if (!tips.length) tip("good", "✓", "All positions in range", "Nothing to do. Glidy keeps watching.", "");
    $("#insights").innerHTML = tips.slice(0, 5).join("");
    $("#insights").querySelectorAll("[data-ask]").forEach((b) => (b.onclick = () => openDrawer(b.dataset.ask)));
  };
  const loadPools = async () => {
    try {
      const r = await api("/tools/list_lp_pools?sort=apr&limit=60");
      pools = r.pools.filter((p) => p.feeAprPct != null);
      $("#deskPools").innerHTML = lpPoolRows(pools.filter((p) => p.tvlUsd > 20000).slice(0, 7), { compact: true }); bindPoolRows($("#deskPools"));
      $("#strats").innerHTML = Object.entries(STRATS).map(([k, s]) => {
        const best = pools.filter((p) => kindOf(p) === k && p.tvlUsd > (k === "coins" ? 30000 : 50000)).sort((a, b) => b.feeAprPct - a.feeAprPct)[0];
        return `<a class="card strat s-${k}" href="${best ? `#/pool?address=${esc(best.pool)}&width=${Math.max(s.w, wFor(best))}` : "#/pools"}">
          <div class="row between"><span class="st-kicker">Strategy</span><span class="tag neutral">${esc(s.tag)}</span></div>
          <h3>${esc(s.name)}</h3><p>${esc(s.blurb)}</p>
          ${best ? `<div class="st-best">${pair(best.base, best.quote)}<span><b>${esc(best.base.symbol)}/${esc(best.quote.symbol)}</b><small>TVL ${usd(best.tvlUsd)} · ±${Math.max(s.w, wFor(best))}%</small></span><b class="apr">${pct(best.feeAprPct, 0)}</b></div>` : `<div class="muted">No pool right now</div>`}
          <span class="st-go">Start ${esc(s.name)} →</span></a>`;
      }).join("");
      insights();
    } catch (e) { $("#deskPools").innerHTML = errorBox(e); }
  };
  const mine = async () => {
    try {
      const [r, p] = await Promise.all([api("/tools/lp_positions"), api("/tools/get_portfolio").catch(() => ({ holdings: [], totalUsd: 0 }))]);
      posR = r; pf = p;
      const open = r.positions.filter((x) => !x.closed);
      const val = open.reduce((s, x) => s + (x.valueUsd || 0), 0), fees = r.positions.reduce((s, x) => s + (x.feesUsd || 0), 0);
      setK("kWallet", usd(p.totalUsd), `${p.holdings.length} asset${p.holdings.length === 1 ? "" : "s"} on Robinhood Chain`);
      setK("kLiq", usd(val), `${open.length} open position${open.length === 1 ? "" : "s"}`);
      setK("kFees", usd(fees), fees > 0 ? "ready to collect" : "nothing yet", "up");
      setK("kRange", open.length ? `${open.filter((x) => x.inRange).length}/${open.length}` : "–", open.length ? "positions earning now" : "no open positions");
      $("#wallet").innerHTML = p.holdings.length ? p.holdings.slice(0, 5).map((h) => `<div class="wl-row"><span class="token-cell">${avatar(h.symbol, h.address, null, { stock: h.stock })}<span><b>${esc(h.symbol)}</b><small>${fmtAmt(h.amount)}</small></span></span><span class="num">${usd(h.valueUsd)}</span></div>`).join("")
        : `<div class="empty" style="padding:18px">No ETH, USDG or stocks yet. Fund this wallet on Robinhood Chain to start.</div>`;
      $("#deskPos").innerHTML = r.positions.length ? r.positions.slice(0, 5).map((x) => `<a class="row between pos-mini" href="#/positions"><span class="token-cell">${pair(x.token0, x.token1)}<span><b>${esc(x.token0.symbol)}/${esc(x.token1.symbol)}</b><small>#${esc(x.tokenId)} · ${x.feePct}%</small></span></span><span style="text-align:right">${rangeTag(x)}<br><small class="muted">${usd(x.valueUsd)}</small></span></a>`).join("")
        : `<div class="empty" style="padding:18px">No positions yet.<br><a class="btn sm primary" href="#/pools" style="margin-top:10px">Pick a pool</a></div>`;
      insights();
    } catch (e) { $("#insights").innerHTML = errorBox(e); }
  };
  loadPools(); mine();
  every(60000, loadPools); every(30000, mine);
}

const rangeTag = (p) => (p.closed ? `<span class="tag neutral">closed</span>` : p.inRange ? `<span class="tag pass">in range</span>` : `<span class="tag warn">out of range</span>`);

function poolsView(q) {
  const sort = ["apr", "tvl", "volume"].includes(q.get("sort")) ? q.get("sort") : "apr";
  view.innerHTML = head(`Pools <em>for LPs</em>`, "Every Uniswap v3 pool on Robinhood Chain, ranked for liquidity providers. Fee APR is estimated from 24h volume for full-range liquidity; a tighter range earns more while in range.",
    `<div class="row"><span class="block-pill"><i class="live-dot"></i><span id="poolUpd">live</span></span><div class="tabs" id="sortTabs">${[["apr", "Fee APR"], ["tvl", "TVL"], ["volume", "Volume"]].map(([k, l]) => `<button data-k="${k}" class="${k === sort ? "on" : ""}">${l}</button>`).join("")}</div></div>`)
    + `<div class="card"><div class="row between" style="margin-bottom:14px;gap:10px;flex-wrap:wrap"><div class="kind-tabs" id="kindTabs">${[["all", "All"], ["calm", "Calm"], ["stocks", "Stocks"], ["coins", "Degen"]].map(([k, l]) => `<button data-k="${k}" class="${k === "all" ? "on" : ""}">${l}</button>`).join("")}</div><input id="poolFilter" placeholder="Search WETH, NVDA, USDG…" style="max-width:240px"><span class="muted" id="poolCount" style="font-size:13px"></span></div><div id="poolTable"><div class="skeleton"></div></div></div>`;
  $("#sortTabs").onclick = (e) => { const b = e.target.closest("button"); if (b) location.hash = `#/pools?sort=${b.dataset.k}`; };
  let rows = [], kind = "all";
  $("#kindTabs").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; kind = b.dataset.k; $("#kindTabs").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); render(); };
  const render = () => {
    const f = $("#poolFilter").value.trim().toLowerCase();
    const list = rows.filter((p) => (kind === "all" || kindOf(p) === kind) && (!f || p.name.toLowerCase().includes(f) || [p.base, p.quote].some((t) => (t.name || "").toLowerCase().includes(f))));
    $("#poolCount").textContent = `${list.length} pools`;
    $("#poolTable").innerHTML = lpPoolRows(list); bindPoolRows($("#poolTable"));
  };
  const load = async () => {
    try { const r = await api(`/tools/list_lp_pools?sort=${sort}&limit=60`); rows = r.pools; render(); $("#poolUpd").textContent = `updated ${new Date(r.updatedAt).toLocaleTimeString()}`; }
    catch (e) { $("#poolTable").innerHTML = errorBox(e); }
  };
  $("#poolFilter").oninput = render;
  load(); every(60000, load);
}

async function poolView(q) {
  const address = q.get("address") || "";
  view.innerHTML = `<div id="pHead"><div class="skeleton" style="width:260px;height:34px"></div></div>
    <div class="grid" style="margin-top:22px">
      <form class="card span-5 stack" id="addForm" autocomplete="off">
        <div class="panel-head" style="margin:0"><span class="panel-title">Add liquidity</span><span class="muted" style="font-size:12px">Uniswap v3</span></div>
        <div class="field"><label for="aAmt">You deposit</label><div class="leg-row"><input class="amt" id="aAmt" inputmode="decimal" value="${esc(q.get("amount") || "0.01")}" required aria-label="Amount"><div class="seg" id="aSide"></div></div></div>
        <div class="field"><label>Range around the price</label><div class="seg" id="aWidth">${[2, 5, 10, 20, 50].map((w) => `<button type="button" data-w="${w}" class="${w === Number(q.get("width") || 10) ? "on" : ""}">±${w}%</button>`).join("")}</div>
          <small class="muted">Tighter earns more fees while price stays inside; wider stays in range longer. Volatile coins want wider.</small></div>
        <div class="range-viz" id="aViz"></div>
        <button class="btn primary block" type="submit" style="padding:14px">Run Checkpoint & make ticket</button>
      </form>
      <div class="span-7 stack" id="addOut"><div class="card empty" style="border-style:dashed">Pick an amount and a range. Glidy sizes the other token, checks the pool and makes a ticket. Nothing is sent until you sign.</div></div>
    </div>`;
  let st, side, width = Number(q.get("width") || 10);
  try {
    st = await api(`/tools/pool_state?pool=${encodeURIComponent(address)}`);
    const listed = (await api("/tools/list_lp_pools?sort=tvl&limit=60").catch(() => ({ pools: [] }))).pools.find((p) => p.pool.toLowerCase() === address.toLowerCase());
    const t0 = { ...st.token0, image: listed && listed.base.address?.toLowerCase() === st.token0.address.toLowerCase() ? listed.base.image : listed?.quote.image };
    const t1 = { ...st.token1, image: listed && listed.base.address?.toLowerCase() === st.token1.address.toLowerCase() ? listed.base.image : listed?.quote.image };
    $("#pHead").innerHTML = `<div class="page-head" style="margin:0"><div class="token-hero">${pair(t0, t1)}<div><h1>${esc(st.token0.symbol)} / ${esc(st.token1.symbol)}</h1><span class="muted">Uniswap v3 · ${(st.fee / 10000).toFixed(2)}% fee · <span class="mono">${esc(short(st.pool))}</span>${st.official ? "" : ' · <span class="tag fail">not official</span>'}</span></div></div>
      <div style="text-align:right"><div class="price-big">${fmtAmt(st.price)}</div><div class="muted" style="font-size:13px">${esc(st.token1.symbol)} per ${esc(st.token0.symbol)}</div></div></div>
      ${listed ? `<div class="stats" style="margin-top:20px">${[["Fee APR", `<span class="apr">${pct(listed.feeAprPct)}</span>`, "full range, from 24h volume"], ["TVL", usd(listed.tvlUsd), "in the pool"], ["Volume 24h", usd(listed.volume24hUsd), `${listed.txns24h.toLocaleString("en-US")} swaps`], ["24h", signed(listed.change24hPct), "price change"]].map(([k, v, s]) => `<div class="card stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("")}</div>` : ""}`;
    const sides = [st.token0, st.token1].map((t) => (t.symbol === "WETH" ? "ETH" : t.symbol));
    side = sides.includes(q.get("token")) ? q.get("token") : sides.includes("ETH") ? "ETH" : sides[0];
    $("#aSide").innerHTML = sides.map((s) => `<button type="button" data-s="${esc(s)}" class="${s === side ? "on" : ""}">${esc(s)}</button>`).join("");
  } catch (e) { $("#pHead").innerHTML = errorBox(e); return; }
  const viz = () => {
    const lo = st.price * (1 - width / 100), hi = st.price * (1 + width / 100);
    $("#aViz").innerHTML = `<div class="rv-bar"><span class="rv-in" style="left:${50 - width}%;width:${2 * width}%"></span><i class="rv-now"></i></div><div class="row between mono" style="font-size:12px"><span>${fmtAmt(lo)}</span><span class="muted">now ${fmtAmt(st.price)}</span><span>${fmtAmt(hi)}</span></div>`;
  };
  viz();
  $("#aSide").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; side = b.dataset.s; $("#aSide").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); };
  $("#aWidth").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; width = Number(b.dataset.w); $("#aWidth").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); viz(); };
  $("#addForm").onsubmit = async (e) => {
    e.preventDefault();
    const out = $("#addOut");
    out.innerHTML = `<div class="card"><span class="spinner"></span>&nbsp; Sizing the position and running the Checkpoint…</div>`;
    const args = { action: "lp_add", pool: st.pool, token: side, amount: $("#aAmt").value.trim(), widthPct: width };
    try {
      const t = await api("/lp/prepare", { method: "POST", body: args });
      out.innerHTML = ""; out.append(ticketCard(t));
    } catch (err) { out.innerHTML = `<div class="card"><div class="verdict fail"><span class="stamp">ERROR</span><span>${esc(err.message)}</span></div></div>`; }
  };
}

async function positionsView() {
  view.innerHTML = head(`My <em>positions</em>`, `Your Uniswap v3 liquidity on Robinhood Chain, read live from the chain for <span class="mono">${esc(short(state.address))}</span>.`, `<a class="btn primary" href="#/pools">+ New position</a>`)
    + `<div id="posStats"></div><div id="posList"><div class="card"><span class="spinner"></span>&nbsp; Reading your positions…</div></div><div id="posOut" class="stack" style="margin-top:16px"></div>`;
  const load = async () => {
    try {
      const r = await api("/tools/lp_positions");
      const open = r.positions.filter((p) => !p.closed);
      const val = open.reduce((s, p) => s + (p.valueUsd || 0), 0), fees = r.positions.reduce((s, p) => s + (p.feesUsd || 0), 0);
      $("#posStats").innerHTML = `<div class="stats">${[["Liquidity", usd(val), `${open.length} open position${open.length === 1 ? "" : "s"}`], ["Fees ready", `<span class="up">${usd(fees)}</span>`, "uncollected"], ["In range", `${open.filter((p) => p.inRange).length}/${open.length}`, "earning now"], ["NFTs", String(r.total), "Uniswap v3 positions"]].map(([k, v, s]) => `<div class="card stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("")}</div>`;
      if (!r.positions.length) { $("#posList").innerHTML = `<div class="card empty">No Uniswap v3 positions in this wallet on Robinhood Chain yet. <a href="#/pools" style="text-decoration:underline">Find a pool</a>.</div>`; return; }
      $("#posList").innerHTML = `<div class="pos-grid">${r.positions.map((p) => {
        const span = p.price.upper - p.price.lower, at = p.price.now == null ? 50 : Math.max(-4, Math.min(104, ((p.price.now - p.price.lower) / span) * 100));
        return `<div class="card pos">
          <div class="row between"><div class="token-cell">${pair(p.token0, p.token1)}<div><b>${esc(p.token0.symbol)} / ${esc(p.token1.symbol)}</b><small>#${esc(p.tokenId)} · ${p.feePct}% fee</small></div></div>${rangeTag(p)}</div>
          <div class="rv-bar" style="margin:16px 0 6px"><span class="rv-in" style="left:0;width:100%"></span><i class="rv-now" style="left:${at}%"></i></div>
          <div class="row between mono" style="font-size:12px"><span>${fmtAmt(p.price.lower)}</span><span class="muted">now ${fmtAmt(p.price.now)}</span><span>${fmtAmt(p.price.upper)}</span></div>
          <dl class="kv" style="margin-top:12px"><dt>Liquidity</dt><dd>${fmtAmt(p.amount0)} ${esc(p.token0.symbol)} + ${fmtAmt(p.amount1)} ${esc(p.token1.symbol)}<br><small class="muted">${usd(p.valueUsd)}</small></dd>
            <dt>Fees ready</dt><dd class="up">${fmtAmt(p.fees0)} ${esc(p.token0.symbol)} + ${fmtAmt(p.fees1)} ${esc(p.token1.symbol)}<br><small class="muted">${usd(p.feesUsd)}</small></dd></dl>
          <div class="row" style="margin-top:12px">
            <button class="btn sm primary" data-act="lp_collect" data-id="${esc(p.tokenId)}" ${p.fees0 + p.fees1 > 0 ? "" : "disabled"}>Collect fees</button>
            ${p.closed ? "" : `<button class="btn sm" data-act="lp_remove" data-id="${esc(p.tokenId)}">Remove</button>`}
            ${p.closed || p.inRange ? "" : `<button class="btn sm" data-act="rebalance" data-id="${esc(p.tokenId)}" data-pool="${esc(p.pool)}">Rebalance</button>`}
          </div></div>`;
      }).join("")}</div><p class="muted" style="font-size:12.5px;margin:12px 0 0">Values use GeckoTerminal prices. Rebalance = remove this position, then add a new range around the current price.</p>`;
      $("#posList").querySelectorAll("[data-act]").forEach((b) => (b.onclick = async () => {
        const act = b.dataset.act === "rebalance" ? "lp_remove" : b.dataset.act;
        const out = $("#posOut");
        out.innerHTML = `<div class="card"><span class="spinner"></span>&nbsp; Preparing…</div>`;
        try {
          const t = await api("/lp/prepare", { method: "POST", body: { action: act, tokenId: b.dataset.id } });
          out.innerHTML = ""; out.append(ticketCard(t));
          if (b.dataset.act === "rebalance" && t.ok) out.insertAdjacentHTML("beforeend", `<div class="card">Step 2 after this confirms: <a class="btn sm primary" href="#/pool?address=${esc(b.dataset.pool)}">Add a new range around the price →</a></div>`);
          out.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (e) { out.innerHTML = errorBox(e); }
      }));
    } catch (e) { $("#posList").innerHTML = errorBox(e); }
  };
  load();
}

function live(q) {
  const kind = ["trending", "top", "new"].includes(q.get("kind")) ? q.get("kind") : "trending";
  view.innerHTML = head(`Onchain <em>live</em>`, "Every pool on Robinhood Chain, straight from the chain's DEXes: Uniswap v3/v4, Pons, Long, Bankr, Virtuals and more. Refreshes on its own.",
    `<div class="row"><span class="block-pill"><i class="live-dot"></i><span id="liveUpd">live</span></span><div class="tabs" id="kindTabs">${[["trending", "Trending"], ["top", "Top volume"], ["new", "New pairs"]].map(([k, l]) => `<button data-k="${k}" class="${k === kind ? "on" : ""}">${l}</button>`).join("")}</div></div>`)
    + `<div class="card"><div id="liveTable"><div class="skeleton"></div></div></div>`;
  $("#kindTabs").onclick = (e) => { const b = e.target.closest("button"); if (b) location.hash = `#/live?kind=${b.dataset.k}`; };
  const load = async () => { const r = await loadPools($("#liveTable"), kind, 30, { showAge: kind === "new" }); if (r) $("#liveUpd").textContent = `updated ${new Date(r.updatedAt).toLocaleTimeString()}`; };
  load(); every(kind === "new" ? 20000 : 30000, load);
}

function newPairs() {
  view.innerHTML = head(`New <em>pairs</em>`, "The newest pools on Robinhood Chain, seconds after they appear. Run the Checkpoint before you touch any of them.",
    `<span class="block-pill"><i class="live-dot"></i><span id="newUpd">live</span></span>`)
    + `<div class="card"><div id="newTable"><div class="skeleton"></div></div></div>`;
  const load = async () => { const r = await loadPools($("#newTable"), "new", 30, { showAge: true }); if (r) $("#newUpd").textContent = `updated ${new Date(r.updatedAt).toLocaleTimeString()}`; };
  load(); every(20000, load);
}

function stocksView() {
  view.innerHTML = head(`Tokenized <em>stocks</em>`, "Stocks and ETFs on Robinhood Chain with prices from their on-chain pools. Buy any of them with ETH or USDG.")
    + `<div class="card"><div class="row between" style="margin-bottom:12px"><input id="stockFilter" placeholder="Filter: NVDA, Tesla, ETF…" style="max-width:280px"><span class="muted" id="stockCount" style="font-size:13px"></span></div><div id="stockTable"><div class="skeleton"></div></div></div>`;
  // Names and logos are known up front; prices fill in when they arrive.
  let rows = (state.chains.find((c) => c.key === "robinhood")?.stocks || []).map((s) => ({ ...s, priceUsd: null, change24hPct: null, volume24hUsd: null }));
  const render = () => {
    const f = $("#stockFilter").value.trim().toLowerCase();
    const list = rows.filter((s) => !f || s.symbol.toLowerCase().includes(f) || s.name.toLowerCase().includes(f));
    $("#stockCount").textContent = `${list.length} of ${rows.length}`;
    $("#stockTable").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Stock</th><th class="num">Price</th><th class="num">24h</th><th class="num">Volume</th><th class="num"></th></tr></thead><tbody>${list.map((s) => `
      <tr class="clickable" data-token="${esc(s.address)}"><td><div class="token-cell">${avatar(s.symbol, s.address)}<div><b>${esc(s.symbol)}</b><small>${esc(s.name)}</small></div></div></td>
      <td class="num">${fmtPrice(s.priceUsd)}</td><td class="num">${signed(s.change24hPct)}</td><td class="num">${usd(s.volume24hUsd)}</td>
      <td class="num"><a class="btn sm" href="#/swap?in=ETH&out=${esc(s.symbol)}" onclick="event.stopPropagation()">Buy</a></td></tr>`).join("")}</tbody></table></div>`;
    bindTokenRows($("#stockTable"));
  };
  const load = async () => {
    try { const r = await api("/tools/stock_prices"); rows = r.stocks.sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0)); render(); }
    catch { setTimeout(() => { if (location.hash.startsWith("#/stocks")) load(); }, 15000); }
  };
  if (rows.length) render();
  $("#stockFilter").oninput = render;
  load(); every(60000, load);
}

async function tokenView(q) {
  const address = q.get("address") || "";
  view.innerHTML = `<div id="tokHead"><div class="skeleton" style="width:240px;height:34px"></div></div>
    <div class="grid" style="margin-top:22px">
      <div class="span-7 stack"><div class="card"><div class="panel-head"><span class="panel-title">Pools</span></div><div id="tokPools"><div class="skeleton"></div></div></div></div>
      <div class="span-5 stack"><div class="card"><div class="panel-head"><span class="panel-title">Checkpoint</span><span class="muted" style="font-size:12px">test buy & sell from ETH</span></div><div id="tokCheck"><span class="spinner"></span> Checking…</div></div></div>
    </div>`;
  try {
    const t = await api(`/tools/onchain_token?address=${encodeURIComponent(address)}`);
    const m = t.main;
    $("#tokHead").innerHTML = `<div class="page-head" style="margin:0"><div class="token-hero">${avatar(t.token?.symbol, address, t.token?.image)}<div><h1>${esc(t.token?.symbol || short(address))}</h1><span class="muted">${esc(t.token?.name || "")} · <span class="mono">${esc(short(address))}</span></span></div></div>
      <div class="row">${m ? `<div style="text-align:right"><div class="price-big">${fmtPrice(m.priceUsd)}</div><div>${signed(m.change.h24)} <span class="muted">24h</span></div></div>` : ""}
      <a class="btn primary" href="#/swap?in=ETH&out=${esc(address)}">Swap</a><a class="btn ghost" href="${esc(t.explorer)}" target="_blank" rel="noopener">Explorer ↗</a></div></div>
      ${t.totals ? `<div class="stats" style="margin-top:20px">${[["Volume 24h", usd(t.totals.volume24hUsd), `across ${t.totals.pools} pool${t.totals.pools > 1 ? "s" : ""}`], ["Liquidity", usd(t.totals.liquidityUsd), "all pools"], ["FDV", usd(m.fdvUsd), m.marketCapUsd ? `mcap ${usd(m.marketCapUsd)}` : ""], ["Txns 24h", `<span class="up">${t.totals.buys24h.toLocaleString("en-US")}</span><span class="faint"> / </span><span class="down">${t.totals.sells24h.toLocaleString("en-US")}</span>`, "buys / sells"]].map(([k, v, s]) => `<div class="card stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("")}</div>` : ""}`;
    $("#tokPools").innerHTML = t.pools.length ? poolRows(t.pools) : `<div class="empty">No pools found for this token.</div>`;
  } catch (e) { $("#tokHead").innerHTML = errorBox(e); $("#tokPools").innerHTML = ""; }
  try {
    const r = await api(`/tools/check_token?${new URLSearchParams({ chain: "robinhood", address })}`);
    $("#tokCheck").innerHTML = checkpointHtml(r) + (r.health?.flags?.length ? `<div style="margin-top:14px">${r.health.flags.map((f) => `<div style="padding:4px 0"><span class="tag ${f.severity === "info" ? "info" : f.severity}">${esc(f.severity)}</span> ${esc(f.text)}</div>`).join("")}</div>` : "");
  } catch (e) { $("#tokCheck").innerHTML = errorBox(e); }
}

function swap(q) {
  const chain = state.chains.find((c) => c.key === "robinhood");
  view.innerHTML = head(`Swap`, `On Robinhood Chain. Routes from KyberSwap; the ticket is re-checked on the live pool right before you sign.`)
    + `<div class="grid">
      <form class="card span-5 swap-card" id="swapForm" autocomplete="off">
        <div class="leg"><label for="sAmt">You pay</label><div class="leg-row"><input class="amt" id="sAmt" inputmode="decimal" value="${esc(q.get("amount") || "0.01")}" pattern="[0-9]*[.]?[0-9]+" required aria-label="Amount">
          <div class="tok-pick" id="pickIn"><button type="button" class="tok-btn" aria-haspopup="listbox" aria-expanded="false"><span class="tok-logo"></span><span class="tok-sym"></span><i class="caret-d"></i></button></div></div></div>
        <button type="button" class="flip" id="flip" aria-label="Flip tokens">⇅</button>
        <div class="leg"><label>You receive</label><div class="leg-row"><span class="out-amt" id="outAmt">—</span>
          <div class="tok-pick" id="pickOut"><button type="button" class="tok-btn" aria-haspopup="listbox" aria-expanded="false"><span class="tok-logo"></span><span class="tok-sym"></span><i class="caret-d"></i></button></div></div></div>
        ${chain?.stocks?.length ? `<div class="field" style="margin-top:14px"><label>Stocks</label><div class="chips">${chain.stocks.slice(0, 10).map((s) => `<button type="button" class="chip chip-logo" data-stock="${esc(s.symbol)}" title="${esc(s.name)}">${avatar(s.symbol, s.address, null, { stock: true })}${esc(s.symbol)}</button>`).join("")}</div></div>` : ""}
        <div class="row between" style="margin:14px 0 6px"><span class="field"><label>Slippage</label></span><div class="seg" id="slip">${[0.5, 1, 3, 5].map((s) => `<button type="button" data-s="${s}" class="${s === 1 ? "on" : ""}">${s}%</button>`).join("")}</div></div>
        <button class="btn primary block" type="submit" style="padding:14px">${state.address ? "Run Checkpoint & make ticket" : "Run Checkpoint"}</button>
      </form>
      <div class="span-7 stack" id="swapOut"><div class="card empty" style="border-style:dashed">Pick a pair and run the Checkpoint. Nothing is sent until you sign.</div></div>
    </div>`;

  // ---- the token list: base tokens, every tokenized stock, and today's trending coins ----
  const base = [
    { symbol: "ETH", name: "Ether", address: chain.tokenAddresses.ETH, group: "Tokens" },
    { symbol: "WETH", name: "Wrapped Ether", address: chain.tokenAddresses.WETH, group: "Tokens" },
    { symbol: "USDG", name: "Global Dollar", address: chain.tokenAddresses.USDG, group: "Tokens" },
  ];
  const stocks = chain.stocks.map((s) => ({ symbol: s.symbol, name: s.name, address: s.address, group: "Stocks", stock: true }));
  let coins = [], prices = {};
  const all = () => [...base, ...stocks, ...coins];
  const loadExtras = (() => {
    let started = false;
    return () => {
      if (started) return; started = true;
      api("/tools/onchain_pools?kind=trending&limit=25").then((r) => {
        const seen = new Set(all().map((t) => t.address.toLowerCase()));
        coins = r.pools.filter((p) => p.token.address && !seen.has(p.token.address.toLowerCase()) && !seen.add(p.token.address.toLowerCase()))
          .map((p) => ({ symbol: p.token.symbol, name: p.token.name || p.dex, address: p.token.address, image: p.token.image, group: "Trending coins", priceUsd: p.priceUsd, change: p.change.h24 }));
        picker?.refresh();
      }).catch(() => {});
      api("/tools/stock_prices").then((r) => { r.stocks.forEach((s) => (prices[s.address.toLowerCase()] = s)); picker?.refresh(); }).catch(() => {});
    };
  })();

  // ---- the two token slots ----
  const pick = { in: null, out: null };
  const findBy = (v) => {
    v = String(v || "").trim();
    if (!v) return null;
    const hit = all().find((t) => t.symbol.toUpperCase() === v.toUpperCase() || t.address.toLowerCase() === v.toLowerCase());
    if (hit) return hit;
    return /^0x[0-9a-fA-F]{40}$/.test(v) ? { symbol: short(v), name: "Token by address", address: v, group: "Address" } : null;
  };
  const paint = (side) => {
    const el = $(side === "in" ? "#pickIn" : "#pickOut"), t = pick[side];
    el.querySelector(".tok-logo").innerHTML = t ? avatar(t.symbol, t.address, t.image, { stock: t.stock }) : "";
    el.querySelector(".tok-sym").textContent = t ? t.symbol : "Select";
  };
  const choose = (side, t) => { pick[side] = t; paint(side); $("#outAmt").textContent = "—"; };
  choose("in", findBy(q.get("in") || "ETH"));
  choose("out", findBy(q.get("out") || "USDG"));

  // ---- dropdown ----
  let picker = null;
  function openPicker(side) {
    closePicker();
    loadExtras();
    const host = $(side === "in" ? "#pickIn" : "#pickOut");
    host.querySelector(".tok-btn").setAttribute("aria-expanded", "true");
    const pop = document.createElement("div");
    pop.className = "tok-pop";
    pop.innerHTML = `<input class="tok-search" placeholder="Search name, symbol or paste 0x…" aria-label="Search tokens"><div class="tok-list" role="listbox"></div>`;
    host.append(pop);
    const input = pop.querySelector(".tok-search"), list = pop.querySelector(".tok-list");
    let items = [], active = 0;
    const render = () => {
      const f = input.value.trim().toLowerCase();
      items = all().filter((t) => !f || t.symbol.toLowerCase().includes(f) || (t.name || "").toLowerCase().includes(f) || t.address.toLowerCase() === f);
      if (/^0x[0-9a-f]{40}$/.test(f) && !items.length) items = [{ symbol: short(input.value.trim()), name: "Use this contract address", address: input.value.trim(), group: "Address" }];
      active = Math.min(active, Math.max(0, items.length - 1));
      let group = "";
      list.innerHTML = items.length ? items.map((t, i) => {
        const pr = t.stock ? prices[t.address.toLowerCase()] : t;
        const g = t.group !== group ? `<div class="tok-group">${esc((group = t.group))}${t.group === "Trending coins" && !coins.length ? "" : ""}</div>` : "";
        return `${g}<button type="button" class="tok-item${i === active ? " on" : ""}" data-i="${i}" role="option">${avatar(t.symbol, t.address, t.image, { stock: t.stock })}
          <span class="tok-name"><b>${esc(t.symbol)}</b><small>${esc(t.name || "")}</small></span>
          <span class="tok-price">${pr?.priceUsd != null ? fmtPrice(pr.priceUsd) : ""}${(pr?.change24hPct ?? pr?.change) != null ? `<br>${signed(pr.change24hPct ?? pr.change)}` : ""}</span></button>`;
      }).join("") + (coins.length ? "" : `<div class="tok-group muted">Trending coins load in a moment…</div>`) : `<div class="tok-empty">No match. Paste a token contract address (0x…) to use any coin on Robinhood Chain.</div>`;
      list.querySelectorAll(".tok-item").forEach((b) => (b.onclick = () => { choose(side, items[Number(b.dataset.i)]); closePicker(); }));
    };
    input.oninput = () => { active = 0; render(); };
    input.onkeydown = (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(); list.querySelector(".tok-item.on")?.scrollIntoView({ block: "nearest" }); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); render(); list.querySelector(".tok-item.on")?.scrollIntoView({ block: "nearest" }); }
      else if (e.key === "Enter") { e.preventDefault(); if (items[active]) { choose(side, items[active]); closePicker(); } }
      else if (e.key === "Escape") closePicker();
    };
    picker = { refresh: render, host, side };
    render();
    input.focus();
  }
  function closePicker() {
    if (!picker) return;
    picker.host.querySelector(".tok-pop")?.remove();
    picker.host.querySelector(".tok-btn").setAttribute("aria-expanded", "false");
    picker = null;
  }
  for (const side of ["in", "out"]) $(side === "in" ? "#pickIn .tok-btn" : "#pickOut .tok-btn").onclick = (e) => { e.stopPropagation(); picker?.side === side ? closePicker() : openPicker(side); };
  const outside = (e) => { if (picker && !picker.host.contains(e.target)) closePicker(); };
  document.addEventListener("pointerdown", outside);
  const cleanup = () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("hashchange", cleanup); };
  window.addEventListener("hashchange", cleanup);

  let slip = 1;
  $("#slip").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; slip = Number(b.dataset.s); $("#slip").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); };
  $("#flip").onclick = () => { const a = pick.in; choose("in", pick.out); choose("out", a); };
  view.querySelectorAll("[data-stock]").forEach((b) => (b.onclick = () => { choose("in", findBy("ETH")); choose("out", findBy(b.dataset.stock)); }));
  $("#swapForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!pick.in || !pick.out) { toast("Pick both tokens first"); return; }
    const out = $("#swapOut");
    out.innerHTML = `<div class="card"><span class="spinner"></span>&nbsp; Running the Checkpoint on the live pool…</div>`;
    const ref = (t) => (t.group === "Tokens" || t.stock ? t.symbol : t.address);
    const args = { chain: "robinhood", tokenIn: ref(pick.in), tokenOut: ref(pick.out), amount: $("#sAmt").value.trim(), slippagePct: slip };
    try {
      if (!state.address) {
        const g = await api(`/tools/quote_swap?${new URLSearchParams(args)}`);
        if (g.swap) $("#outAmt").textContent = g.swap.amountOut;
        out.innerHTML = `<div class="card">${quoteHead(g.swap)}${checkpointHtml(g)}<p class="muted" style="margin:14px 0 0">Connect a wallet to turn this into a ticket you can sign.</p></div>`;
        return;
      }
      const t = await api("/swap/prepare", { method: "POST", body: args });
      if (t.gate?.swap) $("#outAmt").textContent = t.gate.swap.amountOut;
      out.innerHTML = "";
      out.append(ticketCard(t));
    } catch (err) { out.innerHTML = `<div class="card"><div class="verdict fail"><span class="stamp">ERROR</span><span>${esc(err.message)}</span></div></div>`; }
  };
}

function quoteHead(s) {
  if (!s) return "";
  return `<div class="ticket-legs" style="margin-bottom:14px">
    <div class="tl"><b>${esc(s.amountIn)}</b><span class="tl-tok">${avatar(s.tokenIn.symbol, s.tokenIn.address)}${esc(s.tokenIn.symbol)} · ${usd(s.inUsd)}</span></div><div class="arrow">→</div>
    <div class="tl"><b>${esc(s.amountOut)}</b><span class="tl-tok">${avatar(s.tokenOut.symbol, s.tokenOut.address)}${esc(s.tokenOut.symbol)} · ${usd(s.outUsd)}</span></div></div>`;
}

function check(q) {
  view.innerHTML = head(`Checkpoint`, `Paste a token contract on ${esc(chainName())}. Glidy reads its bytecode and runs a test buy and a test sell: the same checks that run before every swap. A heuristic, not an audit.`)
    + `<form class="card row" id="checkForm" style="margin-bottom:18px">
      <input id="addr" placeholder="0x… token contract" style="flex:1;min-width:220px" value="${esc(q.get("address") || "")}" pattern="0x[0-9a-fA-F]{40}" required>
      <button class="btn primary" type="submit">Run checks</button>
    </form><div id="checkOut"></div>`;
  const run = async () => {
    const out = $("#checkOut"), a = $("#addr").value.trim();
    out.innerHTML = `<div class="card"><span class="spinner"></span>&nbsp; Checking…</div>`;
    try {
      const r = await api(`/tools/check_token?${new URLSearchParams({ chain: "robinhood", address: a })}`);
      out.innerHTML = `<div class="card">
        <div class="panel-head"><div class="token-cell">${avatar(r.swap?.tokenOut?.symbol, a)}<div><b style="font-size:18px">${esc(r.swap?.tokenOut?.symbol || "Token")}</b><small class="mono">${esc(short(a))}</small></div></div>
        ${r.health ? `<span class="mono muted">score <b style="color:var(--text)">${r.health.score}</b>/100</span>` : ""}</div>
        ${checkpointHtml(r)}
        ${r.health?.flags?.length ? `<div style="margin-top:16px">${r.health.flags.map((f) => `<div style="padding:4px 0"><span class="tag ${f.severity === "info" ? "info" : f.severity}">${esc(f.severity)}</span> ${esc(f.text)}</div>`).join("")}</div>` : ""}
        <div class="row" style="margin-top:16px"><a class="btn primary" href="#/swap?in=ETH&out=${esc(a)}">Swap into it</a>${state.chain === "robinhood" ? `<a class="btn ghost" href="#/token?address=${esc(a)}">Market data →</a>` : ""}</div>
      </div>`;
    } catch (e) { out.innerHTML = errorBox(e); }
  };
  $("#checkForm").onsubmit = (e) => { e.preventDefault(); run(); };
  if (q.get("address")) run();
}

async function portfolio() {
  if (!state.address) { view.innerHTML = head(`Portfolio`, "") + `<div class="card empty">Connect a wallet to see what it holds on Robinhood Chain.</div>`; return; }
  view.innerHTML = head(`Portfolio`, `Read live from Robinhood Chain for <span class="mono">${esc(short(state.address))}</span>.`) + `<div id="pf"><div class="card"><span class="spinner"></span></div></div>`;
  try {
    const p = await api(`/tools/get_portfolio`);
    $("#pf").innerHTML = `<div class="stats" style="grid-template-columns:repeat(3,1fr)">
        <div class="card stat"><div class="k">Total value</div><div class="v">${usd(p.totalUsd)}</div><div class="s">known tokens</div></div>
        <div class="card stat"><div class="k">Positions</div><div class="v">${p.holdings.length}</div><div class="s">ETH, USDG and stocks</div></div>
        <div class="card stat"><div class="k">Network</div><div class="v" style="font-size:20px">Robinhood Chain</div><div class="s">chain 4663</div></div></div>
      <div class="card">${p.holdings.length ? `<div class="table-wrap"><table><thead><tr><th>Asset</th><th class="num">Amount</th><th class="num">Price</th><th class="num">Value</th><th class="num"></th></tr></thead><tbody>${p.holdings.map((h) => `
        <tr><td><div class="token-cell">${avatar(h.symbol, h.address)}<div><b>${esc(h.symbol)}</b><small>${esc(h.name || (h.stock ? "Tokenized stock" : ""))}</small></div></div></td>
        <td class="num">${h.amount.toLocaleString("en-US", { maximumFractionDigits: 6 })}</td><td class="num">${fmtPrice(h.priceUsd)}</td><td class="num">${usd(h.valueUsd)}</td>
        <td class="num"><a class="btn sm" href="#/swap?in=${esc(h.symbol)}&out=${h.symbol === "USDG" ? "ETH" : "USDG"}">Trade</a></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Nothing found among ETH, WETH, USDG and tokenized stocks.</div>`}
        <p class="muted" style="font-size:12.5px;margin:14px 0 0">${esc(p.note)}</p></div>`;
  } catch (e) { $("#pf").innerHTML = errorBox(e); }
}

async function limits() {
  if (!state.address) { view.innerHTML = head(`Limits`, "") + `<div class="card empty">Connect a wallet to see and tighten your limits.</div>`; return; }
  const p = await api("/policy");
  view.innerHTML = head(`Limits`, "The operator sets the ceiling. You can only make yours stricter. Enforced by the server on every action, outside the model.") + `
    <div class="grid">
      <form class="card span-7 stack" id="limForm">
        ${[["perTradeUsd", "Per trade (USD)"], ["dailyUsd", "Per day (USD)"], ["maxSlippagePct", "Max slippage (%)"], ["maxPriceImpactPct", "Max price impact (%)"]].map(([k, l]) => `
          <div class="field"><label for="${k}">${l} · ceiling ${p[k]}</label><input id="${k}" inputmode="decimal" value="${p.userLimits[k] ?? ""}" placeholder="${p[k]} (operator)"></div>`).join("")}
        <div class="row"><button class="btn primary">Save limits</button><button type="button" class="btn ${p.paused ? "primary" : ""}" id="pause">${p.paused ? "Resume" : "Pause everything"}</button></div>
      </form>
      <div class="card span-5"><div class="panel-head"><span class="panel-title">Now</span></div><dl class="kv">
        <dt>Used today</dt><dd>${usd(p.usedTodayUsd)}</dd><dt>Kill switch</dt><dd>${p.killSwitch ? "ON" : "off"}</dd><dt>Paused</dt><dd>${p.paused ? "yes" : "no"}</dd>
        <dt>Chains</dt><dd>${esc(p.allowedChains.join(", "))}</dd><dt>Blocked tokens</dt><dd>${p.blockedTokens.length || "none"}</dd></dl></div>
    </div>`;
  $("#limForm").onsubmit = async (e) => {
    e.preventDefault();
    const patch = {};
    for (const k of ["perTradeUsd", "dailyUsd", "maxSlippagePct", "maxPriceImpactPct"]) { const v = $(`#${k}`).value.trim(); patch[k] = v === "" ? null : Number(v); }
    await api("/policy", { method: "POST", body: patch }); toast("Limits saved"); limits();
  };
  $("#pause").onclick = async () => { await api("/policy", { method: "POST", body: { paused: !p.paused } }); toast(p.paused ? "Resumed" : "Paused"); limits(); };
}

async function journal() {
  if (!state.address) { view.innerHTML = head(`Journal`, "") + `<div class="card empty">Connect a wallet to see your journal.</div>`; return; }
  const rows = await api("/journal?limit=100");
  view.innerHTML = head(`Journal`, "Every prepare, block, build and sent transaction, with its reason.") + `<div class="card">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Stage</th><th>Outcome</th><th>Trade</th><th>Detail</th></tr></thead><tbody>${rows.map((r) => `
    <tr><td class="mono" style="white-space:nowrap">${esc(new Date(r.at).toLocaleString())}</td><td>${esc(r.stage)}</td><td><span class="tag ${r.outcome === "blocked" ? "fail" : r.outcome === "sent" ? "pass" : "info"}">${esc(r.outcome)}</span></td>
    <td>${!r.params ? "" : r.params.action === "lp_add" ? esc(`Add ${r.params.amount} ${r.params.token} to ${short(r.params.pool)} ±${r.params.widthPct}%`) : r.params.action === "lp_collect" ? esc(`Collect fees #${r.params.tokenId}`) : r.params.action === "lp_remove" ? esc(`Remove ${r.params.pct}% of #${r.params.tokenId}`) : esc(`${r.params.amount} ${short(r.params.tokenIn)} → ${short(r.params.tokenOut)} (${r.params.chain})`)}</td>
    <td class="muted">${r.hash ? `<code>${esc(short(r.hash))}</code>` : esc(r.reason || r.gateStatus || "")}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Nothing yet.</div>`}</div>`;
}

function apiDocs() {
  const origin = location.origin;
  view.innerHTML = head(`API &amp; <em>MCP</em>`, "Every tool the agent uses is also a REST endpoint and an MCP tool. Read tools are public. Prepare needs an API token; execute needs the execute scope and an Idempotency-Key. New tokens start in dry-run.") + `
    <div class="grid"><div class="card span-12">
      <div class="panel-head"><span class="panel-title">Create a token (on the server)</span></div>
      <pre class="code">npm run token -- my-laptop --owner 0xYourWallet</pre>
      <div class="panel-head"><span class="panel-title">REST</span></div>
      <pre class="code">GET  ${esc(origin)}/api/tools
GET  ${esc(origin)}/api/tools/list_lp_pools?sort=apr
GET  ${esc(origin)}/api/tools/lp_positions?address=0x…
GET  ${esc(origin)}/api/tools/check_lp?pool=0x…&amp;token=ETH&amp;amount=0.05&amp;widthPct=10
POST ${esc(origin)}/api/tools/prepare_lp_add  x-api-key   {"pool":"0x…","token":"ETH","amount":"0.05","widthPct":10}
POST ${esc(origin)}/api/tools/prepare_swap   x-api-key   {"tokenOut":"USDG","amount":"0.01"}
POST ${esc(origin)}/api/tools/execute_intent x-api-key + Idempotency-Key  {"confirmationId":"cf_…"}</pre>
      <div class="panel-head"><span class="panel-title">MCP (Claude Code)</span></div>
      <pre class="code">claude mcp add glidy --env GLIDY_URL=${esc(origin)} --env GLIDY_API_KEY=glidy_… -- node /path/to/glidy/mcp/index.mjs</pre>
      <div class="panel-head"><span class="panel-title">Tools</span></div><div id="toolList"><div class="skeleton"></div></div>
    </div></div>`;
  api("/tools").then((ts) => ($("#toolList").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Tool</th><th>Tier</th><th>What it does</th></tr></thead><tbody>${ts.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td><span class="tag ${t.tier === "read" ? "pass" : t.tier === "prepare" ? "warn" : "fail"}">${esc(t.tier)}</span></td><td class="muted">${esc(t.description)}</td></tr>`).join("")}</tbody></table></div>`));
}

// ---------------- tickets ----------------

function ticketCard(t) {
  const el = document.createElement("div");
  el.className = "ticket";
  const render = (status = "") => {
    const s = t.gate?.swap, lp = t.gate?.plan, pos = t.gate?.position;
    const expired = t.expiresAt && Date.parse(t.expiresAt) < Date.now();
    const kindLabel = { lp_add: "Add liquidity", lp_collect: "Collect fees", lp_remove: "Remove liquidity" }[t.gate?.kind] || (s ? s.chainName : "");
    el.innerHTML = `
      <div class="ticket-head"><span>Ticket <span class="id">${t.ok ? "#" + esc(t.ref || "") : "blocked"}</span></span><span>${esc(kindLabel)}${lp || pos ? " · Robinhood Chain" : ""}</span></div>
      <div class="ticket-body">
        ${s ? quoteHead(s) : ""}
        ${lp ? `<div class="ticket-legs" style="margin-bottom:14px">
          <div class="tl"><b>${esc(lp.amount0)}</b><span class="tl-tok">${avatar(lp.token0.symbol, lp.token0.address)}${esc(lp.token0.symbol)}</span></div><div class="arrow">+</div>
          <div class="tl"><b>${esc(lp.amount1)}</b><span class="tl-tok">${avatar(lp.token1.symbol, lp.token1.address)}${esc(lp.token1.symbol)}</span></div></div>
          <p class="muted" style="margin:0 0 12px;font-size:13px">Range ±${lp.widthPct.toFixed(1)}%: ${fmtAmt(lp.price.lower)} – ${fmtAmt(lp.price.upper)} ${esc(lp.price.unit)} · ${lp.feePct}% pool${lp.valueUsd ? ` · ${usd(lp.valueUsd)}` : ""}</p>` : ""}
        ${pos ? `<div class="row" style="margin-bottom:12px">${pair(pos.token0, pos.token1)}<b>${esc(pos.token0.symbol)} / ${esc(pos.token1.symbol)}</b><span class="muted">#${esc(pos.tokenId)}</span>${rangeTag(pos)}</div>` : ""}
        ${checkpointHtml(t.gate)}
        ${t.ok ? `<div class="ticket-foot">
          <span class="meta">${expired ? "Expired" : `Valid until ${new Date(t.expiresAt).toLocaleTimeString()}`}${s ? ` · slippage ${s.slippagePct}%` : ""}</span>
          ${status ? `<span>${status}</span>` : `<button class="btn primary" data-sign ${expired ? "disabled" : ""}>Re-check &amp; sign</button>`}
        </div>` : ""}
      </div>`;
    el.querySelector("[data-sign]")?.addEventListener("click", () => signTicket(t, render));
  };
  render();
  return el;
}

async function signTicket(t, render) {
  try {
    if (!state.address) { await connectWallet(); renderWallet(); }
    render('<span class="spinner"></span>&nbsp; Re-checking on the live pool…');
    const b = await api(`/tickets/${t.id}/build`, { method: "POST", body: {} });
    if (!b.ok) { t.gate = b.gate; t.ok = false; render(); toast(b.reason); return; }
    t.gate = b.gate;
    await ensureChain(b.chainId);
    let last;
    for (const [i, tx] of b.txs.entries()) {
      render(`<span class="spinner"></span>&nbsp; ${esc(tx.label)}: confirm in your wallet (${i + 1}/${b.txs.length})`);
      const hash = await sendTx(tx);
      render(`<span class="spinner"></span>&nbsp; ${esc(tx.label)}: waiting for the chain…`);
      await waitReceipt(hash);
      last = hash;
    }
    await api(`/tickets/${t.id}/sent`, { method: "POST", body: { hash: last } });
    render(`<span class="up">✓ Done</span> · <a href="${esc(b.explorer)}/tx/${esc(last)}" target="_blank" rel="noopener" style="text-decoration:underline">view transaction ↗</a>`);
    toast(t.gate?.kind?.startsWith("lp_") ? "Done on Robinhood Chain" : "Swap confirmed");
  } catch (e) {
    render(`<span class="down">${esc(e.message || String(e))}</span>`);
  }
}

// ---------------- agent drawer ----------------

let sessionId = null, busy = false;

const ACTIONS = [
  { q: "best pools", t: "Best pools now", s: "Ranked by fee APR", i: '<path d="M3 15c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0"/><path d="M12 3v8M8 7l4 4 4-4"/>' },
  { q: "my positions", t: "My positions", s: "Range, value, fees", i: '<path d="M5 4v16M19 4v16"/><path d="M3 16c4 0 5-8 9-8s5 8 9 8"/>' },
  { q: "collect my fees", t: "Fees ready", s: "What I can collect", i: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M9 10.5c0-1.5 6-1.5 6 0s-6 1.5-6 3 6 1.5 6 0"/>' },
  { q: "pools by tvl", t: "Deepest pools", s: "Safest liquidity", i: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>' },
];
const TOOL_LABEL = {
  list_lp_pools: "Ranked Uniswap v3 pools", lp_positions: "Read your positions", pool_state: "Read the pool", check_lp: "Ran the LP Checkpoint",
  prepare_lp_add: "Prepared a deposit ticket", prepare_lp_collect: "Prepared a collect ticket", prepare_lp_remove: "Prepared a remove ticket",
  prepare_swap: "Prepared a swap ticket", quote_swap: "Quoted a swap", check_token: "Checked the token", token_health: "Read the bytecode",
  get_portfolio: "Read your wallet", get_balance: "Read a balance", get_policy: "Read your limits", stock_prices: "Read stock prices",
  onchain_pools: "Read live pools", onchain_token: "Read the token", chain_status: "Read the chain",
};
const THINKING = ["Reading Robinhood Chain…", "Ranking pools by fee income…", "Checking ranges and risk…", "Putting it together…"];

function openDrawer(prefill) {
  if (!state.address) { document.querySelectorAll(".nav a").forEach((x) => x.classList.remove("on")); gate("ask"); window.scrollTo(0, 0); return; }
  $("#drawer").classList.add("open"); $("#drawer").setAttribute("aria-hidden", "false"); $("#scrim").hidden = false;
  if (!$("#chatLog").children.length) welcome();
  if (prefill != null) { $("#chatInput").value = prefill; if (prefill) sendChat(); }
  $("#chatInput").focus();
}
function closeDrawer() { $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true"); $("#scrim").hidden = !document.body.classList.contains("nav-open"); }

function welcome() {
  sessionId = null;
  const hour = new Date().getHours();
  $("#chatLog").innerHTML = `<div class="ag-hello">
    <div class="ag-orb"><img src="/img/glidy.svg" alt="" width="56" height="56"></div>
    <h3>${hour < 12 ? "gm" : hour < 18 ? "Good afternoon" : "Good evening"}, ${esc(short(state.address))}</h3>
    <p>I'm Glidy, your LP agent on Robinhood Chain. I find pools, pick ranges, run the Checkpoint and write tickets. You sign every move.</p>
    <div class="ag-actions">${ACTIONS.map((a) => `<button type="button" class="ag-act" data-q="${esc(a.q)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${a.i}</svg><b>${esc(a.t)}</b><small>${esc(a.s)}</small></button>`).join("")}</div>
    ${state.health?.llm ? "" : `<p class="ag-note">Command mode: try “add 0.05 ETH to 0x… 10%”, “collect 1234”, “rebalance 1234”.</p>`}
  </div>`;
  $("#chatLog").querySelectorAll(".ag-act").forEach((b) => (b.onclick = () => ask(b.dataset.q)));
  suggest(["best pools", "my positions", "pools by volume"]);
}
const ask = (q) => { $("#chatInput").value = q; sendChat(); };

function suggest(list) {
  $("#chatSuggest").innerHTML = list.map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join("");
  $("#chatSuggest").querySelectorAll("button").forEach((b) => (b.onclick = () => ask(b.dataset.q)));
}

/** Plain text from the agent → safe HTML: bold, bullet lists, pool addresses as links, position ids as chips. */
function richText(text, { hideLists = false } = {}) {
  const lines = String(text).split("\n");
  let html = "", inList = false;
  for (const raw of lines) {
    const bullet = /^\s*[•\-*]\s+/.test(raw);
    if (bullet && hideLists) continue;
    let l = esc(raw.replace(/^\s*[•\-*]\s+/, ""))
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/(0x[0-9a-fA-F]{40})/g, (a) => `<a class="addr" href="#/pool?address=${a}">${a.slice(0, 6)}…${a.slice(-4)}</a>`)
      .replace(/(^|\s)#(\d{3,9})\b/g, '$1<span class="pid">#$2</span>');
    if (bullet) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${l}</li>`; continue; }
    if (inList) { html += "</ul>"; inList = false; }
    html += l ? `<p>${l}</p>` : "";
  }
  return html + (inList ? "</ul>" : "");
}

function addMsg(who, html) {
  const d = document.createElement("div");
  d.className = `msg ${who}`;
  d.innerHTML = who === "bot" ? `<span class="ag-av sm"><img src="/img/glidy.svg" alt=""></span><div class="msg-body">${html}</div>` : html;
  $("#chatLog").append(d);
  $("#chatLog").scrollTop = 1e9;
  return d;
}

function cardsHtml(c = {}) {
  let h = "";
  if (c.pools?.length) h += `<div class="cc-list">${c.pools.map((p, i) => `<a class="cc-pool" href="#/pool?address=${esc(p.pool)}">
    <span class="cc-rank">${i + 1}</span>${pair(p.base, p.quote)}<span class="cc-main"><b>${esc(p.base.symbol)} / ${esc(p.quote.symbol)}</b><small>${p.feePct}% · TVL ${usd(p.tvlUsd)} · vol ${usd(p.volume24hUsd)}</small></span>
    <span class="cc-apr"><b class="apr">${pct(p.feeAprPct, 0)}</b><small>APR</small></span><span class="cc-go">Add →</span></a>`).join("")}</div>`;
  if (c.positions?.length) h += `<div class="cc-list">${c.positions.map((p) => `<div class="cc-pos">
    <div class="row between">${pair(p.token0, p.token1)}<span class="cc-main"><b>${esc(p.token0.symbol)} / ${esc(p.token1.symbol)}</b><small>#${esc(p.tokenId)} · ${p.feePct}%</small></span>${rangeTag(p)}</div>
    <div class="row between cc-nums"><span><small>Value</small>${usd(p.valueUsd)}</span><span><small>Fees ready</small><b class="up">${usd(p.feesUsd)}</b></span>
    <span class="cc-btns">${p.fees0 + p.fees1 > 0 ? `<button type="button" class="btn sm primary" data-q="collect ${esc(p.tokenId)}">Collect</button>` : ""}${!p.closed && !p.inRange ? `<button type="button" class="btn sm" data-q="rebalance ${esc(p.tokenId)}">Rebalance</button>` : ""}</span></div></div>`).join("")}</div>`;
  return h;
}

async function sendChat() {
  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text || busy) return;
  busy = true; input.value = ""; $("#chatSend").disabled = true;
  $("#chatLog").querySelector(".ag-hello")?.classList.add("small");
  addMsg("user", esc(text));
  const wait = addMsg("bot", `<div class="ag-typing"><span class="dots"><i></i><i></i><i></i></span><span class="ag-status">${THINKING[0]}</span></div>`);
  let k = 0; const rot = setInterval(() => { const s = wait.querySelector(".ag-status"); if (s) s.textContent = THINKING[++k % THINKING.length]; }, 1600);
  const t0 = performance.now();
  try {
    const r = await api("/chat", { method: "POST", body: { message: text, sessionId } });
    sessionId = r.sessionId || sessionId;
    clearInterval(rot); wait.remove();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const tools = [...new Set(r.tools || [])];
    const chips = tools.length ? `<div class="ag-tools">${tools.map((n) => `<span class="ag-tool"><i>✓</i>${esc(TOOL_LABEL[n] || n)}</span>`).join("")}<span class="ag-time">${secs}s</span></div>` : "";
    const hasCards = !!(r.cards?.pools?.length || r.cards?.positions?.length);
    const m = addMsg("bot", chips + richText(r.reply || "(no reply)", { hideLists: hasCards && r.mode === "parser" }) + cardsHtml(r.cards));
    m.querySelectorAll("[data-q]").forEach((b) => (b.onclick = () => ask(b.dataset.q)));
    for (const t of r.tickets || []) { const w = document.createElement("div"); w.className = "msg ticket-msg"; w.append(ticketCard(t)); $("#chatLog").append(w); }
    $("#chatLog").scrollTop = 1e9;
    const pos = r.cards?.positions || [];
    suggest(r.cards?.pools?.length ? ["my positions", "pools by tvl", "pools by volume"]
      : pos.length ? [pos.find((p) => p.fees0 + p.fees1 > 0) && `collect ${pos.find((p) => p.fees0 + p.fees1 > 0).tokenId}`, pos.find((p) => !p.closed && !p.inRange) && `rebalance ${pos.find((p) => !p.closed && !p.inRange).tokenId}`, "best pools"].filter(Boolean)
      : r.tickets?.length ? ["my positions", "best pools"] : ["best pools", "my positions", "my limits"]);
  } catch (e) { clearInterval(rot); wait.remove(); addMsg("bot", `<p class="down">${esc(e.message)}</p>`); }
  finally { busy = false; $("#chatSend").disabled = false; input.focus(); }
}

boot().catch((e) => { view.innerHTML = `<div class="empty">Could not start: ${esc(e.message)}</div>`; });
