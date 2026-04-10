# ARB-BOT STATE.md
*Single source of truth. Update this after every chat session before closing.*
*Last updated: Apr 9, 2026 (Pool cache seeding + computeSwap blocker identified)*

---

## 1. BOT IDENTITY

- **Wallet:** `ESzi3jyKV4EWi1TC36nRwLiHHDVTmzn9iCFTotToyhC3`
- **VPS:** Frankfurt, Ubuntu, PM2 process name: `arb-bot`
- **Start command:** `cd ~/ARB-BOT && pm2 start src/bot.js --name arb-bot`
- **No git** — files edited directly on VPS
- **Bot folder:** `~/ARB-BOT/`

---

## 2. INFRASTRUCTURE

| Component | Provider | Notes |
|-----------|----------|-------|
| RPC Primary | Helius (`mainnet.helius-rpc.com`) | All general RPC calls |
| RPC Secondary | Shyft (`rpc.shyft.to`) | Kamino SDK only |
| Flashloan | Kamino (replaced MarginFi — error 6080) | Flash loan fee: 0.001% (handled internally by Kamino, do NOT add to repay amount) |
| Swap routing | Jupiter aggregator + local Orca/Raydium CLMM builders (Phase 2+3) | Jupiter fully bypassed for hasLocalMath pairs, local for forced-pool arbs |
| MEV submission | Jito `sendTransaction` ONLY | No bundles, no direct RPC |
| Process mgr | PM2 | Always `stop + delete + start` — never just restart |

**Kamino constants:**
- Program: `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`
- Market: `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF`
- Market authority: `9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo`
- SOL reserve: `d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q`
- Supply vault: `GafNuUXj9rxGLn4y79dPu6MHSuPWeJR6UtTWuexpGh3U`
- Fee vault: `3JNof8s453bwG5UqiXBLJc77NRQXezYYEBbk3fqnoKph`
- Borrow discriminator: `87e734a70734d4c1`
- Repay discriminator: `b97500cb60f5b4ba`
- Obligation PDA: `3Dk4AyfbUmWdkfbdDkpdft9aTeDvJghEa2eZcoDtGmya`
- UserMeta PDA: `7nJ9sTDKt8B5cSCDHSq4egCsvCyZR2iWoytwsYzJNVaW`
- FarmUserState PDA: `78ca6PtQdd2xVamvAoGdDUML6QFqikdcpGG8TNwmEUXX` (not needed for flash borrow)

---

## 3. CURRENT .ENV VALUES (confirmed Apr 5)

```
MIN_PROFIT_USD=0.05          # deliberately low for pipeline testing — raise to 0.40 for production
SLIPPAGE_BPS=100             # buy slippage
WS_DEBOUNCE_MS=50            # poolWatcher debounce (hardcoded 50ms)
JUPITER_COOLDOWN_MS=3000
JUPITER_RATE_LIMIT_PER_SEC=8
JITO_TIP_LAMPORTS=150000     # floor tip (dynamic tip is 50% of profit, floor 50K, ceil 5M)
RPC_URL_PRIMARY=https://mainnet.helius-rpc.com/?api-key=<redacted>
RPC_URL_SECONDARY=https://rpc.shyft.to?api_key=<redacted>
```

**Hardcoded in source (not in .env):**
- `MAX_SOL_CAP=40` → `scanner.js:162`
- `MAX_LOCAL_SOL=40` → `bot.js` XDEX block (caps executeLocal loan)
- `LOCAL_STEPS=[1.0, 0.5, 0.25, 0.1, 0.05, 0.025]` → `bot.js` XDEX block (resize step-down: 40→20→10→4→2→1 SOL)
- `FLASHLOAN_AMOUNT_SOL=100` → `bot.js:140` (default, but capped to 40 by MAX_LOCAL_SOL for XDEX path)
- `bot.js:190` → `WS_DEBOUNCE_MS` defaults to `100` if env not set
- `executor.js:362` → `MIN_PROFIT_USD` fallback default `1.5`
- `executor.js:558` → `MIN_PROFIT_USD` fallback default `1.5`
- `scanner.js:161` → `MIN_PROFIT_USD` fallback default `0.30`
- Sell slippage: `150bps` hardcoded in `_getSwapInstructions(reverseQuote, 150)` call

---

