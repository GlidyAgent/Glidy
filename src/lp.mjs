// Glidy's LP engine for Uniswap v3 on Robinhood Chain: pools with fee APR, live pool state, a wallet's positions
// (amounts, range, uncollected fees) and the calldata for add / collect / remove. No keys here: every action returns
// unsigned transactions that the wallet signs.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { CHAINS, knownToken } from "./chains.mjs";
import { MOCK } from "./mock.mjs";
import { geckoGet } from "./onchain.mjs";
import { remember } from "./logos.mjs";
import { allowance, balanceOf, resolveToken, rpc, rpcBatch } from "./rpc.mjs";
import { formatUnits, parseUnits } from "./units.mjs";

const RH = CHAINS.robinhood;
export const NPM = "0x73991a25c818bf1f1128deaab1492d45638de0d3"; // Uniswap V3 Positions NFT-V1 (NonfungiblePositionManager)
export const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa"; // UniswapV3Factory
export const WETH = RH.tokens.WETH.address.toLowerCase();
const DEX_ID = "uniswap-v3-robinhood";
const MAX128 = (1n << 128n) - 1n;
const Q96 = 2 ** 96;

// ---------- ABI ----------
const sel = (sig) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex").slice(0, 8);
const S = {
  slot0: sel("slot0()"), token0: sel("token0()"), token1: sel("token1()"), fee: sel("fee()"), tickSpacing: sel("tickSpacing()"), liquidity: sel("liquidity()"), factory: sel("factory()"),
  balanceOf: sel("balanceOf(address)"), tokenOfOwnerByIndex: sel("tokenOfOwnerByIndex(address,uint256)"), positions: sel("positions(uint256)"), getPool: sel("getPool(address,address,uint24)"),
  mint: sel("mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))"),
  decrease: sel("decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))"),
  collect: sel("collect((uint256,address,uint128,uint128))"),
  multicall: sel("multicall(bytes[])"), refundETH: sel("refundETH()"), unwrapWETH9: sel("unwrapWETH9(uint256,address)"), sweepToken: sel("sweepToken(address,uint256,address)"),
};
const word = (v) => {
  let n = BigInt(v);
  if (n < 0n) n = (1n << 256n) + n;
  return n.toString(16).padStart(64, "0");
};
const addr = (a) => String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const enc = (selector, ...words) => selector + words.join("");
const words = (hex) => (String(hex || "0x").replace(/^0x/, "").match(/.{64}/g) || []);
const u = (w) => BigInt("0x" + w);
const i24 = (w) => { const v = u(w) & 0xffffffn; return Number(v >= 0x800000n ? v - 0x1000000n : v); };
const asAddr = (w) => "0x" + w.slice(24);

function multicall(calls) {
  // multicall(bytes[]): offset, length, offsets…, then each item as length + padded bytes
  const items = calls.map((c) => c.replace(/^0x/, ""));
  let head = "", tail = "", off = items.length * 32;
  for (const it of items) {
    head += word(off);
    const padded = it.padEnd(Math.ceil(it.length / 64) * 64, "0");
    tail += word(it.length / 2) + padded;
    off += 32 + padded.length / 2;
  }
  return S.multicall + word(32) + word(items.length) + head + tail;
}

const call = (to, data) => ({ method: "eth_call", params: [{ to, data }, "latest"] });

// ---------- price / tick math (floats: for display and for sizing; contracts enforce the exact amounts) ----------
const tickToSqrt = (t) => Math.pow(1.0001, t / 2);
const priceToTick = (p) => Math.log(p) / Math.log(1.0001);
/** amounts(L, sqrtP, tickLower, tickUpper) → raw token amounts (floats) */
function amountsFor(L, sp, tl, tu) {
  const sa = tickToSqrt(tl), sb = tickToSqrt(tu);
  if (sp <= sa) return { a0: (L * (sb - sa)) / (sa * sb), a1: 0 };
  if (sp >= sb) return { a0: 0, a1: L * (sb - sa) };
  return { a0: (L * (sb - sp)) / (sp * sb), a1: L * (sp - sa) };
}
const fl = (raw, dec) => Number(raw) / 10 ** dec;
const big = (x) => BigInt(Math.max(0, Math.floor(x)).toLocaleString("fullwide", { useGrouping: false }));

