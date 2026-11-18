// Prepared actions. A chat ticket lives 10 minutes; an API confirmationId lives 120 seconds. The id itself is a sealed
// token (HMAC over the exact parameters, owner and expiry), so it cannot be altered and needs no server memory.
// Both are single use (tracked per instance and in the data dir). Executing never trusts what was prepared: it re-quotes, re-runs the
// Checkpoint and the policy, and builds calldata from that fresh route.
import { randomBytes } from "node:crypto";
import { gateSwap, quoteSwap } from "./sol/gate.mjs";
import { buildSwap } from "./sol/jup.mjs";
import { decode58, isSolAddress } from "./sol/base58.mjs";
import { EXPLORER } from "./sol/tokens.mjs";
import { journal } from "./journal.mjs";
import { recordUsage } from "./policy.mjs";
import { seal, unseal } from "./seal.mjs";
import { update } from "./store.mjs";
import { gateAdd } from "./lpgate.mjs";
import { buildAddTxs, buildCollectTx, buildRemoveTx, planAdd, position } from "./lp.mjs";

const TICKET_MS = 10 * 60_000, CONFIRM_MS = 120_000;
const PREFIX = { ticket: "tk_", confirmation: "cf_" };
const used = new Map(); // ref → expiry

/** prepareSwap(params, { kind: "ticket" | "confirmation", owner }) → Checkpoint result plus id, or a refusal. */
export async function prepareSwap(params, { kind = "ticket", owner = null } = {}) {
  const p = {
    chain: "solana",
    tokenIn: String(params.tokenIn || "SOL"),
    tokenOut: String(params.tokenOut || ""),
    amount: String(params.amount ?? params.amountIn ?? ""),
    slippagePct: Number(params.slippagePct ?? 1),
    sender: params.sender || null,
  };
  if (![0.5, 1, 2, 3, 5].includes(p.slippagePct)) p.slippagePct = Math.min(5, Math.max(0.1, p.slippagePct || 1));
  const who = owner || p.sender;
  const gate = await gateSwap(p);
  if (gate.status === "fail") {
    await journal({ owner: who, kind: "swap", stage: "prepare", outcome: "blocked", reason: gate.checks.filter((c) => c.status === "fail").map((c) => c.label).join(", "), params: p });
    return { ok: false, reason: "Blocked by the Glidy Checkpoint", gate };
  }
  const ref = randomBytes(6).toString("hex");
  const ttl = kind === "ticket" ? TICKET_MS : CONFIRM_MS;
  const id = PREFIX[kind] + seal("intent", { k: kind, r: ref, p, o: who ? String(who) : null }, ttl);
  await journal({ owner: who, kind: "swap", stage: "prepare", outcome: "ready", ref, params: p, gateStatus: gate.status });
  return { ok: true, id, ref, kind, expiresAt: new Date(Date.now() + ttl).toISOString(), gate };
}

function open(id) {
  const kind = String(id).startsWith("tk_") ? "ticket" : String(id).startsWith("cf_") ? "confirmation" : null;
  if (!kind) throw Object.assign(new Error("Unknown id"), { status: 404 });
  const x = unseal("intent", String(id).slice(3));
  if (x.k !== kind) throw Object.assign(new Error("Unknown id"), { status: 404 });
  return { kind, ref: x.r, params: x.p, owner: x.o, expiresAt: x.exp };
}

export function getIntent(id) {
  try {
    const x = open(id);
    return { kind: x.kind, ref: x.ref, params: x.params, expiresAt: new Date(x.expiresAt).toISOString(), used: used.has(x.ref) };
  } catch { return null; }
}

async function take(id, { owner } = {}) {
  const x = open(id);
  if (owner && x.owner && owner !== x.owner) throw Object.assign(new Error("This ticket belongs to another wallet"), { status: 403 });
  const now = Date.now();
  for (const [k, exp] of used) if (exp < now) used.delete(k);
  let seen = used.has(x.ref);
  await update("used-intents.json", {}, (all) => {
    for (const [k, exp] of Object.entries(all)) if (exp < now) delete all[k];
    if (all[x.ref]) seen = true; else all[x.ref] = x.expiresAt;
  }).catch(() => {});
  if (seen) throw Object.assign(new Error("This id was already used"), { status: 409 });
  used.set(x.ref, x.expiresAt);
  return x;
}