## 4. TRADING PAIRS & POOL COVERAGE

5 pairs, 9 WS subscriptions each = **45 total subscriptions**

| Pair | Orca | Raydium CLMM | Raydium AMM | Meteora |
|------|------|--------------|-------------|---------|
| SOL/USDT | 6 | 1 | 1 | 0 (none exists) |
| SOL/USDC | 6 | 1 | 1 | 0 (none exists) |
| SOL/BONK | 6 | 1 | 1 | 1 |
| SOL/WIF | 6 | 1 | 1 | 1 |
| SOL/FARTCOIN | 6 | 1 | 1 | 1 |

**Local pool math status:**
- Orca Whirlpool ✅ decoded (sqrtPrice, liquidity, tick, feeRate, tickSpacing, vaultA, vaultB)
- Orca Whirlpool ✅ **local instruction builder complete** (`src/orcaBuilder.js`)
- Raydium CLMM ✅ **fully decoded** (sqrtPrice, liquidity, tick, vaultA, vaultB, ammConfig, observationKey, tickSpacing)
- Raydium CLMM ✅ **local instruction builder complete** (`src/raydiumBuilder.js`) — Phase 3
- Meteora DLMM ✅ price decoded (binStep, activeBinId) — NO swap math, NO vault addresses, **price decode BROKEN for SOL/BONK** (shows 7.10 vs real ~14.2M)
- Raydium AMM v4 ❌ dormant — Serum vault accounts (388-byte) can't be read as SPL token accounts

---

## 5. EXECUTION FLOW (current as of Apr 9)

```
WS pool event
  → debounce 50ms per pair
  → if dex === 'Raydium AMM': return (dormant)
  → if hasLocalMath (Orca/Raydium CLMM/Meteora):
      → updatePoolState()
      → xdexCooldowns check: 3s cooldown per pair after all-sizes-fail
      → XDEX_DEAD_PAIRS check: ["SOL/USDT","SOL/USDC","SOL/WIF","SOL/FARTCOIN"] → return
      → checkCrossPoolSpread(pair, 120000ms maxAge)
        → Meteora EXCLUDED from spread comparison (broken price decode)
        → Groups by dexType, picks highest-liquidity pool per DEX
      → IF spread found AND profitable:
          → IF both pools are Orca or Raydium CLMM:
              → Resize loop: try 100%→50%→25%→10%→5%→2.5% of MAX_LOCAL_SOL (40)
                 = 40→20→10→4→2→1 SOL, floor 1 SOL
              → executor.executeLocal() — picks builder per pool dexType
              → computeSwap profitability check ← CURRENT BLOCKER (overestimates price impact)
              → Kamino flashloan wrap → sign → Jito submit
      → return (ALWAYS — never fall through to Jupiter for hasLocalMath pairs)
  → Fallback slot scanner: dead pairs filtered out before tryExecute
  → Jupiter scan path (rarely reached — only non-hasLocalMath events)
```

---

## 6. KEY DECISIONS & WHY (never undo these without reading this)