// ---------- pools ----------
const num = (x) => (x == null || x === "" ? null : Number(x));
function feeFromName(name) {
  const m = String(name || "").match(/([\d.]+)%\s*$/);
  return m ? Number(m[1]) : null;
}

/** listPools({ sort: "apr" | "tvl" | "volume", limit }) — Uniswap v3 pools on Robinhood Chain with a fee APR estimate. */
export async function listPools({ sort = "apr", limit = 30 } = {}) {
  const pages = MOCK ? [mockGecko()] : await Promise.all([1, 2].map((p) => geckoGet(`networks/robinhood/dexes/${DEX_ID}/pools?include=base_token,quote_token&page=${p}`, 60_000).then((r) => r.data).catch(() => null)));
  const tokens = new Map();
  for (const pg of pages) for (const x of pg?.included || []) if (x.type === "token") tokens.set(x.id, x.attributes);
  const seen = new Set(), out = [];
  for (const pg of pages) for (const p of pg?.data || []) {
    const a = p.attributes;
    if (seen.has(a.address)) continue;
    seen.add(a.address);
    const t0 = tokens.get(p.relationships?.base_token?.data?.id) || {}, t1 = tokens.get(p.relationships?.quote_token?.data?.id) || {};
    for (const t of [t0, t1]) if (t.address && t.image_url) remember(t.address, t.image_url);
    const feePct = feeFromName(a.name), tvl = num(a.reserve_in_usd), vol = num(a.volume_usd?.h24);
    const feeApr = feePct != null && tvl > 0 && vol != null ? Math.min(99999, ((vol * feePct) / 100 / tvl) * 365 * 100) : null;
    const tok = (t) => ({ address: t.address || null, symbol: t.symbol || "?", name: t.name || null, image: t.image_url || null, stock: !!(t.address && knownToken("robinhood", t.address)?.stock) });
    out.push({
      pool: a.address, name: a.name, feePct, tvlUsd: tvl, volume24hUsd: vol, feeAprPct: feeApr,
      change24hPct: num(a.price_change_percentage?.h24), base: tok(t0), quote: tok(t1),
      priceUsd: num(a.base_token_price_usd), createdAt: a.pool_created_at || null,
      txns24h: (a.transactions?.h24?.buys ?? 0) + (a.transactions?.h24?.sells ?? 0),
    });
  }
  // Thin pools show silly APRs: rank APR only among pools with real depth.
  const key = { apr: (p) => (p.tvlUsd >= 20000 ? p.feeAprPct ?? 0 : -1), tvl: (p) => p.tvlUsd ?? 0, volume: (p) => p.volume24hUsd ?? 0 }[sort] || ((p) => p.tvlUsd ?? 0);
  out.sort((x, y) => key(y) - key(x));
  return { dex: "Uniswap v3", chain: "robinhood", updatedAt: new Date().toISOString(), pools: out.slice(0, Math.min(60, limit)) };
}

/** poolState(address) → tokens, fee, tick, sqrtPrice and the human price of token0 in token1. */
export async function poolState(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ""))) throw Object.assign(new Error("pool must be a 0x… address"), { status: 400 });
  if (MOCK) return mockState(address);
  const [slot0, t0, t1, fee, ts, liq, fac] = await rpcBatch("robinhood", [S.slot0, S.token0, S.token1, S.fee, S.tickSpacing, S.liquidity, S.factory].map((d) => call(address, d)));
  if (!slot0 || !t0) throw Object.assign(new Error("Not a Uniswap v3 pool on Robinhood Chain"), { status: 400 });
  const w = words(slot0);
  const token0 = await resolveToken("robinhood", asAddr(words(t0)[0]));
  const token1 = await resolveToken("robinhood", asAddr(words(t1)[0]));
  const sqrtPriceX96 = u(w[0]), tick = i24(w[1]);
  const sp = Number(sqrtPriceX96) / Q96;
  return {
    pool: address.toLowerCase(), factory: fac ? asAddr(words(fac)[0]) : null, official: fac ? asAddr(words(fac)[0]) === FACTORY : false,
    token0, token1, fee: Number(u(words(fee)[0])), tickSpacing: Number(u(words(ts)[0])), liquidity: u(words(liq)[0]).toString(),
    sqrtPriceX96: sqrtPriceX96.toString(), tick, sp,
    price: sp * sp * 10 ** (token0.decimals - token1.decimals), // token1 per 1 token0
  };
}

