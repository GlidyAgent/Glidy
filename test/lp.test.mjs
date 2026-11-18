// LP engine in mock mode: pool ranking, sizing, positions, the Checkpoint and ticket calldata.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// A fresh data dir per run, so daily caps and used tickets never carry over between runs.
process.env.GLIDY_DATA = mkdtempSync(path.join(tmpdir(), "glidy-lp-test-"));
const { buildAddTxs, buildCollectTx, buildRemoveTx, listPools, NPM, planAdd, positions } = await import("../src/lp.mjs");
const { gateAdd } = await import("../src/lpgate.mjs");
const { buildTicket, prepareLp } = await import("../src/intents.mjs");
const { parseAndRun } = await import("../src/agent.mjs");

const POOL = "0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca";
const ME = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

test("pools are ranked by fee APR with depth", async () => {
  const r = await listPools({ sort: "apr" });
  assert.ok(r.pools.length >= 2);
  assert.ok(r.pools[0].feeAprPct >= r.pools[1].feeAprPct);
  assert.equal(r.pools[0].feePct, 0.05);
});

test("planAdd sizes both sides and snaps the range to ticks", async () => {
  const p = await planAdd({ pool: POOL, token: "ETH", amount: "0.1", widthPct: 5 });
  assert.equal(p.amount0Text, "0.1");
  assert.ok(Number(p.amount1Text) > 0);
  assert.equal(Math.abs(p.tickLower % 10), 0);
  assert.equal(Math.abs(p.tickUpper % 10), 0);
  assert.ok(p.price.lower < p.price.now && p.price.now < p.price.upper);
});

test("add pays WETH in native ETH through multicall + refundETH", async () => {
  const txs = await buildAddTxs(await planAdd({ pool: POOL, token: "ETH", amount: "0.1", widthPct: 5 }), ME);
  const mint = txs.at(-1);
  assert.equal(mint.to, NPM);
  assert.ok(BigInt(mint.value) === 10n ** 17n);
  assert.ok(mint.data.startsWith("0xac9650d8")); // multicall
  assert.ok(txs.some((t) => t.label.startsWith("Approve") && t.label.includes("USDG")));
});

test("positions, collect and remove calldata", async () => {
  const r = await positions({ address: ME });
  assert.equal(r.positions.length, 1);
  const p = r.positions[0];
  assert.equal(p.inRange, true);
  const c = buildCollectTx(p, ME);
  assert.ok(c.data.startsWith("0xac9650d8") && c.data.includes("fc6f7865")); // collect, then unwrap + sweep
  const direct = buildCollectTx(p, ME, { unwrap: false });
  assert.ok(direct.data.startsWith("0xfc6f7865"));
  const rm = buildRemoveTx(p, ME, { pct: 50 });
  assert.ok(rm.data.includes("0c49ccbe")); // decreaseLiquidity
});

test("LP Checkpoint passes a normal deposit and enforces the per-trade cap", async () => {
  const ok = await gateAdd({ pool: POOL, token: "ETH", amount: "0.1", widthPct: 10 });
  assert.notEqual(ok.status, "fail");
  assert.ok(ok.checks.some((c) => c.id === "pool" && c.status === "pass"));
  const big = await gateAdd({ pool: POOL, token: "ETH", amount: "5", widthPct: 10 });
  assert.equal(big.status, "fail");
  assert.ok(big.checks.some((c) => c.id === "per_trade" && c.status === "fail"));
});

test("LP tickets build for add and collect", async () => {
  const t = await prepareLp({ action: "lp_add", pool: POOL, token: "ETH", amount: "0.1", widthPct: 10 }, { owner: ME });
  assert.equal(t.ok, true);
  const b = await buildTicket(t.id, ME);
  assert.equal(b.ok, true);
  assert.equal(b.txs.at(-1).to, NPM);
  const c = await prepareLp({ action: "lp_collect", tokenId: "4242" }, { owner: ME });
  const bc = await buildTicket(c.id, ME);
  assert.equal(bc.txs.length, 1);
});

test("command mode understands LP requests", async () => {
  const pools = await parseAndRun("best pools", { address: null });
  assert.match(pools, /Uniswap v3 pools/);
  const add = await parseAndRun(`add 0.1 ETH to ${POOL} 5%`, { address: ME, owner: ME, surface: "chat" });
  assert.match(add, /Ticket ready: add/);
  const pos = await parseAndRun("my positions", { address: ME, owner: ME, surface: "chat" });
  assert.match(pos, /#4242/);
});
