// The Glidy Checkpoint for liquidity: every add is checked before a ticket exists. A failed check blocks it; a warning
// shows on the ticket. Pool facts come from the chain (factory, price, ticks), depth and volume from GeckoTerminal.
import { tokenHealth } from "./health.mjs";
import { buildAddTxs, listPools, planAdd, planBalances, tokenPricesUsd, WETH } from "./lp.mjs";
import { checkPolicy } from "./policy.mjs";
import { simulate } from "./rpc.mjs";
import { formatUnits } from "./units.mjs";

const pct = (x, d = 2) => `${Number(x).toFixed(d)}%`;
const usd = (x) => (x == null ? "–" : x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}K` : `$${x.toFixed(2)}`);

/** Impermanent loss (vs holding) when price moves by factor r, for a full-range position. Concentrated ranges lose more. */
const ilFull = (r) => 1 - (2 * Math.sqrt(r)) / (1 + r);

/**
 * gateAdd({ pool, token, amount, widthPct, sender, slippagePct }) → { status, checks[], plan }
 * sender (a wallet) turns on balance checks and the exact-transaction simulation.
 */
export async function gateAdd({ pool, token, amount, widthPct = 10, sender, slippagePct = 1 }) {
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });
  let plan;
  try {
    plan = await planAdd({ pool, token, amount, widthPct });
  } catch (e) {
    add("plan", "Position", "fail", String(e.message || e));
    return finish(checks);
  }
  const st = plan.state;
  add("pool", "Pool", st.official ? "pass" : "fail", st.official ? `Uniswap v3 ${st.token0.symbol}/${st.token1.symbol} ${(st.fee / 10000).toFixed(2)}% on Robinhood Chain` : "This pool was not created by the Uniswap v3 factory. Glidy only adds liquidity to official pools.");

  // depth and activity from the pool list
  const listed = (await listPools({ sort: "tvl", limit: 60 }).catch(() => ({ pools: [] }))).pools.find((p) => p.pool.toLowerCase() === st.pool);
  const tvl = listed?.tvlUsd ?? null, vol = listed?.volume24hUsd ?? null;
  if (tvl == null) add("depth", "Pool depth", "warn", "Not in the top Uniswap v3 pools by depth: check volume and liquidity yourself.");
  else add("depth", "Pool depth", tvl < 10_000 ? "fail" : tvl < 100_000 ? "warn" : "pass", `${usd(tvl)} in the pool${tvl < 10_000 ? ": too thin, prices are easy to push around" : ""}`);
  if (vol != null && tvl) {
    const apr = listed.feeAprPct;
    if (listed.aprFlag === "outlier") add("fees", "Fee income", "warn", `${usd(vol)} traded in 24h against only ${usd(tvl)} of liquidity. Volume this far above depth usually means bots or wash trading: do not count on that APR.`);
    else add("fees", "Fee income", vol < 1000 ? "warn" : "info", `${usd(vol)} traded in 24h${apr != null ? `, about ${pct(apr, 1)} APR for full-range liquidity. A ±${plan.widthPct.toFixed(0)}% range earns more while in range` : ""}.`);
  }

  // tokens
  for (const t of [st.token0, st.token1]) {
    if (t.address.toLowerCase() === WETH) continue;
    try {
      const h = await tokenHealth("robinhood", t.address);
      if (h.known) continue;
      const worst = h.flags.some((f) => f.severity === "fail") ? "fail" : h.flags.some((f) => f.severity === "warn") ? "warn" : "pass";
      add(`token_${t.symbol}`, `Token: ${t.symbol}`, worst, `${h.summary} ${h.flags.filter((f) => f.severity !== "info").map((f) => f.text).join(" ")}`.trim());
    } catch (e) { add(`token_${t.symbol}`, `Token: ${t.symbol}`, "warn", `Could not read the token: ${e.message}`); }
  }

  // range vs recent volatility, and what a move to the edge costs
  const move = Math.abs(listed?.change24hPct ?? 0);
  add("range", "Range", move > plan.widthPct ? "warn" : "pass",
    `${fmt(plan.price.lower)} – ${fmt(plan.price.upper)} ${plan.price.unit} (now ${fmt(plan.price.now)})${move ? `. Price moved ${pct(move, 1)} in 24h${move > plan.widthPct ? ": likely to leave this range soon and stop earning" : ""}` : ""}.`);
  const edge = 1 + plan.widthPct / 100;
  const ilEdge = ilFull(edge) * Math.min(20, Math.sqrt(100 / plan.widthPct)); // rough concentration multiplier
  add("il", "Impermanent loss", ilEdge > 0.05 ? "warn" : "info", `If price reaches the edge of the range, expect roughly ${pct(ilEdge * 100, 2)} less than just holding (before fees).`);

  // value and policy
  const prices = await tokenPricesUsd([st.token0.address, st.token1.address]);
  const v0 = prices[st.token0.address.toLowerCase()], v1 = prices[st.token1.address.toLowerCase()];
  const valueUsd = v0 != null && v1 != null ? (Number(plan.amount0) / 10 ** st.token0.decimals) * v0 + (Number(plan.amount1) / 10 ** st.token1.decimals) * v1 : null;
  const policy = await checkPolicy({ address: sender, chain: "robinhood", tokens: [st.token0.address, st.token1.address], usd: valueUsd, slippagePct });

  // balances and simulation
  if (sender) {
    const bal = await planBalances(plan, sender).catch(() => []);
    const short = bal.filter((b) => b.ok === false);
    add("balance", "Balance", short.length ? "warn" : "pass", short.length ? `You need ${short.map((b) => `${formatUnits(b.need, b.decimals)} ${b.symbol} (have ${formatUnits(b.have, b.decimals)})`).join(" and ")}. Swap or top up first.` : `You hold ${bal.map((b) => `${formatUnits(b.need, b.decimals)} ${b.symbol}`).join(" + ")}.`);
    if (!short.length) {
      const txs = await buildAddTxs(plan, sender, slippagePct);
      if (txs.length > 1) add("simulation", "Simulation", "info", `${txs.length - 1} approval${txs.length > 2 ? "s" : ""} first, then the deposit. The deposit is simulated again right before you sign it.`);
      else {
        const sim = await simulate("robinhood", { from: sender, ...txs[0] });
        add("simulation", "Simulation", sim.ok ? "pass" : "fail", sim.ok ? "The exact deposit succeeds from your wallet right now." : `Fails in simulation: ${sim.error}`);
      }
    }
  } else add("simulation", "Simulation", "info", "Connect a wallet to check balances and simulate the deposit.");

  checks.push(...policy.rows);
  return finish(checks, {
    pool: st.pool, token0: st.token0, token1: st.token1, feePct: st.fee / 10000, widthPct: plan.widthPct,
    amount0: plan.amount0Text, amount1: plan.amount1Text, tickLower: plan.tickLower, tickUpper: plan.tickUpper,
    price: plan.price, valueUsd, tvlUsd: tvl, volume24hUsd: vol, feeAprPct: listed?.feeAprPct ?? null,
  });
}

const fmt = (x) => (x >= 1000 ? x.toLocaleString("en-US", { maximumFractionDigits: 2 }) : x >= 1 ? x.toFixed(4) : x.toPrecision(4));

function finish(checks, plan = null) {
  const status = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "pass";
  return { status, chain: "robinhood", kind: "lp_add", plan, checks, checkedAt: new Date().toISOString() };
}
