# SOLANA FLASHLOAN ARB BOT — Complete Project Knowledge

> This file contains everything Claude needs to know about this project.
> Place in ~/ARB-BOT/CLAUDE.md on the VPS.
> Last updated: March 20, 2026

---

## PROJECT OVERVIEW

Solana flashloan arbitrage bot (MEV bot) using MarginFi for flashloans, Jupiter for swap routing, and Jito for priority bundle submission. Written in Node.js, runs on a Frankfurt VPS (not Hetzner) via PM2.

**Bot wallet:** `ESzi3jyKV4EWi1TC36nRwLiHHDVTmzn9iCFTotToyhC3`
**MarginFi account:** `9H89EXD35fcEHV5Sj3c1662GWZzLrPZ89zm2EMFyP9n8`

**User preferences:**
- Does NOT use git — files edited directly on VPS
- Bot is a subscription/managed service that modifies files on the VPS
- Previously had a Claude Pro subscription that rewrote bot files and caused issues
- Prefers step-by-step fixes, one issue at a time
- Has Discord alerts enabled for trade notifications

---

## FILE STRUCTURE

```
~/ARB-BOT/
├── src/
│   ├── bot.js           # Main orchestrator — WS callback, fallback scan, tryExecute
│   ├── scanner.js       # Price scanning + Jupiter quotes (findOpportunitiesForPair, scanPair, reSizeScan)
│   ├── executor.js      # Tx building + MarginFi flashloan + Jito bundles + direct RPC submit
│   ├── loanSizer.js     # Loan optimization (mostly replaced by computeTargetLam in bot.js)
│   ├── poolWatcher.js   # WS pool subscriptions (Orca PDA + Raydium CLMM API + Raydium AMM hardcoded + Meteora API)
│   └── localPools.js    # Local pool math — decodes Orca Whirlpool + Raydium CLMM on-chain state
├── data/
│   └── pairs.json       # Active trading pairs config
├── .env                 # Config (RPC URLs, wallet key, settings)
└── CLAUDE.md            # This file
```

---

## RPC CONFIGURATION

- **Primary:** Helius (`mainnet.helius-rpc.com`) — used for everything except MarginFi SDK
- **Secondary:** Shyft (`rpc.shyft.to`) — used ONLY for MarginFi SDK because Helius blocks bulk account fetches
- **Known issue:** MarginFi SDK causes 429 storms on Shyft during/after execution — circuit breaker fixes have been applied but may not be fully working

---

## ACTIVE TRADING PAIRS (as of Mar 20)

| Pair | Token B Mint | Decimals B | Notes |
|------|-------------|------------|-------|
| SOL/USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | 6 | Anchor pair |
| SOL/USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 | Highest volume |
| SOL/BONK | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | 5 | Meme |
| SOL/WIF | `EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm` | 6 | Meme, $8.9M AMM liq |
| SOL/FARTCOIN | `9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump` | 6 | Meme, $7.6M AMM liq |

**Token A (SOL) for all pairs:** `So11111111111111111111111111111111111111112` (9 decimals)

**Previously used pairs (removed Mar 20):** SOL/JUP and SOL/PYTH — lower DEX volume, replaced with WIF + FARTCOIN.

**IMPORTANT:** pairs.json has been accidentally overwritten multiple times during debugging. If bot shows only 2 pairs on startup, restore the full 5-pair config.

**Pool coverage per pair:** 9 WS subscriptions each (Orca:6 + Raydium CLMM:1 + Raydium AMM:1 + Meteora:1) = 45 total.

---

## RAYDIUM AMM V4 HARDCODED POOLS (in poolWatcher.js)

```
SOL/USDT:     7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX
SOL/USDC:     58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2
SOL/BONK:     HVNwzt7Pxfu76KHCMQPTLuTCLTm6WnQ1esLv4eizseSv
SOL/WIF:      EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx
SOL/FARTCOIN: Bzc9NZfMqkXR6fz1DBph7BDf9BroyEf6pnzESP7v5iiw
```