/**
 * buildTicket(id, sender) — for the browser: re-check on the current pool, then return the unsigned transactions
 * (an approval if needed, then the swap). The wallet signs; the server never holds a key.
 */
export async function buildTicket(id, sender) {
  if (!isSolAddress(sender)) throw Object.assign(new Error("Connect a wallet first"), { status: 400 });
  const x = await take(id, { owner: sender });
  if (String(x.params.action || "").startsWith("lp_")) return buildLpTicket(x, sender);
  const p = { ...x.params, sender };
  const gate = await gateSwap(p);
  if (gate.status === "fail") {
    await journal({ owner: sender, kind: "swap", stage: "build", outcome: "blocked", ref: x.ref, reason: "Checkpoint failed on re-check", params: p });
    return { ok: false, reason: "Checkpoint failed on the re-check, nothing was built", gate };
  }
  // A fresh quote, then Jupiter builds the transaction for this wallet. Its minimum-out comes from your slippage.
  let q = await quoteSwap(p);
  let built;
  try { built = await buildSwap({ quoteResponse: q.quote, user: sender }); }
  catch (e) {
    // Some venues (often RFQ / market-maker routes) cannot be built for every wallet: re-quote without them, once.
    const venues = [...new Set((q.quote.routePlan || []).map((r) => r.swapInfo?.label).filter(Boolean))];
    if (!venues.length) throw e;
    q = await quoteSwap({ ...p, excludeDexes: venues });
    built = await buildSwap({ quoteResponse: q.quote, user: sender });
  }
  if (!built?.swapTransaction) throw new Error("Jupiter did not return a transaction");
  await recordUsage(sender, gate.swap?.inUsd || 0);
  await journal({ owner: sender, kind: "swap", stage: "build", outcome: "built", ref: x.ref, params: p, gateStatus: gate.status });
  return {
    ok: true, ref: x.ref, chain: "solana", explorer: EXPLORER, minOutRaw: q.quote.otherAmountThreshold || null,
    txs: [{ label: `Swap ${q.amount} ${q.tokenIn.symbol} → ${q.tokenOut.symbol}`, tx: built.swapTransaction, lastValidBlockHeight: built.lastValidBlockHeight }],
    gate,
  };
}

/** executeIntent(id, { dryRun, owner }) — API/MCP path. Glidy holds no keys, so live execution returns unsigned txs. */
export async function executeIntent(id, { dryRun = true, owner, sender } = {}) {
  if (!dryRun) return buildTicket(id, sender || open(id).params.sender);
  const x = await take(id, { owner });
  const gate = await gateSwap(x.params);
  await journal({ owner: owner || x.owner, kind: "swap", stage: "execute", outcome: "dry_run", ref: x.ref, params: x.params, gateStatus: gate.status });
  return { ok: gate.status !== "fail", dryRun: true, note: "Checked and logged, nothing was sent.", gate };
}

export async function markSent(id, { owner, hash }) {
  let sigOk = false;
  try { sigOk = decode58(String(hash || "")).length === 64; } catch {}
  if (!sigOk) throw Object.assign(new Error("Invalid transaction signature"), { status: 400 });
  let x = null;
  try { x = open(id); } catch {}
  await journal({ owner, kind: x?.params?.action || "swap", stage: "sent", outcome: "sent", ref: x?.ref, hash, params: x?.params });
  return { ok: true };
}