// ---------- positions ----------
/** positions({ address }) → the wallet's Uniswap v3 positions on Robinhood Chain with live amounts and fees. */
export async function positions({ address }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ""))) throw Object.assign(new Error("Connect a wallet to see positions"), { status: 400 });
  if (MOCK) return mockPositions(address);
  const n = Number(BigInt(await rpc("robinhood", "eth_call", [{ to: NPM, data: enc(S.balanceOf, addr(address)) }, "latest"])));
  const count = Math.min(n, 40);
  const ids = (await rpcBatch("robinhood", Array.from({ length: count }, (_, i) => call(NPM, enc(S.tokenOfOwnerByIndex, addr(address), word(i)))))).map((r) => (r ? u(words(r)[0]) : null)).filter((x) => x != null);
  const raw = await rpcBatch("robinhood", ids.map((id) => call(NPM, enc(S.positions, word(id)))));
  const list = [];
  for (let i = 0; i < ids.length; i++) {
    const w = words(raw[i]);
    if (w.length < 12) continue;
    list.push({ tokenId: ids[i].toString(), token0: asAddr(w[2]), token1: asAddr(w[3]), fee: Number(u(w[4])), tickLower: i24(w[5]), tickUpper: i24(w[6]), liquidity: u(w[7]), owed0: u(w[10]), owed1: u(w[11]) });
  }
  // pool address per (token0, token1, fee), then each pool's slot0
  const keys = [...new Set(list.map((p) => `${p.token0}|${p.token1}|${p.fee}`))];
  const poolAddrs = await rpcBatch("robinhood", keys.map((k) => { const [a, b, f] = k.split("|"); return call(FACTORY, enc(S.getPool, addr(a), addr(b), word(f))); }));
  const poolOf = new Map(keys.map((k, i) => [k, poolAddrs[i] ? asAddr(words(poolAddrs[i])[0]) : null]));
  const pools = [...new Set([...poolOf.values()].filter(Boolean))];
  const slots = await rpcBatch("robinhood", pools.map((p) => call(p, S.slot0)));
  const slotOf = new Map(pools.map((p, i) => [p, slots[i] ? words(slots[i]) : null]));
  // fees: a static collect from the owner returns what would be paid out right now
  const open = list.filter((p) => p.liquidity > 0n || p.owed0 > 0n || p.owed1 > 0n);
  const fees = await rpcBatch("robinhood", open.map((p) => ({ method: "eth_call", params: [{ from: address, to: NPM, data: enc(S.collect, word(p.tokenId), addr(address), word(MAX128), word(MAX128)) }, "latest"] })));
  const feeOf = new Map(open.map((p, i) => [p.tokenId, fees[i] ? words(fees[i]) : null]));
  const tokenSet = [...new Set(open.flatMap((p) => [p.token0, p.token1]))];
  const toks = new Map(await Promise.all(tokenSet.map(async (t) => [t, await resolveToken("robinhood", t).catch(() => ({ symbol: t.slice(0, 6), address: t, decimals: 18 }))])));
  const usd = await tokenPricesUsd(tokenSet);

  const out = open.map((p) => {
    const pool = poolOf.get(`${p.token0}|${p.token1}|${p.fee}`);
    const s = slotOf.get(pool);
    const t0 = toks.get(p.token0), t1 = toks.get(p.token1);
    const sp = s ? Number(u(s[0])) / Q96 : null, tick = s ? i24(s[1]) : null;
    const am = sp ? amountsFor(Number(p.liquidity), sp, p.tickLower, p.tickUpper) : { a0: 0, a1: 0 };
    const f = feeOf.get(p.tokenId);
    const fee0 = f ? u(f[0]) : p.owed0, fee1 = f ? u(f[1]) : p.owed1;
    const amt0 = am.a0 / 10 ** t0.decimals, amt1 = am.a1 / 10 ** t1.decimals;
    const f0 = fl(fee0, t0.decimals), f1 = fl(fee1, t1.decimals);
    const p0 = usd[p.token0.toLowerCase()], p1 = usd[p.token1.toLowerCase()];
    const valueUsd = p0 != null && p1 != null ? amt0 * p0 + amt1 * p1 : null;
    const feesUsd = p0 != null && p1 != null ? f0 * p0 + f1 * p1 : null;
    const dec = 10 ** (t0.decimals - t1.decimals);
    const lo = Math.pow(1.0001, p.tickLower) * dec, hi = Math.pow(1.0001, p.tickUpper) * dec, now = sp ? sp * sp * dec : null;
    return {
      tokenId: p.tokenId, pool, feePct: p.fee / 10000, token0: t0, token1: t1, tickLower: p.tickLower, tickUpper: p.tickUpper, tick,
      inRange: tick != null && p.liquidity > 0n ? tick >= p.tickLower && tick < p.tickUpper : null, closed: p.liquidity === 0n,
      liquidity: p.liquidity.toString(),
      amount0: amt0, amount1: amt1, fees0: f0, fees1: f1, valueUsd, feesUsd,
      price: { now, lower: lo, upper: hi, unit: `${t1.symbol} per ${t0.symbol}` },
    };
  });
  out.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  return { address, total: n, shown: out.length, positions: out, explorer: RH.explorer, npm: NPM };
}