---

## RAYDIUM CLMM POOLS (fetched via API, key pools)

```
SOL/USDT:  3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF (1544 bytes)
SOL/USDC:  3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv (1544 bytes)
```

---

## BOT SETTINGS (as of Mar 20)

```
MIN_PROFIT_USD=0.40          # Was 0.30, bumped after SLIPPAGE_BPS increase
SLIPPAGE_BPS=15              # Buy leg slippage (was 5, increased to prevent Jupiter SlippageToleranceExceeded)
SCAN_EVERY_N_SLOTS=8         # Fallback scan interval (was 10)
WS_DEBOUNCE_MS=200           # Min ms between WS scans per pair
JUPITER_RATE_LIMIT_PER_SEC=4
MAX_SOL_CAP=5                # In scanner.js computeTargetLam
JITO_TIP_LAMPORTS=50000      # ~$0.001, too low — gets rate limited during congestion
Flashloan range: 1-100 SOL
Sell leg slippage: 10 bps (hardcoded in executor.js line ~439)
```

---

## EXECUTION FLOW (complete pipeline)

```
1. WS pool event fires (50-100ms from on-chain change)
   ↓
2. Local pool math pre-filter (localPools.js)
   - Decode sqrtPrice from Orca/Raydium CLMM accountInfo (0.01ms)
   - Compare to Binance reference price
   - If spread < 0.05% → SKIP (don't call Jupiter)
   - If spread >= 0.05% → continue to Jupiter scan
   ↓
3. findOpportunitiesForPair (scanner.js) — 2 Jupiter quote API calls
   - Buy: SOL → tokenB (with slippage)
   - Sell: tokenB → SOL (with slippage)
   - Cache hit: 2-3ms, Cache miss: 300-500ms
   ↓
4. Spread threshold check
   - spreadPct < 0.01% → skip reSizeScan
   - spreadPct > 0.01% → run reSizeScan
   ↓
5. reSizeScan — tries to size up from 1 SOL to MAX_SOL_CAP
   - Step-down: tries 5, 4, 3, 2 SOL if 5 fails
   - 2 direct _doQuote calls (bypass queue): 200-400ms
   ↓
6. computeTargetLam — determines optimal loan in lamports
   ↓
7. Executor profitability check (isProfitable) — CPU only
   ↓
8. _getSwapInstructions — 2 axios POST to Jupiter swap-instructions API
   - Buy: normal slippage (SLIPPAGE_BPS)
   - Sell: 0 slippage (prevents overpaying, but was causing 6024)
   - 300-600ms (LARGEST REMAINING DELAY)
   ↓
9. Load address lookup tables (cached: 0ms, uncached: ~100ms)
   ↓
10. Fetch fresh blockhash (single RPC call: 30-50ms)
    ↓
11. Build flashloan transaction (MarginFi buildFlashLoanTx: 10-20ms)
    ↓
12. Sign transaction (CPU: ~1ms)
    ↓
13. Submit in parallel:
    - Jito bundle (Frankfurt endpoint): 5-10ms
    - Direct RPC (Helius): 30-50ms
    ↓
14. Confirm on-chain (30s timeout, typical: 400-1200ms)
```

---

## SCANNER INTERNALS

- **Two quote queues:**
  - `_jupiterQuote` — fallback path, 100ms spacing
  - `_jupiterQuoteFast` — WS path, 25ms spacing
- **reSizeScan** uses direct `_doQuote` calls bypassing both queues
- **Scan cache:** `WS_NO_OPP_TTL_MS=500`, `WS_OPP_TTL_MS=300`
- **Probe amount:** 1 SOL initially, then reSizeScan sizes up

---

## LOCAL POOL MATH (src/localPools.js) — COMPLETED Mar 20

Decodes on-chain pool state from raw WS accountInfo data. Zero API calls.

**Supported pool types:**
- **Orca Whirlpool** (653 bytes): sqrtPrice at offset 65, liquidity at offset 49, feeRate at offset 45, mints at 101/181
- **Raydium CLMM** (1544 bytes): sqrtPrice at offset 253, liquidity at offset 237, mints at 73/105, decimals at 233/234