| Decision | Reason |
|----------|--------|
| Jito `sendTransaction` not `sendBundle` | Prop AMMs (ZeroFi, HumidiFi, BisonFi) hardcode Jito vote account as required instruction input — sendBundle rejects any tx with vote accounts |
| No direct RPC fallback | MEV sandwiching risk |
| Simulation DISABLED | Flashloan txs produce false negatives in simulation |
| excludeDexes REMOVED | Excluding ZeroFi/HumidiFi/BisonFi kills all detections — they ARE the arb source |
| MarginFi dropped | Error 6080 on every attempt |
| Proportional sell quote scaling (10bps) + routePlan scaling | Bare `inAmount` mutation left outAmount/otherAmountThreshold inconsistent → 6001. Top-level-only scaling ignored by Jupiter — Jupiter builds instructions from `routePlan[].swapInfo.inAmount/outAmount`, not top-level fields → 6024. Must scale both top-level AND routePlan entries proportionally. |
| Post-scaling profitability recheck | Without this, trades that look profitable pre-scaling execute as losers → Custom:1 on repay (insufficient WSOL) |
| Always start at MAX_SOL_CAP | Old formula sized loan to barely hit MIN_PROFIT_USD — caused 0.156% spread to get only 1 SOL loan ($0.12 gross). Now always starts at 40 SOL, reSizeScan steps down if market impact kills spread. |
| Dynamic borrowIxIndex | Jupiter setup ixs can shift borrow position in innerIxs. Hardcoded index=2 caused Custom:1 when borrow landed at index 3. Now scans for Kamino borrow discriminator. |
| Kamino repay amount = borrow amount | Kamino handles fees internally. Adding fee to repay amount causes 6033 "Invalid repay found" — borrow validates that repay liquidityAmount matches exactly. |
| Sell slippage 150bps (not 100bps) | Extra buffer for sell leg |
| All web3.js copies patched to 0 retries | 3 copies of @solana/web3.js each had 5-retry exponential backoff causing 429 storms |
| PM2 stop+delete+start (not restart) | PM2 caches modules — restart insufficient after file changes |
| Raydium AMM dormant | Vault accounts are 388-byte Serum program accounts, not standard SPL. WS events for Raydium AMM now `return` immediately to prevent Jupiter rate limit storms. |
| Chainstack gRPC NOT purchased | Do not buy until local instruction building is complete. gRPC saves ~100ms detection but Jupiter API is the real bottleneck (1200-3400ms). |
| Orca swap V1 not V2 | SOL and BONK are both standard SPL tokens — V1 swap (11 accounts) works and is simpler/smaller than V2 (15 accounts). On-chain txs use V2 (via Jupiter) but V1 is still supported. |
| Orca oracle as read-only | SOL/BONK ts=8 pool is NOT AdaptiveFee — oracle PDA exists but account is not initialized on-chain. Pass as read-only (not writable). |
| Local exec: 3% threshold buffer on buy | computeSwap() is single-tick approximation — real on-chain output may be 0.1-0.5% less due to cross-tick moves. 3% buffer prevents slippage failures. |
| Local exec: sell threshold = borrow amount | Must get back at least the flashloan borrow to avoid Custom:1 on repay. |
| Orca+Raydium CLMM guard for executeLocal() | Expanded from Orca-only (Phase 2) to include Raydium CLMM (Phase 3). Meteora still excluded (no instruction builder). |
| Raydium CLMM uses standard `swap` discriminator | Confirmed from on-chain txs: `f8c69e91e17587c8` = sha256("global:swap")[0:8]. Inner ix data is base58-encoded (not base64). 41 bytes: disc(8)+amount(u64)+threshold(u64)+sqrtLimit(u128)+isBaseInput(bool). |
| Raydium CLMM tick array PDA uses i32 BIG-ENDIAN | Unlike Orca (string representation), Raydium uses `seeds=["tick_array", pool_pubkey, startTickIndex_i32_BE]`. Confirmed by brute-force matching against on-chain tick arrays. |
| Raydium CLMM has 1 bool (isBaseInput) not 2 | Direction determined by account ordering (inputVault/outputVault), not a data field. |
| Jupiter fully bypassed for hasLocalMath pairs | `if (hasLocalMath) { ... return; }` — ALL Orca/Raydium CLMM/Meteora WS events return after XDEX check, never reach Jupiter scanner. |
| Raydium AMM WS events return immediately | `if (dex === "Raydium AMM") return;` — dormant pools were flooding Jupiter with useless scans. |
| checkCrossPoolSpread maxAge = 120000ms | Raydium CLMM SOL/BONK pool gets NO WS events (deep pool, Helius doesn't deliver onAccountChange). Pool data seeded at startup via RPC. 120s maxAge keeps seeded data valid. |
| Meteora excluded from checkCrossPoolSpread | Price decode broken for SOL/BONK (shows 7.10 vs real ~14.2M). Was poisoning all cross-DEX comparisons with 198M% fake spreads. |
| Dead pairs blocked from XDEX path | SOL/USDT, SOL/USDC, SOL/WIF, SOL/FARTCOIN skip XDEX entirely — confirmed dead (fake spreads, illiquid pools, no data). |
| Dead pairs filtered from fallback scanner | `_rawOpps.filter()` before `tryExecute` — stops SOL/USDC from burning Jupiter rate limit budget. |
| Pool cache seeded at startup via getMultipleAccountsInfo | Raydium CLMM SOL/BONK gets ZERO WS events. Without seeding, it never enters poolCache and XDEX never has two pools to compare. |

---

## 7. CURRENT STATUS (Apr 9, 2026)

**No successful trade has landed yet.**

**Active error:** NONE — bot runs cleanly.

**Bot is currently:** STOPPED (paused for computeSwap redesign)

**Critical blocker identified: `computeSwap()` single-tick approximation overestimates price impact.**

Verified by direct test:
- Buy 1 SOL on Orca (liq=110T, fee=0.05%) → get 1,421,129,300,339 BONK-lamports
- Sell that on Raydium (liq=94T, fee=0.01%) → get 997,605,658 SOL-lamports (0.9976 SOL)
- **Loss: 0.24%** on round trip despite 0.10-0.19% spread in our favor
- Price impact reported: 6.84 bps on buy alone

The formula assumes ALL liquidity is at the current tick. In CLMM pools, liquidity is distributed across tick ranges. The single-tick model overestimates price movement per unit of input, making every trade look unprofitable even when the real on-chain execution would succeed.

At every size from 40 SOL (-$103) down to 1 SOL (-$0.19), `computeSwap` returns net negative. The spread check (0.10-0.19% after 0.06% fees) says profitable, but the swap simulation says loss.

**What IS working:**
- Pool cache seeding via RPC at startup ✅ — Raydium CLMM now in cache
- XDEX fires consistently for SOL/BONK (Raydium CLMM vs Orca) every 5-15s ✅
- Spread detection: 0.099%–0.24% spreads observed, correctly identified as PROFITABLE ✅
- Dead pair blocking works ✅ — no SOL/USDT/USDC/WIF/FARTCOIN noise
- Meteora excluded from spread checks ✅ — no more 198M% fake spreads
- XDEX cooldown works ✅ — 3s per-pair after all-sizes-fail
- Jupiter rate limit storms eliminated ✅
- Resize loop works ✅ — steps down 40→20→10→4→2→1 SOL
- `executed` scope fix works ✅ — no more callback crashes
- Fallback dead pairs filter works ✅ — no Jupiter budget wasted

**What's NOT working:**
- `computeSwap()` blocks every trade attempt due to overestimated price impact
- Raydium CLMM SOL/BONK gets ZERO WS events — data only from startup seed (goes stale after 120s)
- Need periodic RPC polling for Raydium CLMM to keep data fresh (not just startup seed)

---

## 8. CROSS-DEX SPREAD ANALYSIS (updated Apr 9)

### Per-Pair Viability Assessment

**SOL/BONK — ✅ VIABLE (primary and ONLY target)**
- Orca pool: `5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9` (tickSpacing=8, feeRate=500/1M → **0.05%**)
- Raydium CLMM: `GtKKKs3yaPdHbQd2aZS4SfWhy8zQ988BJGnKNndLxYsN` (tickSpacing=60, feeRate=100/1M → **0.01%**)
- Orca liquidity: **110T** | Raydium liquidity: **94T** (comparable, both deep)
- Cross-DEX spreads: **0.099%–0.24%** observed live on Apr 9
- Combined fees: 0.05% + 0.01% = **0.06%**
- Net spread after fees: **0.04–0.18%** (looks profitable)
- **Blocker:** computeSwap single-tick math says net negative at all sizes (1-40 SOL)
- Direction: consistently Raydium CLMM hi / Orca lo (buy on Orca, sell on Raydium)
- Raydium CLMM gets ZERO WS events — needs periodic RPC polling
- Orca fires WS events every 3-15 seconds

**SOL/USDT — ❌ DEAD** (blocked from XDEX + fallback)
**SOL/USDC — ❌ DEAD** (blocked from XDEX + fallback)
**SOL/WIF — ❌ DEAD** (blocked from XDEX + fallback)
**SOL/FARTCOIN — ❌ DEAD** (blocked from XDEX + fallback)

---

## 9. LATENCY PROFILE

| Stage | Current Time | After Local Build |
|-------|-------------|-------------------|
| WS/gRPC detection | 50–100ms | 10–100ms (gRPC later) |
| Debounce | 50–100ms | 50ms |
| Local math (spread check) | ~0.01ms | ~1ms (exact quote + sizing) |
| Jupiter cooldown wait | **0ms — bypassed** | **0ms — eliminated** |
| Jupiter quote (buy) | **0ms — bypassed** | **0ms — local math** |
| Jupiter quote (sell) | **0ms — bypassed** | **0ms — local math** |
| reSizeScan | **local resize loop** | **0ms — local math** |
| Swap instructions API (2x parallel) | **0ms — local build** | **0ms — local build** |
| Scaling + profitability check | ~1ms | ~1ms |
| Build + sign tx | 11–21ms | 11–21ms |
| Jito submit | 5–50ms | 5–50ms |
| **Total (scan → submit)** | **~120–270ms** | **~80–220ms** |

---

## 10. NEXT ACTIONS — REMAINING WORK

### Immediate (next session):
1. **Fix computeSwap blocker — two options:**
   - **Option A (fast, risky):** Bypass computeSwap profitability gate. Use spread-based check only (spread > fees + buffer). Set conservative slippage thresholds on swap instructions. Trust on-chain execution. Gets first trade attempt fast.
   - **Option B (correct, slower):** Implement multi-tick swap simulation. Walk tick arrays, accumulate output across tick boundaries. Accurate but complex — need to fetch and parse tick array accounts.
   - **Hybrid (recommended):** Use Option A to get first trade attempt, then add Option B for accurate sizing later.

2. **Add periodic RPC polling for Raydium CLMM SOL/BONK** — WS never fires for this pool. Startup seed goes stale after 120s. Need a setInterval (every 30-60s) that fetches Raydium CLMM pool accounts via RPC and calls updatePoolState.

3. **Remove debug logs** — `[DBG-WS]` and `[DBG] BONK pools=` lines in bot.js (temporary, added for this session's debugging).

### Phase 4: Force-route executor
- `executeLocal()` is fully wired for both Orca and Raydium CLMM
- Blocked ONLY by computeSwap profitability gate (see #1 above)
- Once gate is bypassed/fixed → first real on-chain trade attempt
- **Effort: 0.5 day for Option A, 1-2 days for Option B**

### Phase 5: Meteora DLMM (defer)
- Price decode broken for SOL/BONK — needs investigation
- No swap math, no instruction builder
- Complex variable bin arrays

### Phase 6: gRPC + backrunning (defer)
- Do not purchase Chainstack until trades are landing
- gRPC saves ~100ms detection but not the bottleneck anymore

### Projected Timeline
- Phase 1: ✅ COMPLETE
- Phase 2: ✅ COMPLETE
- Phase 3: ✅ COMPLETE
- Phase 4: ~95% done — needs computeSwap fix + Raydium polling + test
- Phase 5: deferred
- Phase 6: deferred until profitability confirmed
- **Total to first trade attempt: 1 session (Option A bypass)**

---

## 11. THINGS THAT WERE TRIED AND FAILED / ABANDONED

(All previous entries unchanged, plus:)

- **computeSwap single-tick approximation (identified Apr 9)** — The CLMM swap math in `localPools.js:computeSwap()` uses a constant-liquidity single-tick formula. For pools with 94-110T liquidity, this MASSIVELY overestimates price impact (6.84 bps at 1 SOL input). At every size from 1-40 SOL, it returns net negative despite 0.10-0.19% observable spreads. The formula is mathematically correct for a single tick but CLMM pools distribute liquidity across ranges — real on-chain impact is much lower than single-tick prediction.
- **`let executed` inside try block (Apr 9)** — Variable was scoped inside `try {}` but referenced outside in the cooldown check at the `if (hasLocalMath)` level. Moved declaration to outer scope.
- **Raydium CLMM WS events (Apr 9)** — `onAccountChange` subscriptions for Raydium CLMM SOL/BONK (`GtKKKs3y...`) produce ZERO events via Helius RPC. Pool exists on-chain, gets traded every 3-8 minutes by others, but WS never fires. Root cause unknown (possibly Helius-specific). Fixed by seeding pool cache at startup via `getMultipleAccountsInfo`.
- **Meteora in checkCrossPoolSpread (Apr 9)** — Meteora price decode for SOL/BONK returns 7.10 instead of ~14.2M BONK/SOL. When included in spread comparison, it created 198 million percent fake spreads that dominated all real Orca/Raydium comparisons. Fixed by excluding Meteora from `checkCrossPoolSpread` entirely.
- **10s maxAge for checkCrossPoolSpread (Apr 9)** — Raydium CLMM pool data was always "stale" because WS never fires. Even after fix, 10s was too short. Increased to 120s, then made moot by startup seeding.

---

## 12. TECHNICAL REFERENCE — LOCAL INSTRUCTION BUILDING

### Pool Addresses & On-Chain Data (verified Apr 9)

**SOL/BONK — PRIMARY ARB TARGET:**
| Pool | Address | Liquidity | Fee | tickSpacing | tickCurrent |
|------|---------|-----------|-----|-------------|-------------|
| Orca ts=8 | `5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9` | 110T | 0.05% (500/1M) | 8 | ~72605 |
| Raydium CLMM | `GtKKKs3yaPdHbQd2aZS4SfWhy8zQ988BJGnKNndLxYsN` | 94T | 0.01% (100/1M) | 60 | ~72626 |

**Verified computeSwap test (Apr 9):**
- Orca sqrtPrice: 695695917330344879148, liquidity: 110095964257768, feeRate: 500n, feeDenom: 1000000n
- Raydium sqrtPrice: 696063265488301775474, liquidity: 94367999704444, feeRate: 100n, feeDenom: 1000000n
- 1 SOL buy on Orca → 1,421,129,300,339 BONK-lamports (correct ~14.2M BONK)
- Sell on Raydium → 997,605,658 SOL-lamports (0.9976 SOL)
- Round-trip loss: 0.24% despite 0.10% spread — single-tick price impact kills it

### Orca Whirlpool Swap Instruction — ✅ IMPLEMENTED (`src/orcaBuilder.js`)
(unchanged from Apr 6 — see previous STATE.md)

### Raydium CLMM Swap Instruction — ✅ IMPLEMENTED (`src/raydiumBuilder.js`)
- **Program:** `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`
- **Discriminator:** `f8c69e91e17587c8` (standard Anchor `swap`, same bytes as Orca)
- **Data (41 bytes):** disc(8) + amount(u64) + otherAmountThreshold(u64) + sqrtPriceLimitX64(u128) + isBaseInput(bool)
- **NOTE:** Inner ix data in getTransaction response is **base58-encoded** (not base64!)
- **Direction:** Determined by account ordering (inputVault/outputVault), NOT by a data field. Only 1 bool (isBaseInput), not 2 like Orca.
- **Account layout (9 fixed + 3 remaining):**
```
[0] payer (signer, writable)
[1] ammConfig (read-only)
[2] poolState (writable)
[3] inputTokenAccount (writable) — user ATA for input token
[4] outputTokenAccount (writable) — user ATA for output token
[5] inputVault (writable) — pool vault for input token
[6] outputVault (writable) — pool vault for output token
[7] observationState (writable)
[8] tokenProgram (read-only)
[9-11] tickArrays (writable, remaining accounts)
```

**Pool state layout (1544 bytes):**
```
offset 0:   discriminator (8 bytes)
offset 8:   bump (1 byte)
offset 9:   ammConfig (32) = E64NGkDLLCdQ2yFNPcavaKptrEgmiQaNykUuLC1Qgwyp
offset 41:  owner (32)
offset 73:  mintA (32) = So11111111111111111111111111111111111111112
offset 105: mintB (32) = DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
offset 137: vaultA (32) = GDnBvA76ZAJ2K3en2F1iExPZ6qz83Xjj5srXMmSKTYDW
offset 169: vaultB (32) = 2wzaFLYb4JcDrVs8TfU3TfkVwq1Pdp3rRgWdNJzFGXud
offset 201: observationKey (32) = Gj8gzDNKmf5y3p1LorKHTvMZ8eCLhbCDnhGiN5xVW8Jq
offset 233: mintDecimals0 (1) = 9 (SOL)
offset 234: mintDecimals1 (1) = 5 (BONK)
offset 235: tickSpacing (u16) = 60
offset 237: liquidity (u128)
offset 253: sqrtPriceX64 (u128)
offset 269: tickCurrent (i32)
```

**Tick array PDA derivation:**
- Seeds: `["tick_array", pool_pubkey, startTickIndex_i32_BE]` (BIG-ENDIAN, not LE!)
- Program: `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`
- TICK_ARRAY_SIZE = 60, ticksPerArray = tickSpacing * 60 = 3600
- startTickIndex = `floor(tickCurrent / ticksPerArray) * ticksPerArray`
- aToB: `[current, current-3600, current-7200]`
- bToA: `[current, current+3600, current+7200]`

**Verified tick arrays for SOL/BONK (tickCurrent ~72563, startIdx=72000):**
- aToB: `72000` → `FohQpHgv...` ✅ | `68400` → `H162txn8...` ✅ | `64800` → `81hDVagG...` ✅
- bToA: `72000` → `FohQpHgv...` ✅ | `75600` → `CiigF62v...` ✅ | `79200` → `AUMHvL8G...` ✅
- Full range 54000–90000 all exist on-chain ✅

**Tick array account structure (10240 bytes):**
- offset 0: discriminator `c09b55cd31f9812a` (8 bytes)
- offset 8: pool address (32 bytes)
- offset 40: startTickIndex (i32 LE)

### Meteora DLMM (deferred — reference only)
- (unchanged)

### What Top MEV Bots Do Differently
- (unchanged)

---

## 13. CODE CHANGES MADE

### Apr 6 session 1 (Phase 1 — XDEX logging)
(unchanged)

### Apr 6 session 2 (Phase 2 — Orca builder + executeLocal)
(unchanged)

### Apr 7 session (Phase 3 — Raydium CLMM builder + bot fixes)
(unchanged)

### Apr 9 session (Pool cache seeding + freshness fixes + dead pair blocking)

**`src/localPools.js` changes:**
1. **lastUpdate unconditional (line 92):** Changed `lastUpdate: priceChanged ? Date.now() : (prev.lastUpdate || Date.now())` → `lastUpdate: Date.now()` — every WS event refreshes lastUpdate regardless of sqrtPrice change
2. **Meteora excluded from checkCrossPoolSpread (line ~183):** Added `if (p.dexType === 'Meteora') continue;` — broken price decode was poisoning spread comparisons

**`src/bot.js` changes:**
1. **`xdexCooldowns` map (line 21):** `const xdexCooldowns = {};` — module-level cooldown tracker
2. **`let executed` declaration (line 272):** Moved from inside try block to `if (hasLocalMath)` scope — was crashing every SOL/BONK callback
3. **XDEX cooldown check (line ~273):** `if (xdexCooldowns[pair.name] && Date.now() - xdexCooldowns[pair.name] < 3000) return;` — 3s cooldown after all-sizes-fail
4. **XDEX dead pairs block (line ~274-275):** `const XDEX_DEAD_PAIRS = ["SOL/USDT", "SOL/USDC", "SOL/WIF", "SOL/FARTCOIN"]; if (XDEX_DEAD_PAIRS.includes(pair.name)) return;`
5. **XDEX cooldown set (line ~311):** `if (!executed) xdexCooldowns[pair.name] = Date.now();`
6. **Resize steps expanded (line ~289):** `LOCAL_STEPS = [1.0, 0.5, 0.25, 0.1, 0.05, 0.025]` — 40→20→10→4→2→1 SOL
7. **maxAge increased (line ~276):** `checkCrossPoolSpread(pair.name, 120000)` — 10s → 120s for Raydium CLMM staleness
8. **XDEX-DBG log removed** (was temporary)
9. **Pool cache seeding at startup (after line 343):** `getMultipleAccountsInfo` bulk fetch for all registered pools → `updatePoolState` — seeds Raydium CLMM into poolCache since WS never fires
10. **Fallback dead pairs filter (line ~390):** `const opps = _rawOpps.filter(o => !["SOL/USDT","SOL/USDC","SOL/WIF","SOL/FARTCOIN"].includes(...))` — stops Jupiter rate limit waste
11. **Debug logs added (TEMPORARY — REMOVE NEXT SESSION):** `[DBG-WS]` on line ~254 and `[DBG] BONK pools=` on line ~409

---

## 14. HOW TO USE THIS FILE

**Start of every new chat:**
Paste sections 3, 5, 7, 8 (just the summary table), and 10 into the new chat as context.

**End of every chat:**
Update whichever sections changed before closing.

**Fields most likely to change:**
- Section 3 (.env values)
- Section 5 (execution flow)
- Section 7 (current status + active error)
- Section 8 (spread analysis — update with new findings)
- Section 10 (next actions — track phase progress)