async function tokenPricesUsd(addresses) {
  if (!addresses.length) return {};
  if (MOCK) return Object.fromEntries(addresses.map((a) => [a.toLowerCase(), a.toLowerCase() === WETH ? 3200 : 1]));
  try {
    const r = await geckoGet(`simple/networks/robinhood/token_price/${addresses.map((a) => a.toLowerCase()).join(",")}`, 60_000);
    const m = r.data?.data?.attributes?.token_prices || {};
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k.toLowerCase(), v == null ? null : Number(v)]));
  } catch { return {}; }
}
export { tokenPricesUsd };

/** position(tokenId, owner) — one of the wallet's positions (re-read live). */
export async function position(tokenId, owner) {
  const r = await positions({ address: owner });
  const p = r.positions.find((x) => x.tokenId === String(tokenId));
  if (!p) throw Object.assign(new Error(`Position #${tokenId} is not in this wallet`), { status: 404 });
  return p;
}

// ---------- planning an add ----------
const WIDTHS = [1, 2, 5, 10, 20, 50];

/**
 * planAdd({ pool, token, amount, widthPct, sender }) — size a new position around the current price.
 * `token` is the side the user gives (symbol or address of token0/token1; ETH means the WETH side, paid in native ETH).
 */
export async function planAdd({ pool, token, amount, widthPct = 10 }) {
  const st = await poolState(pool);
  const width = Math.min(90, Math.max(0.2, Number(widthPct) || 10)) / 100;
  const ref = String(token || "").toLowerCase();
  const is0 = [st.token0.address.toLowerCase(), st.token0.symbol.toLowerCase()].includes(ref) || (ref === "eth" && st.token0.address.toLowerCase() === WETH);
  const is1 = [st.token1.address.toLowerCase(), st.token1.symbol.toLowerCase()].includes(ref) || (ref === "eth" && st.token1.address.toLowerCase() === WETH);
  if (!is0 && !is1) throw Object.assign(new Error(`Give an amount of ${st.token0.symbol} or ${st.token1.symbol}`), { status: 400 });
  const given = is0 ? st.token0 : st.token1;
  const amountRaw = parseUnits(String(amount), given.decimals);
  if (amountRaw <= 0n) throw Object.assign(new Error("Amount must be above zero"), { status: 400 });

  // range: ±width around the current price, snapped to the pool's tick spacing
  const spc = st.tickSpacing;
  let tl = Math.floor(priceToTick(st.sp * st.sp * (1 - width)) / spc) * spc;
  let tu = Math.ceil(priceToTick(st.sp * st.sp * (1 + width)) / spc) * spc;
  if (tl >= st.tick) tl = Math.floor(st.tick / spc) * spc - spc;
  if (tu <= st.tick) tu = Math.ceil(st.tick / spc) * spc + spc;
  const sa = tickToSqrt(tl), sb = tickToSqrt(tu), sp = st.sp;
  let L, a0, a1;
  if (is0) { a0 = Number(amountRaw); L = (a0 * sp * sb) / (sb - sp); a1 = L * (sp - sa); }
  else { a1 = Number(amountRaw); L = a1 / (sp - sa); a0 = (L * (sb - sp)) / (sp * sb); }
  const amount0 = is0 ? amountRaw : big(a0), amount1 = is1 ? amountRaw : big(a1);
  const dec = 10 ** (st.token0.decimals - st.token1.decimals);
  return {
    pool: st.pool, state: st, tickLower: tl, tickUpper: tu, widthPct: width * 100,
    amount0, amount1, amount0Text: formatUnits(amount0, st.token0.decimals), amount1Text: formatUnits(amount1, st.token1.decimals),
    given: given.symbol, nativeEth: ref === "eth" || [st.token0, st.token1].some((t) => t.address.toLowerCase() === WETH),
    price: { now: st.price, lower: Math.pow(1.0001, tl) * dec, upper: Math.pow(1.0001, tu) * dec, unit: `${st.token1.symbol} per ${st.token0.symbol}` },
  };
}
export { WIDTHS };