**Accuracy:** Within 0.03% of Jupiter at 1 SOL probe size.

**Filtering:** Compares pool sqrtPrice to Binance SOL/USD reference price. Threshold: 0.05%. Events below threshold are skipped (no Jupiter call). Fixed a $0.00 price bug on some Raydium CLMM events.

**Not yet implemented:** Raydium AMM v4 local math (constant-product pools use Serum orderbook, complex), Meteora DLMM local math.

---

## COST ECONOMICS

| Component | Cost |
|-----------|------|
| Jito tip | ~$0.001 (50K lamports, too low — gets rate limited) |
| Solana tx fee | ~$0.0005 |
| MarginFi fee | $0.00 (0%) |
| Slippage drift | ~$0.20 (conservative) |
| Sell leg buffer (1-2 bps) | ~$0.04-0.09 |
| **Total worst case** | **~$0.30** |

**MIN_PROFIT_USD should be $0.35-0.40** to clear costs with margin.
**Minimum spread at 5 SOL:** ~0.08% for $0.35 profit.

---

## LATENCY PROFILE

| Step | Current | After local math sizing | After pre-built ix | With gRPC |
|------|---------|------------------------|-------------------|-----------|
| WS detection | 50-100ms | 50-100ms | 50-100ms | 1-5ms |
| Price calc | 0ms (local math) | 0ms | 0ms | 0ms |
| reSizeScan | 200-400ms | 0ms | 0ms | 0ms |
| Swap ix fetch | 300-600ms | 300-600ms | 0-5ms | 0-5ms |
| Blockhash | 30-50ms | 30-50ms | 30-50ms | 0ms |
| Build + sign | 10-20ms | 10-20ms | 10-20ms | 10-20ms |
| Submit | 5-50ms | 5-50ms | 5-50ms | 1-5ms |
| **Total** | **600-900ms** | **400-700ms** | **100-200ms** | **12-35ms** |

Top bots with gRPC Geyser + co-location: 5-20ms.

---

## COMPLETED FIXES

### 1. Jito Decode — FIXED (Mar 20)
- **Problem:** "transaction #0 could not be decoded" — Jito bundle serialization broken
- **Fix:** Base58 encoding fix in executor.js
- **Status:** Decode error gone. Now hits rate limit or vote account errors instead.

### 2. Local Pool Math — COMPLETED (Mar 20)
- **Problem:** Every WS event called Jupiter API (300-500ms wasted)
- **Fix:** src/localPools.js decodes Orca + Raydium CLMM + Meteora pool state locally
- **Status:** Working. Threshold 0.07%. Skips 99.8% of WS events. Only calls Jupiter for actionable spreads.
- **Accuracy:** Within 0.03% of Jupiter at 1 SOL probe size
- **Bug fixed:** $0.00 price on empty Orca pools causing 100% false spread
- **USD-only filter:** Only applies to /USDC and /USDT pairs (meme pairs would produce nonsensical prices vs Binance ref)

### 3. Pool Coverage Cleanup — COMPLETED (Mar 20)
- **Problem:** 30 Orca subs never fired, 4 pool lookups failing, meme pairs idle
- **Fix:** Updated poolWatcher.js AMM map, replaced JUP+PYTH with WIF+FARTCOIN, added per-pair logging
- **Status:** All 5 pairs have 9 subs each (45 total). All DEXs confirmed firing.

### 4. Pair Update — COMPLETED (Mar 20)
- **Problem:** SOL/JUP and SOL/PYTH had low volume
- **Fix:** Replaced with SOL/WIF and SOL/FARTCOIN
- **Status:** Done. IMPORTANT: pairs.json has been accidentally overwritten multiple times. Verify 5 pairs on every restart.

