// LP engine in mock mode: pool ranking, sizing, positions, the Checkpoint and tickets (Orca Whirlpools on Solana).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// A fresh data dir per run, so daily caps and used tickets never carry over between runs.
process.env.GLIDY_DATA = mkdtempSync(path.join(tmpdir(), "glidy-lp-test-"));
const { buildAddTxs, buildCollectTx, buildRemoveTx, listPools, planAdd, positions } = await import("../src/lp.mjs");
const { gateAdd } = await import("../src/lpgate.mjs");
const { buildTicket, prepareLp } = await import("../src/intents.mjs");
const { parseAndRun } = await import("../src/agent.mjs");

const POOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const ME = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const POS = "4242Pos1tionM1ntxxxxxxxxxxxxxxxxxxxxxxxxxxx";

test("pools are ranked by fee APR with depth and a fee tier from the chain", async () => {
  const r = await listPools({ sort: "apr" });
  assert.ok(r.pools.length >= 2);
  assert.equal(r.dex, "Orca Whirlpools");
  assert.ok(r.pools[0].feeAprPct >= (r.pools[1].feeAprPct ?? 0));
  assert.equal(r.pools[0].feePct, 0.04);
  assert.ok(r.pools.some((p) => /SOL \/ USDC/.test(p.name)));
});

test("planAdd sizes both sides and snaps the range to the tick spacing", async () => {
  const p = await planAdd({ pool: POOL, token: "SOL", amount: "0.5", widthPct: 5 });
  assert.equal(p.given, "SOL");
  assert.ok(Number(p.amount0Text) > 0.49 && Number(p.amount0Text) <= 0.5);
  assert.ok(Number(p.amount1Text) > 0);
  assert.equal(Math.abs(p.tickLower % 4), 0);
  assert.equal(Math.abs(p.tickUpper % 4), 0);
  assert.ok(p.price.lower < p.price.now && p.price.now < p.price.upper);
  assert.ok(p.max0 >= p.amount0 && p.max1 >= p.amount1);
});

test("planAdd from the USDC side, and refuses a token not in the pool", async () => {
  const p = await planAdd({ pool: POOL, token: "usdc", amount: "100", widthPct: 10 });
  assert.equal(p.given, "USDC");
  assert.ok(Number(p.amount0Text) > 0);
  await assert.rejects(planAdd({ pool: POOL, token: "JUP", amount: "1" }), /SOL or USDC/);
});

test("positions, add, collect and remove give one base64 transaction each", async () => {
  const r = await positions({ address: ME });
  assert.equal(r.positions.length, 1);
  const p = r.positions[0];
  assert.equal(p.inRange, true);
  const add = await buildAddTxs(await planAdd({ pool: POOL, token: "SOL", amount: "0.5" }), ME);
  assert.equal(add.length, 1);
  for (const t of [add[0], await buildCollectTx(p, ME), await buildRemoveTx(p, ME, { pct: 50 })]) assert.ok(Buffer.from(t.tx, "base64").length > 0);
  assert.match((await buildRemoveTx(p, ME, { pct: 50 })).label, /Remove 50%/);
});

test("LP Checkpoint passes a normal deposit and enforces the per-trade cap", async () => {
  const ok = await gateAdd({ pool: POOL, token: "SOL", amount: "0.5", widthPct: 10 });
  assert.notEqual(ok.status, "fail");
  assert.ok(ok.checks.some((c) => c.id === "pool" && c.status === "pass"));
  const big = await gateAdd({ pool: POOL, token: "SOL", amount: "50", widthPct: 10 });
  assert.equal(big.status, "fail");
  assert.ok(big.checks.some((c) => c.id === "per_trade" && c.status === "fail"));
});

test("LP tickets build for add and collect", async () => {
  const t = await prepareLp({ action: "lp_add", pool: POOL, token: "SOL", amount: "0.5", widthPct: 10 }, { owner: ME });
  assert.equal(t.ok, true);
  const b = await buildTicket(t.id, ME);
  assert.equal(b.ok, true);
  assert.equal(b.chain, "solana");
  assert.equal(b.txs.length, 1);
  const c = await prepareLp({ action: "lp_collect", tokenId: POS }, { owner: ME });
  const bc = await buildTicket(c.id, ME);
  assert.equal(bc.txs.length, 1);
});

test("command mode understands LP requests", async () => {
  const pools = await parseAndRun("best pools", { address: null });
  assert.match(pools, /Orca Whirlpools/);
  const add = await parseAndRun(`add 0.5 SOL to ${POOL} 5%`, { address: ME, owner: ME, surface: "chat" });
  assert.match(add, /Ticket ready: add/);
  const pos = await parseAndRun("my positions", { address: ME, owner: ME, surface: "chat" });
  assert.match(pos, /4242Pos/);
  const col = await parseAndRun(`collect ${POS}`, { address: ME, owner: ME, surface: "chat" });
  assert.match(col, /collect fees/);
});
