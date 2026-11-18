// Solana JSON-RPC with fallback. SOLANA_RPC (a private endpoint such as Helius) goes first; the public endpoints back it
// up. Public RPCs rate-limit and refuse some heavy calls (403), so the next endpoint is tried on 403/429.
import { createDefaultRpcTransport, createSolanaRpcFromTransport } from "@solana/kit";
import { MOCK, mockRpc } from "./mock.mjs";

export const RPC_URLS = [...new Set([process.env.SOLANA_RPC, "https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"].filter(Boolean))];
let id = 0;
const retryable = (status) => status === 403 || status === 429 || status >= 500;

export async function rpc(method, params = []) {
  if (MOCK) return mockRpc(method, params);
  let lastErr;
  for (const url of RPC_URLS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try { res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(15000), headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) }); }
      catch (e) { lastErr = e; break; }
      if (retryable(res.status)) { lastErr = new Error("Solana RPC is busy, try again in a moment"); if (res.status === 429 && attempt === 0) { await new Promise((r) => setTimeout(r, 500)); continue; } break; }
      const j = await res.json().catch(() => ({}));
      if (j.error) throw Object.assign(new Error(j.error.message || "Solana RPC error"), { rpc: j.error });
      if (!res.ok) { lastErr = new Error(`Solana RPC returned ${res.status}`); break; }
      return j.result;
    }
  }
  throw lastErr || new Error("No Solana RPC answered");
}

/** kit — an @solana/kit RPC client over the same endpoints, for SDKs (Orca) that expect one. */
const transports = RPC_URLS.map((url) => createDefaultRpcTransport({ url }));
const fallbackTransport = async (req) => {
  let lastErr;
  for (const t of transports) {
    try { return await t(req); }
    catch (e) { lastErr = e; const s = e?.context?.statusCode; if (!(s && retryable(s)) && !/fetch failed|timeout|ECONN/i.test(String(e?.message))) throw e; }
  }
  throw lastErr;
};
export const kit = createSolanaRpcFromTransport(fallbackTransport);

/** simulate(base64Tx) → { ok, error, units, logs } (signature not checked, blockhash refreshed) */
export async function simulate(tx) {
  const r = await rpc("simulateTransaction", [tx, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }]);
  const v = r?.value || {};
  return { ok: !v.err, error: v.err ? JSON.stringify(v.err) : null, units: v.unitsConsumed ?? null, logs: (v.logs || []).slice(-6) };
}

/** balance(owner, mint) → raw amount (bigint) of SOL (lamports) or of an SPL token across the owner's accounts */
export async function balance(owner, mint, solMint) {
  if (mint === solMint) return BigInt((await rpc("getBalance", [owner])).value);
  const r = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
  return (r?.value || []).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
}