### 5. reSizeScan Step-Down — COMPLETED (Mar 20)
- **Problem:** reSizeScan failed at 5 SOL (market impact), returned null
- **Fix:** Step-down tries 100% → 60% → 40% of target. Execution lock gate prevents sub-threshold opps from blocking real ones.
- **Status:** Working. Logs show "step-down hit: 3 SOL" and "step-down hit: 2 SOL" regularly.
- **Caveat:** Meme pairs (BONK, WIF, FARTCOIN) were found to route through same Whirlpool on both legs = guaranteed loss. Removed during this fix session. See "IMPORTANT CONFLICT" in reSizeScan section below.

---

## FIXES APPLIED BUT AWAITING CONFIRMATION

### 6. Custom:6024 IllegalFlashloan — LIKELY FIXED
- **Problem:** MarginFi flashloan validation failed — loan not fully repaid
- **Root cause found:** Wallet was trying to send 5 SOL it didn't have as part of the tx
- **Fix:** Applied in executor.js (details in 6024 chat)
- **Status:** Last execution attempt showed NO 6024 error (timed out instead). Needs clean execution to confirm. Previous sell-slippage-buffer fix alone was insufficient.
- **History:** Multiple fix attempts: first 0 slippage on sell, then 1-2 bps buffer, then wallet balance fix.

### 7. 429 Circuit Breaker — APPLIED BUT NOT CONFIRMED WORKING
- **Problem:** MarginFi SDK hammers Shyft with infinite retries during/after execution
- **Fix:** Circuit breaker / request interceptor applied in executor.js
- **Status:** Two fix attempts so far. First fix didn't work at all. Second fix applied, awaiting next execution to confirm. 429 storms have caused EVERY execution attempt to timeout because RPC gets choked.
- **Impact:** This is the single biggest blocker. Even if 6024 is fixed and Jito works, 429 storms prevent tx confirmation.

---

## KNOWN REMAINING ISSUES

### 8. Jito Vote Account Rejection — NEW
- **Error:** "bundles cannot lock any vote accounts"
- **Cause:** Transaction includes a validator vote account in its address lookup tables
- **Impact:** Every Jito bundle is rejected. Bot falls back to direct RPC (slower, no priority)
- **Fix needed:** Filter vote accounts from the tx's address lookup tables before building the Jito bundle

### 9. Jito Rate Limiting — LOW PRIORITY
- **Error:** "Network congested. Endpoint is globally rate limited."
- **Cause:** Jito tip too low (50K lamports / ~$0.001). Low-tip bundles deprioritized.
- **Fix:** Increase tip to 100-200K lamports, or dynamic tip based on profit %
- **Note:** Not blocking since direct RPC is parallel fallback

### 10. reSizeScan Profit Too Low at Step-Down — ACTIVE
- **Problem:** At 5 SOL, market impact eats the spread → reSizeScan returns null
- **Current mitigation:** Step-down tries 4, 3, 2 SOL — but profit at 2-3 SOL is often too low ($0.01-0.05)
- **Proper fix:** Use local pool math for sizing (eliminates 200-400ms API calls AND finds optimal size)
- **Priority:** Medium — only matters once trades actually land

### 11. Pre-built Swap Instructions — NOT STARTED
- **Problem:** Jupiter swap-instructions API takes 300-600ms per execution (2 calls)
- **Fix:** Build swap instructions directly from DEX program IDLs (Orca, Raydium CLMM, Raydium AMM, Meteora)
- **Impact:** Largest single remaining latency reduction
- **Complexity:** HIGH — each DEX has different instruction layout (2-4 weeks)
- **Priority:** High — but only after execution pipeline actually works

### 12. pairs.json Gets Overwritten
- **Problem:** Various debugging sessions have accidentally overwritten pairs.json to 2 pairs
- **Fix:** Always verify "Active pairs (5)" in startup logs after any change
- **If broken:** Restore from the pair list in this document

---

## JITO ERROR HISTORY (chronological)

1. `"transaction #0 could not be decoded"` → FIXED with base58 encoding
2. `"Network congested. Endpoint is globally rate limited."` → Low tip, not blocking
3. `"bundles cannot lock any vote accounts"` → NEW, needs vote account filtering