// ---------- transactions ----------
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
const hex = (n) => "0x" + BigInt(n).toString(16);

/** buildAddTxs(plan, sender, slippagePct) → approvals (if needed) and the mint. WETH is paid in native ETH. */
export async function buildAddTxs(plan, sender, slippagePct = 1) {
  const st = plan.state, txs = [];
  const keep = BigInt(Math.round((100 - slippagePct) * 100));
  const min0 = (plan.amount0 * keep) / 10000n, min1 = (plan.amount1 * keep) / 10000n;
  let value = 0n;
  for (const [t, amt] of [[st.token0, plan.amount0], [st.token1, plan.amount1]]) {
    if (amt === 0n) continue;
    if (t.address.toLowerCase() === WETH) { value += amt; continue; }
    if ((await allowance("robinhood", t.address, sender, NPM)) < amt) {
      txs.push({ label: `Approve ${formatUnits(amt, t.decimals)} ${t.symbol} for Uniswap`, to: t.address, data: "0x095ea7b3" + addr(NPM) + word(amt), value: "0x0" });
    }
  }
  const mint = enc(S.mint, addr(st.token0.address), addr(st.token1.address), word(st.fee), word(plan.tickLower), word(plan.tickUpper), word(plan.amount0), word(plan.amount1), word(min0), word(min1), addr(sender), word(deadline()));
  const data = value > 0n ? multicall([mint, S.refundETH]) : mint;
  txs.push({ label: `Add ${plan.amount0Text} ${st.token0.symbol} + ${plan.amount1Text} ${st.token1.symbol} (±${plan.widthPct.toFixed(1)}%)`, to: NPM, data, value: hex(value) });
  return txs;
}

/** payout calls after collect-to-manager: unwrap WETH to ETH and sweep the other token to the owner. */
function payout(p, owner, unwrap = true) {
  if (!unwrap) return null;
  const calls = [];
  const other = p.token0.address.toLowerCase() === WETH ? p.token1 : p.token1.address.toLowerCase() === WETH ? p.token0 : null;
  if (!other) return null;
  calls.push(enc(S.unwrapWETH9, word(0), addr(owner)));
  calls.push(enc(S.sweepToken, addr(other.address), word(0), addr(owner)));
  return calls;
}

/** EOAs get WETH back as native ETH; contract wallets (which may not accept ETH) get WETH. */
export async function canTakeEth(owner) {
  if (MOCK) return true;
  const code = await rpc("robinhood", "eth_getCode", [owner, "latest"]).catch(() => "0x");
  return !code || code === "0x" || /^0xef0100/i.test(code); // EOA or an EIP-7702 delegated EOA
}

export function buildCollectTx(p, owner, { unwrap = true } = {}) {
  const pay = payout(p, owner, unwrap);
  const collect = enc(S.collect, word(p.tokenId), addr(pay ? "0x0000000000000000000000000000000000000000" : owner), word(MAX128), word(MAX128));
  return { label: `Collect fees from #${p.tokenId} (${p.token0.symbol}/${p.token1.symbol})`, to: NPM, data: pay ? multicall([collect, ...pay]) : collect, value: "0x0" };
}

