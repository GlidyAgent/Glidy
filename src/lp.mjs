// Glidy's LP engine on Solana: Orca Whirlpools (concentrated liquidity). Pools with fee APR, live pool state, a
// wallet's positions (range, amounts, uncollected fees) and unsigned transactions for open / collect / close.
// No keys here: the user's wallet is a no-op signer; only throwaway keys the program needs (the new position mint,
// a temporary wrapped-SOL account) sign on the server, and the wallet adds its own signature.
import {
  address, appendTransactionMessageInstructions, createNoopSigner, createTransactionMessage, getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { closePositionInstructions, decreaseLiquidityInstructions, fetchPositionsForOwner, harvestPositionInstructions, openPositionInstructions, setEnforceTokenBalanceCheck } from "@orca-so/whirlpools";
import { fetchAllMaybeWhirlpool, fetchMaybeWhirlpool, WHIRLPOOL_PROGRAM_ADDRESS } from "@orca-so/whirlpools-client";
import { decreaseLiquidityQuote, increaseLiquidityQuoteA, increaseLiquidityQuoteB, priceToTickIndex, getInitializableTickIndex, tickIndexToPrice } from "@orca-so/whirlpools-core";
import { isSolAddress } from "./sol/base58.mjs";
import { MOCK } from "./sol/mock.mjs";
import { kit, rpc } from "./sol/rpc.mjs";
import { EXPLORER, knownToken, resolveToken, SOL_MINT } from "./sol/tokens.mjs";
import { prices as jupPrices } from "./sol/jup.mjs";
import { geckoGet } from "./onchain.mjs";
import { remember } from "./logos.mjs";
import { formatUnits, parseUnits } from "./units.mjs";

setEnforceTokenBalanceCheck(false); // balances are checked by the Checkpoint, with a clear message, not by an SDK assert
export const PROGRAM = WHIRLPOOL_PROGRAM_ADDRESS;
const DEX_ID = "orca";
const num = (x) => (x == null || x === "" ? null : Number(x));
const Q64 = 2 ** 64;
// kit wants one signer instance per address inside a transaction: keep one no-op signer per wallet
const signers = new Map();
const walletSigner = (owner) => {
  if (!signers.has(owner)) { if (signers.size > 500) signers.clear(); signers.set(owner, createNoopSigner(address(owner))); }
  return signers.get(owner);
};

// ---------- pools ----------
const feeCache = new Map(); // pool → fee % (fee rates rarely change)

/** listPools({ sort: "apr" | "tvl" | "volume", limit }) — Orca Whirlpools on Solana with a fee APR estimate. */
export async function listPools({ sort = "apr", limit = 30 } = {}) {
  const pages = MOCK ? [mockGecko()] : await Promise.all([1, 2].map((p) => geckoGet(`networks/solana/dexes/${DEX_ID}/pools?include=base_token,quote_token&page=${p}`, 60_000).then((r) => r.data).catch(() => null)));
  const tokens = new Map();
  for (const pg of pages) for (const x of pg?.included || []) if (x.type === "token") tokens.set(x.id, x.attributes);
  const rows = [], seen = new Set();
  for (const pg of pages) for (const p of pg?.data || []) {
    const a = p.attributes;
    if (seen.has(a.address)) continue;
    seen.add(a.address);
    rows.push({ a, t0: tokens.get(p.relationships?.base_token?.data?.id) || {}, t1: tokens.get(p.relationships?.quote_token?.data?.id) || {} });
  }
  // fee tier from the chain (GeckoTerminal's Orca names have no fee), one batched read for the ones not cached
  const need = rows.map((r) => r.a.address).filter((x) => !feeCache.has(x) && isSolAddress(x));
  if (need.length && !MOCK) {
    try {
      const accs = await fetchAllMaybeWhirlpool(kit, need.map((x) => address(x)));
      accs.forEach((acc, i) => feeCache.set(need[i], acc.exists ? acc.data.feeRate / 10_000 : null));
    } catch {}
  }
  if (MOCK) rows.forEach((r) => feeCache.set(r.a.address, 0.04));
  const out = [];
  for (const { a, t0, t1 } of rows) {
    const feePct = feeCache.get(a.address);
    if (feePct == null) continue; // not a Whirlpool (or unreadable): Glidy cannot manage it
    for (const t of [t0, t1]) if (t.address && t.image_url) remember(t.address, t.image_url);
    const tvl = num(a.reserve_in_usd), vol = num(a.volume_usd?.h24);
    // A tiny or mis-reported TVL, or bot volume, makes volume × fee ÷ TVL explode: no APR under $10K, flag above 1,000%.
    const rawApr = tvl > 0 && vol != null ? ((vol * feePct) / 100 / tvl) * 365 * 100 : null;
    const aprFlag = rawApr == null ? null : tvl < 10_000 ? "thin" : rawApr > 1000 ? "outlier" : null;
    const tok = (t) => ({ address: t.address || null, symbol: t.symbol || "?", name: t.name || null, image: t.image_url || null, stock: !!knownToken(t.address)?.stock });
    out.push({
      pool: a.address, name: `${t0.symbol || "?"} / ${t1.symbol || "?"} ${feePct}%`, feePct, tvlUsd: tvl, volume24hUsd: vol, feeAprPct: aprFlag ? null : rawApr, aprFlag,
      change24hPct: num(a.price_change_percentage?.h24), base: tok(t0), quote: tok(t1), priceUsd: num(a.base_token_price_usd), createdAt: a.pool_created_at || null,
      txns24h: (a.transactions?.h24?.buys ?? 0) + (a.transactions?.h24?.sells ?? 0),
    });
  }
  const key = { apr: (p) => (p.tvlUsd >= 20000 ? p.feeAprPct ?? 0 : -1), tvl: (p) => p.tvlUsd ?? 0, volume: (p) => p.volume24hUsd ?? 0 }[sort] || ((p) => p.tvlUsd ?? 0);
  out.sort((x, y) => key(y) - key(x));
  return { dex: "Orca Whirlpools", chain: "solana", updatedAt: new Date().toISOString(), pools: out.slice(0, Math.min(60, limit)) };
}

/** poolState(address) → tokens, fee, tick, sqrtPrice and the human price of token A in token B. */
export async function poolState(pool) {
  if (!isSolAddress(pool)) throw Object.assign(new Error("pool must be a Solana address"), { status: 400 });
  if (MOCK) return mockState(pool);
  const acc = await fetchMaybeWhirlpool(kit, address(pool));
  if (!acc.exists) throw Object.assign(new Error("Not an Orca Whirlpool on Solana"), { status: 400 });
  const w = acc.data;
  const [token0, token1] = await Promise.all([resolveToken(w.tokenMintA), resolveToken(w.tokenMintB)]);
  const sp = Number(w.sqrtPrice) / Q64;
  return {
    pool, official: acc.programAddress === PROGRAM, token0, token1, feePct: w.feeRate / 10_000, tickSpacing: w.tickSpacing, tick: w.tickCurrentIndex,
    sqrtPrice: w.sqrtPrice.toString(), liquidity: w.liquidity.toString(), sp, price: sp * sp * 10 ** (token0.decimals - token1.decimals),
  };
}

// ---------- positions ----------
async function usdPrices(mints) {
  if (!mints.length) return {};
  if (MOCK) return Object.fromEntries(mints.map((m) => [m, m === SOL_MINT ? 150 : 1]));
  try { const r = await jupPrices(mints); return Object.fromEntries(Object.entries(r || {}).map(([k, v]) => [k, v?.usdPrice ?? null])); } catch { return {}; }
}
export { usdPrices as tokenPricesUsd };

/** positions({ address }) → the wallet's Orca Whirlpool positions with live amounts, range and uncollected fees. */
export async function positions({ address: owner }) {
  if (!isSolAddress(owner)) throw Object.assign(new Error("Connect a wallet to see positions"), { status: 400 });
  if (MOCK) return mockPositions(owner);
  const all = await fetchPositionsForOwner(kit, address(owner));
  const list = all.flatMap((p) => (p.isPositionBundle ? p.positions : [p])).slice(0, 25);
  const wps = new Map();
  const ids = [...new Set(list.map((p) => p.data.whirlpool))];
  const accs = ids.length ? await fetchAllMaybeWhirlpool(kit, ids) : [];
  accs.forEach((a, i) => a.exists && wps.set(ids[i], a.data));
  const mints = [...new Set([...wps.values()].flatMap((w) => [w.tokenMintA, w.tokenMintB]))];
  const toks = new Map(await Promise.all(mints.map(async (m) => [m, await resolveToken(m).catch(() => ({ symbol: m.slice(0, 4), address: m, decimals: 6 }))])));
  const usd = await usdPrices(mints);
  const signer = walletSigner(owner);
  const out = [];
  for (const p of list) {
    const w = wps.get(p.data.whirlpool);
    if (!w) continue;
    const t0 = toks.get(w.tokenMintA), t1 = toks.get(w.tokenMintB);
    const d = p.data, liq = d.liquidity;
    const est = liq > 0n ? decreaseLiquidityQuote(liq, 0, w.sqrtPrice, d.tickLowerIndex, d.tickUpperIndex) : { tokenEstA: 0n, tokenEstB: 0n };
    let fA = d.feeOwedA, fB = d.feeOwedB;
    try { const h = await harvestPositionInstructions(kit, d.positionMint, { authority: signer }); fA = h.feesQuote.feeOwedA; fB = h.feesQuote.feeOwedB; } catch {}
    const amt0 = Number(est.tokenEstA) / 10 ** t0.decimals, amt1 = Number(est.tokenEstB) / 10 ** t1.decimals;
    const f0 = Number(fA) / 10 ** t0.decimals, f1 = Number(fB) / 10 ** t1.decimals;
    const p0 = usd[w.tokenMintA], p1 = usd[w.tokenMintB];
    const has = p0 != null && p1 != null;
    out.push({
      tokenId: d.positionMint, pool: p.data.whirlpool, feePct: w.feeRate / 10_000, token0: t0, token1: t1,
      tickLower: d.tickLowerIndex, tickUpper: d.tickUpperIndex, tick: w.tickCurrentIndex,
      inRange: liq > 0n ? w.tickCurrentIndex >= d.tickLowerIndex && w.tickCurrentIndex < d.tickUpperIndex : null, closed: liq === 0n,
      liquidity: liq.toString(), amount0: amt0, amount1: amt1, fees0: f0, fees1: f1,
      valueUsd: has ? amt0 * p0 + amt1 * p1 : null, feesUsd: has ? f0 * p0 + f1 * p1 : null,
      price: {
        now: tickIndexToPrice(w.tickCurrentIndex, t0.decimals, t1.decimals), lower: tickIndexToPrice(d.tickLowerIndex, t0.decimals, t1.decimals),
        upper: tickIndexToPrice(d.tickUpperIndex, t0.decimals, t1.decimals), unit: `${t1.symbol} per ${t0.symbol}`,
      },
    });
  }
  out.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  return { address: owner, total: list.length, shown: out.length, positions: out, explorer: EXPLORER };
}

/** position(id, owner) — one of the wallet's positions (re-read live). */
export async function position(id, owner) {
  const r = await positions({ address: owner });
  const p = r.positions.find((x) => x.tokenId === String(id));
  if (!p) throw Object.assign(new Error(`Position ${String(id).slice(0, 6)}… is not in this wallet`), { status: 404 });
  return p;
}

// ---------- planning an add ----------
/**
 * planAdd({ pool, token, amount, widthPct }) — size a position ±widthPct around the live price from one side's amount.
 * `token` is the side the user gives: a symbol or mint of the pool's tokens (SOL means native SOL, wrapped for you).
 */
export async function planAdd({ pool, token, amount, widthPct = 10, slippagePct = 1 }) {
  const st = await poolState(pool);
  const width = Math.min(90, Math.max(0.2, Number(widthPct) || 10)) / 100;
  const ref = String(token || "").trim();
  const is0 = [st.token0.address, st.token0.symbol.toUpperCase()].includes(ref) || [st.token0.address, st.token0.symbol.toUpperCase()].includes(ref.toUpperCase());
  const is1 = [st.token1.address, st.token1.symbol.toUpperCase()].includes(ref) || [st.token1.address, st.token1.symbol.toUpperCase()].includes(ref.toUpperCase());
  if (!is0 && !is1) throw Object.assign(new Error(`Give an amount of ${st.token0.symbol} or ${st.token1.symbol}`), { status: 400 });
  const given = is0 ? st.token0 : st.token1;
  const amountRaw = parseUnits(String(amount), given.decimals);
  if (amountRaw <= 0n) throw Object.assign(new Error("Amount must be above zero"), { status: 400 });
  const d0 = st.token0.decimals, d1 = st.token1.decimals;
  let tl = getInitializableTickIndex(priceToTickIndex(st.price * (1 - width), d0, d1), st.tickSpacing, false);
  let tu = getInitializableTickIndex(priceToTickIndex(st.price * (1 + width), d0, d1), st.tickSpacing, true);
  if (tl >= st.tick) tl -= st.tickSpacing;
  if (tu <= st.tick) tu += st.tickSpacing;
  const slip = Math.round(slippagePct * 100);
  const q = is0 ? increaseLiquidityQuoteA(amountRaw, slip, BigInt(st.sqrtPrice), tl, tu) : increaseLiquidityQuoteB(amountRaw, slip, BigInt(st.sqrtPrice), tl, tu);
  return {
    pool: st.pool, state: st, tickLower: tl, tickUpper: tu, widthPct: width * 100,
    amount0: q.tokenEstA, amount1: q.tokenEstB, max0: q.tokenMaxA, max1: q.tokenMaxB,
    amount0Text: formatUnits(q.tokenEstA, d0), amount1Text: formatUnits(q.tokenEstB, d1), given: given.symbol,
    price: { now: st.price, lower: tickIndexToPrice(tl, d0, d1), upper: tickIndexToPrice(tu, d0, d1), unit: `${st.token1.symbol} per ${st.token0.symbol}` },
  };
}

// ---------- transactions ----------
/** Compile instructions into one unsigned (wallet) / partly signed (throwaway keys) v0 transaction, base64. */
async function toTx(instructions, owner) {
  if (MOCK) return Buffer.from(JSON.stringify({ owner, n: instructions.length })).toString("base64");
  const { value: bh } = await kit.getLatestBlockhash().send();
  const msg = pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(walletSigner(owner), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => appendTransactionMessageInstructions(instructions, m));
  const signed = await partiallySignTransactionMessageWithSigners(msg);
  return { tx: getBase64EncodedWireTransaction(signed), lastValidBlockHeight: Number(bh.lastValidBlockHeight) };
}

/** buildAddTxs(plan, owner) → [{ label, tx }] opening a new position with the planned range and amounts. */
export async function buildAddTxs(plan, owner, slippagePct = 1) {
  const st = plan.state;
  const label = `Add ${plan.amount0Text} ${st.token0.symbol} + ${plan.amount1Text} ${st.token1.symbol} (±${plan.widthPct.toFixed(1)}%)`;
  if (MOCK) return [{ label, tx: await toTx([1, 2, 3], owner) }];
  const r = await openPositionInstructions(kit, address(st.pool), { tokenMaxA: plan.max0, tokenMaxB: plan.max1 }, plan.price.lower, plan.price.upper,
    { slippageToleranceBps: Math.round(slippagePct * 100), funder: walletSigner(owner) });
  const t = await toTx(r.instructions, owner);
  return [{ label, ...t, positionMint: r.positionMint, rentSol: Number(r.initializationCost) / 1e9 }];
}

export async function buildCollectTx(p, owner) {
  const label = `Collect fees from ${p.token0.symbol}/${p.token1.symbol}`;
  if (MOCK) return { label, tx: await toTx([1], owner) };
  const r = await harvestPositionInstructions(kit, address(p.tokenId), { authority: walletSigner(owner) });
  return { label, ...(await toTx(r.instructions, owner)) };
}

export async function buildRemoveTx(p, owner, { pct = 100, slippagePct = 1 } = {}) {
  const label = pct >= 100 ? `Close ${p.token0.symbol}/${p.token1.symbol} and collect fees` : `Remove ${pct}% of ${p.token0.symbol}/${p.token1.symbol}`;
  if (MOCK) return { label, tx: await toTx([1, 2], owner) };
  const cfg = { slippageToleranceBps: Math.round(slippagePct * 100), authority: walletSigner(owner) };
  const r = pct >= 100
    ? await closePositionInstructions(kit, address(p.tokenId), cfg)
    : await decreaseLiquidityInstructions(kit, address(p.tokenId), { liquidity: (BigInt(p.liquidity) * BigInt(Math.round(pct * 100))) / 10_000n }, cfg);
  return { label, ...(await toTx(r.instructions, owner)) };
}

/** balances the plan needs vs what the wallet holds (native SOL for the SOL side, plus a little for fees and rent). */
export async function planBalances(plan, owner) {
  const st = plan.state, rows = [];
  for (const [t, amt] of [[st.token0, plan.max0], [st.token1, plan.max1]]) {
    if (!amt || amt === 0n) continue;
    const isSol = t.address === SOL_MINT;
    let have = null;
    try {
      if (MOCK) have = 10n ** 12n;
      else if (isSol) have = BigInt((await rpc("getBalance", [owner])).value);
      else { const r = await rpc("getTokenAccountsByOwner", [owner, { mint: t.address }, { encoding: "jsonParsed" }]); have = (r?.value || []).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n); }
    } catch {}
    rows.push({ symbol: t.symbol, need: amt, have, decimals: t.decimals, ok: have == null ? null : have >= amt });
  }
  return rows;
}