---

## EXECUTION ATTEMPT HISTORY

| Time | Pair | Spread | Loan | Profit | Jito | Result |
|------|------|--------|------|--------|------|--------|
| Mar 18 | SOL/USDC | 0.122% | 5 SOL | ~$0.55 | decode fail | 6024 |
| Mar 19 | SOL/USDT | 0.078% | 5 SOL | ~$0.35 | rate limited | timeout (429 storm) |
| Mar 19 | SOL/USDC | 0.140% | 3.2 SOL | ~$0.38 | decode fail | 6024 |
| Mar 20 | SOL/USDC | 0.128% | 5 SOL | ~$0.57 | rate limited | timeout (429 storm) |
| Mar 20 | SOL/USDC | 0.143% | 5 SOL | ~$0.64 | rate limited | timeout (429 storm) |
| Mar 20 | SOL/USDC | 0.095% | 5 SOL | ~$0.42 | rate limited | 6024 |
| Mar 20 | SOL/USDC | 0.094% | 5 SOL | ~$0.42 | rate limited | 6024 |
| Mar 20 | SOL/USDC | 0.100% | 5 SOL | ~$0.45 | vote accounts | timeout (429 storm) |

**Pattern:** Good detection, good sizing, zero successful trades. Blocked by Jito rejection → direct RPC → 429 storm → timeout or 6024.

---

## RECOMMENDED FIX ORDER (as of Mar 20 evening)

1. **Restore pairs.json to 5 pairs** (if currently showing 2) — immediate
2. **Wait for next execution** — confirms 6024 fix + 429 breaker status
3. **Fix Jito vote account filtering** — unblocks Jito bundles, bypasses 429 problem
4. **reSizeScan tuning** — use local math for sizing, eliminate 200-400ms
5. **Pre-built swap instructions** — eliminate 300-600ms, biggest latency win
6. **Dynamic Jito tip** — improve bundle acceptance during congestion
7. **gRPC Geyser upgrade** (~$200/mo) — final step to reach ~50ms total

---

## FUTURE UPGRADE PATH

| Upgrade | Latency Saved | Cost | Complexity |
|---------|--------------|------|------------|
| Local math for sizing | 200-400ms | Free | Low |
| Pre-built swap ix | 300-600ms | Free | High (2-4 weeks) |
| Dynamic Jito tip | N/A (reliability) | ~$0.02/trade | Low |
| gRPC Geyser | 50-95ms | ~$200/mo | Medium |
| Co-location | 20-45ms | ~$500/mo | Low |

---

## KEY POOL ACCOUNT LAYOUTS

### Orca Whirlpool (653 bytes)
```
Offset 45:  feeRate (u16, hundredths of bps, denom 1,000,000)
Offset 49:  liquidity (u128)
Offset 65:  sqrtPriceX64 (u128, Q64.64)
Offset 81:  tickCurrent (i32)
Offset 101: mintA (pubkey)
Offset 181: mintB (pubkey)
```

### Raydium CLMM (1544 bytes)
```
Owner: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
Offset 73:  tokenMint0 (pubkey)
Offset 105: tokenMint1 (pubkey)
Offset 233: mintDecimals0 (u8)
Offset 234: mintDecimals1 (u8)
Offset 235: tickSpacing (u16)
Offset 237: liquidity (u128)
Offset 253: sqrtPriceX64 (u128, Q64.64)
Offset 269: tickCurrent (i32)
```

Both use identical concentrated liquidity math:
```
sqrtPriceFloat = sqrtPrice / 2^64
poolPrice = sqrtPriceFloat² × 10^(decimalsA - decimalsB)
```

---

## BINANCE REFERENCE PRICE

The bot uses Binance WebSocket for real-time SOL/USD reference price. This is correct — Binance gives the global CEX price, DEX pool prices deviate from it, and that deviation IS the arb opportunity. Do NOT switch to Birdeye (which aggregates DEX prices and would narrow detectable spreads). Birdeye could help for meme tokens not on Binance, but that's a later optimization. The bot has a Birdeye API key available but it's not used for reference pricing.

