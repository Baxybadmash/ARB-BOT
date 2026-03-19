# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start              # Run the live arbitrage bot (mainnet, real funds)
npm test               # Simulate mode — tests RPC latency and finds opportunities without executing trades
npm run update-pairs   # Manually trigger token pair refresh (normally runs monthly)
```

No build step required — Node.js runtime only.

## Environment

Copy `.env` variables before running. Required variables:

- `WALLET_PRIVATE_KEY` — Base58-encoded Solana wallet private key
- `RPC_URL_PRIMARY` / `RPC_URL_SECONDARY` — Helius/Shyft RPC endpoints
- `RPC_URL_WEBSOCKET` — WebSocket endpoint for pool subscription
- `MARGINFI_GROUP` — MarginFi lending group address

Optional but recommended: `JUPITER_API_KEY`, `BIRDEYE_API_KEY`, `JITO_BLOCK_ENGINE_URL`, Discord/Telegram alert credentials.

## Architecture

This is a Solana cross-DEX arbitrage bot using MarginFi flashloans (0% fee). It runs as a single Node.js process with these modules:

### Data Flow

1. **`poolWatcher.js`** — Maintains WebSocket subscriptions to Orca Whirlpool, Raydium AMM/CLMM, and Meteora DLMM pool accounts. Fires a callback immediately when a pool state change (swap) is detected (~50–100ms latency).

2. **`bot.js`** — Main orchestrator. Runs two scan paths:
   - **Primary:** WebSocket-triggered scans via `poolWatcher.js`
   - **Fallback:** Slot-polling every `SCAN_EVERY_N_SLOTS` slots (~2s) for pairs not covered by WS subscriptions
   - Shared rate limiter (token bucket) prevents Jupiter API overload across both paths
   - Monthly scheduler calls `pairUpdater.js` to hot-swap the active pair list without restart

3. **`scanner.js`** — Calls Jupiter Aggregator API twice per pair (buy quote + sell quote) to detect spread. If `sell_price > buy_price - slippage - fees`, an opportunity is flagged. Rate-limited to 8–10 req/sec.

4. **`loanSizer.js`** (optional, `OPTIMAL_SIZING=true`) — Computes optimal borrow amount using the AMM constant-product formula (`optimal = sqrt(r_in * r_out) - r_in`) with a 3-probe fine search. Caps at 5% of pool reserve (`POOL_DEPTH_CAP`).

5. **`executor.js`** — Builds and submits the atomic flashloan transaction:
   - `beginFlashLoan` → `lendingAccountBorrow` → Jupiter buy instructions → Jupiter sell instructions → `lendingAccountRepay` → `endFlashLoan`
   - Submits as a Jito bundle for MEV protection; falls back to standard RPC if Jito fails

### Supporting Modules

- **`pairUpdater.js`** — Fetches top tokens by 30-day volume from Birdeye, scores them for arb potential, applies a blacklist (stablecoins, illiquid tokens), and writes `data/pairs.json`
- **`price.js`** — Tracks SOL/USD price via Binance WebSocket with CoinGecko HTTP fallback
- **`logger.js`** — Winston logger writing to `logs/bot.log` and `logs/profit.log` (10MB max, 5 rotations)
- **`discord.js`** — Sends alerts to main and tx-specific Discord webhook channels
- **`simulate.js`** — Entry point for `npm test`; validates RPC connectivity and opportunity detection without submitting transactions
- **`benchmark.js`** — Standalone performance/latency analysis tool

### State Files

- `data/pairs.json` — Active trading pairs (loaded at startup, hot-swapped monthly)
- `data/marginfi_account.json` — Cached MarginFi lending account reference
- `data/history/` — Historical pair scoring data used by `pairUpdater.js`

### Key Design Decisions

- **No capital required:** All trades are funded by MarginFi flashloans; wallet only needs SOL for gas + Jito tips
- **Atomic execution:** The entire borrow → buy → sell → repay cycle is a single Solana transaction; it succeeds completely or reverts with no loss
- **Dual-path scanning:** WS subscriptions are the primary low-latency trigger; slot polling is the safety net
- **Watchdog:** If no slot heartbeat is received for 45s, all WebSocket connections are torn down and resubscribed automatically
