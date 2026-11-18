<p align="center"><img src="public/img/glidy.svg" width="96" alt="Glidy"></p>

# Glidy

**[useglidy.xyz](https://useglidy.xyz)** · [App](https://useglidy.xyz/app/) · [X @glidyagent](https://x.com/glidyagent)

**The LP agent for Solana.** Glidy finds the best Orca Whirlpools (concentrated liquidity), picks a price range around the live price, runs the **Checkpoint** on every deposit, and helps you collect fees and rebalance. Every action is a ticket you sign in your own wallet (Phantom, Solflare, Backpack). The agent never holds a key.

| Area | What runs |
|---|---|
| Pools | Orca Whirlpools on Solana (SOL, USDC, USDT, xStocks such as NVDAx and TSLAx, new coins) with fee tier read from the chain, TVL, 24h volume and an estimated fee APR. |
| Add liquidity | Give one side (native SOL is wrapped for you) and a range width (±2% to ±50%). Glidy sizes the other token from the live price, snaps the range to the pool's tick spacing and builds one transaction that opens the position. |
| Positions | Your Whirlpool positions read from the chain: range, in/out of range, token amounts, uncollected fees and USD value. |
| Collect / remove / rebalance | One ticket each. Rebalance = close, then a new range around the price. |
| Checkpoint | Checks before every deposit and again right before signing (below). |
| Agent chat | Claude with read tools and `prepare_lp_add`, `prepare_lp_collect`, `prepare_lp_remove` and `prepare_swap`. Without an API key a command parser handles the common requests. |
| Swap | Any pair on Solana through Jupiter, to get the tokens a position needs. |
| API and MCP | The same tools over REST and an MCP server (`mcp/`) for Claude Code, Claude Desktop or Cursor. |

Program used: Orca Whirlpools `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`, through the official `@orca-so/whirlpools` SDK.

## The LP Checkpoint

| Check | Pass | Warn | Fail |
|---|---|---|---|
| Pool | an account of the Orca Whirlpools program | | anything else |
| Pool depth | $100K+ TVL | $10K–100K, or not in the top pools | under $10K |
| Fee income | 24h volume and estimated APR shown | volume under $1K, or volume far above depth | |
| Tokens | known token, or no risky authorities | live mint / freeze authority, Token-2022 transfer fee, permanent delegate, transfer hook | flagged by Jupiter, not a mint |
| Range | wider than the last 24h move | tighter than the last 24h move | |
| Impermanent loss | shown for a move to the edge of the range | over 5% | |
| Balance & simulation | you hold enough; the exact transaction succeeds from your wallet | balance too low | it fails |
| Limits | inside per-deposit, daily and slippage caps | | over a cap, paused, kill switch, blocked token |

Fee APR = 24h volume × fee tier ÷ TVL × 365, for full-range liquidity. A concentrated range earns more while in range and nothing while out of range. The token check is a heuristic, not an audit.

## Run locally (for developers)

Use Glidy at **[useglidy.xyz](https://useglidy.xyz)**. To run your own copy you need Node 20 or newer:

```bash
npm install
```

```bash
npm start
```

Then open http://127.0.0.1:9330. It reads Solana live with no configuration (public RPCs are rate-limited, so set `SOLANA_RPC` for real use); the AI chat needs your own `ANTHROPIC_API_KEY` (see [Secrets](#secrets)).

Run the tests:

```bash
npm test
```

## Deploy

**Railway, Render, Fly or any Node host:** start command `npm start` (Railway reads `railway.json`, health check `/api/health`). The platform's `PORT` is used and the server listens on `0.0.0.0`. Set `GLIDY_SECRET` to a long random string (`openssl rand -hex 32`); `SOLANA_RPC` (your own RPC, e.g. Helius) and optional `ANTHROPIC_API_KEY`. Mount a volume at `GLIDY_DATA` so limits, journal and API tokens survive redeploys.

**Vercel:** import the repo (Framework Preset: Other); `vercel.json` routes `/api/*` to `api/index.js`. Set `GLIDY_SECRET` and `SOLANA_RPC`. Data is written to `/tmp` there.

### Secrets

This repository contains no keys. Configuration lives in environment variables on your host (Vercel → Settings → Environment Variables, or Railway → Variables), never in the code. [`.env.example`](.env.example) lists them with empty values; for local runs copy it to `.env`, which git ignores.

| Variable | Required | What it is |
|---|---|---|
| `GLIDY_SECRET` | yes | Signs sign-in sessions and tickets. A long random string. |
| `ANTHROPIC_API_KEY` | no | Turns on the AI chat. Without it the agent runs in command mode. |
| `ANTHROPIC_WORKSPACE_ID` | no | Only for Anthropic keys not scoped to a workspace. |
| `SOLANA_RPC` | recommended | Your own Solana RPC endpoint (Helius, Triton, QuickNode…). Public endpoints refuse some reads. |
| `JUP_API_KEY` | no | Jupiter API key for higher rate limits. |

The server never sends these to the browser: the page only talks to `/api`, and the AI key is used server-side.

## API

Read tools are public. Prepare needs an API token; execute needs the `execute` scope and an `Idempotency-Key`.

```
GET  /api/tools                                            list tools and schemas
GET  /api/tools/list_lp_pools?sort=apr                     pools ranked for LPs
GET  /api/tools/lp_positions?address=<wallet>               a wallet's positions
GET  /api/tools/check_lp?pool=<whirlpool>&token=SOL&amount=0.5&widthPct=10
POST /api/tools/prepare_lp_add      x-api-key   {"pool":"<whirlpool>","token":"SOL","amount":"0.5","widthPct":10}
POST /api/tools/prepare_lp_collect  x-api-key   {"tokenId":"<position mint>"}
POST /api/tools/prepare_lp_remove   x-api-key   {"tokenId":"<position mint>","pct":100}
```

```bash
npm run token -- my-laptop --owner <your wallet address>
```

## MCP

```bash
claude mcp add glidy --env GLIDY_URL=http://127.0.0.1:9330 --env GLIDY_API_KEY=glidy_… -- node /path/to/glidy/mcp/index.mjs
```

## License

MIT