---

## METEORA DLMM POOL LAYOUT (904 bytes)

```
Owner: LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
Offset 48:  activeBinId (i32)
Offset 80:  binStep (u16)
```

Price formula (bin-based, NOT sqrtPrice):
```
price = (1 + binStep/10000)^activeBinId × 10^(decimalsA - decimalsB)
```

localPools.js supports Meteora via getPoolPrice() using this formula.

---

## RAYDIUM AMM V4 LOCAL MATH — NOT POSSIBLE

Investigated and abandoned. The AMM v4 pools (e.g. `7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX`) use the deprecated Serum DEX orderbook for liquidity. Vault accounts are Serum open-orders accounts (3228 bytes), not simple SPL token vaults. Constant-product math doesn't apply. Local price detection for AMM v4 pools is not feasible — they're only useful via Jupiter routing.

---

## PHOENIX ORDERBOOK — INVESTIGATED, SKIPPED

Phoenix orderbook accounts are 1,723,488 bytes — far too large for WS subscriptions. Would cause massive bandwidth overhead. Skipped for local math.

---

## 6024 ROOT CAUSE DEEP DIVE

The 6024 error went through multiple diagnosis stages:
1. **Initial theory:** Sell leg slippage — sell returns less SOL than borrowed. Fix: set sell slippage to 0. Result: didn't help.
2. **Second theory:** Need small buffer. Fix: 1-2 bps sell slippage. Result: didn't help.
3. **Third theory (found via on-chain logs):** `_buildMfiIxs` in executor.js had a `SystemProgram.Transfer` wrapping `amt + 10000n` lamports (full 5 SOL loan) from wallet. Wallet only had ~0.099 SOL. Fix: changed to `10000n` only.
4. **Fourth finding (from program logs):** Error `0x1788` (6024 decimal) is actually Jupiter's `SlippageToleranceExceeded` on the BUY leg, not MarginFi repay. SLIPPAGE_BPS was 5 (0.05%), too tight for 1-6s pipeline latency. Fix: increased to 15 bps, raised MIN_PROFIT_USD to 0.40.

**Current state:** Both the wallet transfer fix AND the slippage increase are applied. Awaiting next execution to confirm.

---

## 429 CIRCUIT BREAKER DEEP DIVE

Two fix attempts:
1. **First attempt:** Monkey-patched `_rpcRequest` on mfiConn with concurrency throttle (3 parallel, 100ms spacing). Result: didn't work — the retries come from deeper in the SDK.
2. **Second attempt:** Found the real retry source in `node_modules/@solana/web3.js/lib/index.native.js` — HTTP fetch layer does 5 retries with exponential backoff starting at 500ms. Fix: passed `{ commitment: 'confirmed', disableRetryOnRateLimit: true }` to the mfiConn Connection constructor. This triggers the SDK's built-in bypass of the retry loop.

**Current state:** Second fix applied, awaiting confirmation. 429 storms have appeared on every execution so far — 30+ seconds of continuous retries that choke RPC and prevent tx confirmation.

---

## JITO VOTE ACCOUNT DEEP DIVE

The latest Jito error "bundles cannot lock any vote accounts" was investigated. A diagnostic block was added to executor.js that:
1. Parses the versioned transaction's writable account set (static keys + ALT-indexed writable entries)
2. Makes a single `getMultipleAccountsInfo` RPC call
3. Identifies any vote-program-owned accounts before submission
4. Logs which accounts are vote accounts

The `_submitJitoBundle` method was also rewritten to:
- Add `mainnet.block-engine.jito.wtf` as a third endpoint alongside Frankfurt and Amsterdam
- Log errors from every endpoint individually with endpoint name
- Properly parse JSON-RPC errors from HTTP 200 responses (previously only caught HTTP errors, silently dropped JSON-RPC errors)

---