export function buildRemoveTx(p, owner, { pct = 100, slippagePct = 1, unwrap = true } = {}) {
  const share = BigInt(Math.round(Math.min(100, Math.max(1, pct)) * 100));
  const liq = (BigInt(p.liquidity) * share) / 10000n;
  const keep = (100 - slippagePct) / 100;
  const min0 = big(p.amount0 * 10 ** p.token0.decimals * (pct / 100) * keep), min1 = big(p.amount1 * 10 ** p.token1.decimals * (pct / 100) * keep);
  const pay = payout(p, owner, unwrap);
  const calls = [
    enc(S.decrease, word(p.tokenId), word(liq), word(min0), word(min1), word(deadline())),
    enc(S.collect, word(p.tokenId), addr(pay ? "0x0000000000000000000000000000000000000000" : owner), word(MAX128), word(MAX128)),
    ...(pay || []),
  ];
  return { label: `Remove ${pct}% of #${p.tokenId} (${p.token0.symbol}/${p.token1.symbol}) and collect fees`, to: NPM, data: multicall(calls), value: "0x0" };
}

/** balances the plan needs vs what the wallet holds (WETH side counted as native ETH). */
export async function planBalances(plan, sender) {
  const st = plan.state;
  const rows = [];
  for (const [t, amt] of [[st.token0, plan.amount0], [st.token1, plan.amount1]]) {
    if (amt === 0n) continue;
    const isEth = t.address.toLowerCase() === WETH;
    const have = await balanceOf("robinhood", isEth ? "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" : t.address, sender).catch(() => null);
    rows.push({ symbol: isEth ? "ETH" : t.symbol, need: amt, have, decimals: t.decimals, ok: have == null ? null : have >= amt });
  }
  return rows;
}

// ---------- mock ----------
function mockGecko() {
  const mk = (addr, name, b, q, tvl, vol, ch) => ({ attributes: { address: addr, name, reserve_in_usd: String(tvl), volume_usd: { h24: String(vol) }, price_change_percentage: { h24: String(ch) }, base_token_price_usd: "1", transactions: { h24: { buys: 10, sells: 9 } } }, relationships: { base_token: { data: { id: "rh_" + b } }, quote_token: { data: { id: "rh_" + q } } } });
  return {
    data: [mk("0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca", "USDG / WETH 0.05%", "usdg", "weth", 1.5e6, 4e6, 1.2), mk("0x62ab521f71431f78ac374cdbadc6cda3c8916b6c", "NVDA / WETH 0.05%", "nvda", "weth", 1.1e6, 6e6, -2.4)],
    included: [
      { type: "token", id: "rh_usdg", attributes: { address: RH.tokens.USDG.address, symbol: "USDG", name: "Global Dollar" } },
      { type: "token", id: "rh_weth", attributes: { address: RH.tokens.WETH.address, symbol: "WETH", name: "Wrapped Ether" } },
      { type: "token", id: "rh_nvda", attributes: { address: RH.tokens.NVDA?.address || "0x0000000000000000000000000000000000000001", symbol: "NVDA", name: "NVIDIA" } },
    ],
  };
}
function mockState(address) {
  const tick = -197000, sp = tickToSqrt(tick);
  const token0 = { symbol: "WETH", address: RH.tokens.WETH.address, decimals: 18 }, token1 = { symbol: "USDG", address: RH.tokens.USDG.address, decimals: 6 };
  return { pool: address.toLowerCase(), factory: FACTORY, official: true, token0, token1, fee: 500, tickSpacing: 10, liquidity: "1000000000000", sqrtPriceX96: String(Math.floor(sp * Q96)), tick, sp, price: sp * sp * 1e12 };
}
function mockPositions(address) {
  const st = mockState("0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca");
  const p = { tokenId: "4242", pool: st.pool, feePct: 0.05, token0: st.token0, token1: st.token1, tickLower: -198000, tickUpper: -196000, tick: st.tick, inRange: true, closed: false, liquidity: "100000000000000", amount0: 0.5, amount1: 1500, fees0: 0.001, fees1: 3.2, valueUsd: 3100, feesUsd: 6.4, price: { now: st.price, lower: Math.pow(1.0001, -198000) * 1e12, upper: Math.pow(1.0001, -196000) * 1e12, unit: "USDG per WETH" } };
  return { address, total: 1, shown: 1, positions: [p], explorer: RH.explorer, npm: NPM };
}