// ---------- mock ----------
const MOCK_POOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
function mockGecko() {
  const mk = (addr, b, q, tvl, vol, ch) => ({ attributes: { address: addr, name: `${b.toUpperCase()} / ${q.toUpperCase()}`, reserve_in_usd: String(tvl), volume_usd: { h24: String(vol) }, price_change_percentage: { h24: String(ch) }, base_token_price_usd: "150", transactions: { h24: { buys: 10, sells: 9 } } }, relationships: { base_token: { data: { id: "s_" + b } }, quote_token: { data: { id: "s_" + q } } } });
  return {
    data: [mk(MOCK_POOL, "sol", "usdc", 1.8e7, 8.7e7, 1.2), mk("6R4r93V5fcMzc13CL2enEepDSYcr4Qx3ptZBDwudTXCo", "nvdax", "usdc", 2.5e5, 2.7e6, -2.4)],
    included: [
      { type: "token", id: "s_sol", attributes: { address: SOL_MINT, symbol: "SOL", name: "Solana" } },
      { type: "token", id: "s_usdc", attributes: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", name: "USD Coin" } },
      { type: "token", id: "s_nvdax", attributes: { address: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", symbol: "NVDAx", name: "NVIDIA xStock" } },
    ],
  };
}
function mockState(pool) {
  const token0 = { symbol: "SOL", address: SOL_MINT, decimals: 9 }, token1 = { symbol: "USDC", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 };
  const tick = -18970, sp = Math.pow(1.0001, tick / 2);
  return { pool, official: true, token0, token1, feePct: 0.04, tickSpacing: 4, tick, sqrtPrice: BigInt(Math.floor(sp * Q64)).toString(), liquidity: "1000000000000", sp, price: sp * sp * 1e3 };
}
function mockPositions(owner) {
  const st = mockState(MOCK_POOL);
  const p = { tokenId: "4242Pos1tionM1ntxxxxxxxxxxxxxxxxxxxxxxxxxxx", pool: MOCK_POOL, feePct: 0.04, token0: st.token0, token1: st.token1, tickLower: -19970, tickUpper: -17970, tick: st.tick, inRange: true, closed: false, liquidity: "100000000000", amount0: 2, amount1: 300, fees0: 0.01, fees1: 1.5, valueUsd: 600, feesUsd: 3, price: { now: st.price, lower: st.price * 0.9, upper: st.price * 1.1, unit: "USDC per SOL" } };
  return { address: owner, total: 1, shown: 1, positions: [p], explorer: EXPLORER };
}