## RESIZESCAN TUNING — COMPLETED (Mar 20)

Changes made:
1. **Step-down sizing** in scanner.js — instead of one shot at target, tries 100% → 60% → 40%. First profitable size wins. Confirmed working: "step-down hit: 3 SOL" and "step-down hit: 2 SOL" in logs.
2. **Execution lock gate** in bot.js — sub-threshold opps (spread < 0.005% at 1 SOL) no longer claim `isExecuting` lock, preventing real opps from getting `Blocked(locked)`.
3. **Meme pairs removed** from pairs.json — BONK, WIF, FARTCOIN were routing through same Whirlpool on both buy and sell legs (round-trip through single pool = guaranteed loss to fees). No cross-DEX arb exists for these pairs. Dropped from 45 to 18 WS subs.
4. **Cleanup:** Removed temp debug log from scanner.js.

**IMPORTANT CONFLICT:** The reSizeScan chat removed meme pairs (down to 2 pairs: SOL/USDT + SOL/USDC), while the pool coverage chat earlier added them (5 pairs). The LATEST state depends on which was applied last. Always check `cat data/pairs.json` and startup logs to verify.

---

## KEY EXECUTOR.JS DETAILS

- **Jito tip:** Line ~479, currently 50,000 lamports (JITO_TIP_LAMPORTS in .env)
- **Sell slippage:** Line ~439, currently 10 bps (was 0, then 3, then 10)
- **Buy slippage:** Uses SLIPPAGE_BPS from .env (currently 15, was 5)
- **SystemProgram.Transfer:** In `_buildMfiIxs`, changed from `amt + 10000n` to `10000n`
- **bs58 require:** Added at line 2 for Jito base58 encoding
- **Jito endpoints:** Frankfurt, Amsterdam, and mainnet.block-engine.jito.wtf
- **mfiConn:** Uses `{ commitment: 'confirmed', disableRetryOnRateLimit: true }`
- **LUT cache:** Has TTL-based cache for address lookup tables (LUT_CACHE_TTL_MS)
- **Confirmation:** 30s timeout via Promise.race
- **Parallel submit:** Sends to both Jito bundle AND direct RPC simultaneously

---

## LOCAL POOL MATH FILTER DETAILS

The WS callback filter in bot.js:
- Only applies to USD-paired tokens (pairs ending in /USDC or /USDT) — meme token pairs like SOL/WIF would produce nonsensical prices against Binance SOL/USD reference
- Uses `getPoolPrice()` function which handles all 3 DEX types (Orca sqrtPrice, Raydium CLMM sqrtPrice, Meteora bin math)
- Returns early if poolPrice <= 0 (prevents the $0.00 / 100% spread false positive bug)
- Threshold tuned from 0.03% → 0.05% → 0.07% based on measured Jupiter call counts
- Final setting: 0.07% (since minimum viable spread for profit is ~0.08% at 5 SOL)
- Result: 99.8% reduction in Jupiter API calls with zero false positives

---

## STRATEGIES EVALUATED AND DEPRIORITIZED

### Triangle Arbitrage (A→B→C→A)
Evaluated and deprioritized due to: compounding latency (1500-2000ms+), tx size near Solana's 1232-byte limit, flashloan repayment complexity across 3 legs, combinatorial scanning cost vs Jupiter rate limits, thin net margins.

### Dynamic Slippage per Pool
Evaluated as moderate complexity with limited upside. Simplified approach recommended: static pool classification (deep vs thin) rather than real-time tick array decoding.

### Success Rate Tracking
Evaluated as high value, low risk. In-memory map of attempts/successes per route, resetting hourly, enabling EV-based execution prioritization. Not yet implemented but recommended as future improvement.

---

## PM2 CACHE GOTCHA

When replacing files (especially localPools.js), a `pm2 restart arb-bot` may serve the OLD cached module. Must do `pm2 stop arb-bot && pm2 delete arb-bot && pm2 start src/bot.js --name arb-bot && pm2 save` to fully clear the Node.js module cache.