// ---------- liquidity tickets ----------
/** prepareLp({ action: "lp_add" | "lp_collect" | "lp_remove", … }, { owner }) → Checkpoint (for adds) plus a ticket id. */
export async function prepareLp(params, { kind = "ticket", owner = null } = {}) {
  const action = String(params.action || "lp_add");
  const who = owner || params.sender || null;
  let p, gate;
  if (action === "lp_add") {
    p = { action, pool: String(params.pool || ""), token: String(params.token || "SOL"), amount: String(params.amount ?? ""), widthPct: Number(params.widthPct ?? 10), slippagePct: Number(params.slippagePct ?? 1), sender: who };
    gate = await gateAdd(p);
  } else if (action === "lp_collect" || action === "lp_remove") {
    if (!who) throw Object.assign(new Error("Connect a wallet first"), { status: 401 });
    p = { action, tokenId: String(params.tokenId || ""), pct: Math.min(100, Math.max(1, Number(params.pct ?? 100))), slippagePct: Number(params.slippagePct ?? 1), sender: who };
    const pos = await position(p.tokenId, who);
    const checks = [{ id: "owner", label: "Position", status: "pass", detail: `${pos.tokenId.slice(0, 4)}…${pos.tokenId.slice(-4)} ${pos.token0.symbol}/${pos.token1.symbol} ${pos.feePct}% belongs to your wallet` }];
    if (action === "lp_collect") checks.push({ id: "fees", label: "Fees", status: pos.fees0 + pos.fees1 > 0 ? "pass" : "warn", detail: `${fmtN(pos.fees0)} ${pos.token0.symbol} + ${fmtN(pos.fees1)} ${pos.token1.symbol} ready${pos.feesUsd != null ? ` (~$${pos.feesUsd.toFixed(2)})` : ""}` });
    else checks.push({ id: "amounts", label: "You receive", status: "pass", detail: `about ${fmtN((pos.amount0 * p.pct) / 100)} ${pos.token0.symbol} + ${fmtN((pos.amount1 * p.pct) / 100)} ${pos.token1.symbol} plus fees` }, { id: "range", label: "Range", status: "info", detail: pos.inRange ? "In range and earning." : "Out of range: not earning fees right now." });
    gate = { status: checks.some((c) => c.status === "warn") ? "warn" : "pass", chain: "solana", kind: action, position: pos, checks, checkedAt: new Date().toISOString() };
  } else throw Object.assign(new Error("Unknown liquidity action"), { status: 400 });
  if (gate.status === "fail") {
    await journal({ owner: who, kind: action, stage: "prepare", outcome: "blocked", reason: gate.checks.filter((c) => c.status === "fail").map((c) => c.label).join(", "), params: p });
    return { ok: false, reason: "Blocked by the Glidy Checkpoint", gate };
  }
  const ref = randomBytes(6).toString("hex");
  const ttl = kind === "ticket" ? TICKET_MS : CONFIRM_MS;
  const id = PREFIX[kind] + seal("intent", { k: kind, r: ref, p, o: who ? String(who) : null }, ttl);
  await journal({ owner: who, kind: action, stage: "prepare", outcome: "ready", ref, params: p, gateStatus: gate.status });
  return { ok: true, id, ref, kind, expiresAt: new Date(Date.now() + ttl).toISOString(), gate };
}

const fmtN = (x) => (x >= 1000 ? x.toLocaleString("en-US", { maximumFractionDigits: 2 }) : x >= 1 ? x.toFixed(4) : x > 0 ? x.toPrecision(4) : "0");

async function buildLpTicket(x, sender) {
  const p = { ...x.params, sender };
  const txs = [];
  let gate = null;
  if (p.action === "lp_add") {
    gate = await gateAdd(p);
    if (gate.status === "fail") {
      await journal({ owner: sender, kind: p.action, stage: "build", outcome: "blocked", ref: x.ref, params: p });
      return { ok: false, reason: "Checkpoint failed on the re-check, nothing was built", gate };
    }
    txs.push(...(await buildAddTxs(await planAdd(p), sender, p.slippagePct)));
    if (gate.plan?.valueUsd) await recordUsage(sender, gate.plan.valueUsd);
  } else {
    const pos = await position(p.tokenId, sender);
    txs.push(p.action === "lp_collect" ? await buildCollectTx(pos, sender) : await buildRemoveTx(pos, sender, { pct: p.pct, slippagePct: p.slippagePct }));
  }
  await journal({ owner: sender, kind: p.action, stage: "build", outcome: "built", ref: x.ref, params: p });
  return { ok: true, ref: x.ref, chain: "solana", explorer: EXPLORER, txs, gate };
}
