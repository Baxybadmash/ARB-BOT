# ARB-BOT STATE.md
*Single source of truth. Update this after every chat session before closing.*
*Last updated: Apr 11, 2026 (BUG 2 FIXED, pipeline hitting chain, blocked on Raydium CLMM tick array PDA derivation — wrong pool state offsets)*

---

## 1. BOT IDENTITY

- **Wallet:** `ESzi3jyKV4EWi1TC36nRwLiHHDVTmzn9iCFTotToyhC3`
- **VPS:** Frankfurt, Ubuntu, PM2 process name: `arb-bot`
- **Start command:** `cd ~/ARB-BOT && pm2 start src/bot.js --name arb-bot`
- **Git:** Private GitHub repo `Baxybadmash/ARB-BOT` — initial clean push completed Apr 10. `.env` properly gitignored, `target/deploy/*-keypair.json` untracked, all junk debug scripts moved to `~/ARB-BOT-scratch/`.
- **Bot folder:** `~/ARB-BOT/`

---

## 2. INFRASTRUCTURE

| Component | Provider | Notes |
|-----------|----------|-------|
| RPC Primary | Helius (`mainnet.helius-rpc.com`) | All general RPC calls |
| RPC Secondary | Shyft (`rpc.shyft.to`) | Kamino SDK only |
| Flashloan | Kamino (replaced MarginFi — error 6080) | Flash loan fee: 0.001% (handled internally by Kamino, do NOT add to repay amount) |
| Swap routing | Local Orca/Raydium CLMM builders only — Jupiter fully bypassed for hasLocalMath pairs | Phase 2+3 complete |
| MEV submission | Jito `sendTransaction` ONLY | No bundles, no direct RPC |
| Process mgr | PM2 | Always `stop + delete + start` — never just restart |
| **ALT** | `FwQUPThn9uVGhtAbfGoqA4tF6XCqfRB8CFkHGc8oYiWX` | 25 addresses, created Apr 11 — required for tx size (34 unique accounts → 907 bytes with ALT vs ~1483 without) |

**Kamino constants:** (unchanged from previous — see prior STATE.md if needed)

---

## 3. CURRENT .ENV VALUES (confirmed Apr 11)

```
MIN_PROFIT_USD=0.05
SLIPPAGE_BPS=100
WS_DEBOUNCE_MS=50
JUPITER_COOLDOWN_MS=3000
JUPITER_RATE_LIMIT_PER_SEC=8
JITO_TIP_LAMPORTS=150000
RPC_URL_PRIMARY=https://mainnet.helius-rpc.com/?api-key=<redacted>
RPC_URL_SECONDARY=https://rpc.shyft.to?api_key=<redacted>
WALLET_PRIVATE_KEY=<redacted — bs58 format>
BYPASS_COMPUTESWAP=1    # pipeline test mode flag
FORCE_EXEC=1            # bypasses profitability gate for diagnostic forcing
ALT_ADDRESS=FwQUPThn9uVGhtAbfGoqA4tF6XCqfRB8CFkHGc8oYiWX   # NEW Apr 11
```

**⚠️ Both `BYPASS_COMPUTESWAP=1` and `FORCE_EXEC=1` MUST be set to 0 (or removed) before production.**
- `BYPASS_COMPUTESWAP=1` skips the computeSwap profitability check but still uses computeSwap to *display* loss estimates in logs (which is why Discord alerts show negative numbers).
- `FORCE_EXEC=1` makes every XDEX firing call `executeLocal()` regardless of spread vs fees — burns Jito tips at ~$0.004/attempt. **Critical to disable once Raydium tick array bug is fixed.**

**Hardcoded in source (not in .env):** (unchanged from previous)

---

## 4. TRADING PAIRS & POOL COVERAGE

(unchanged from previous — 5 pairs, 45 WS subs, only SOL/BONK viable)

---

## 5. EXECUTION FLOW (current as of Apr 11)

```
WS pool event
  → debounce 50ms per pair
  → if dex === 'Raydium AMM': return (dormant)
  → if hasLocalMath (Orca/Raydium CLMM/Meteora):
      → updatePoolState()
      → xdexCooldowns check: 3s cooldown per pair (CURRENTLY BROKEN — fires every callback)
      → XDEX_DEAD_PAIRS check: ["SOL/USDT","SOL/USDC","SOL/WIF","SOL/FARTCOIN"] → return
      → checkCrossPoolSpread(pair, 120000ms maxAge)
        → Meteora EXCLUDED from spread comparison (broken price decode)
        → Groups by dexType, picks highest-liquidity pool per DEX
      → IF spread found AND (FORCE_EXEC=1 OR profitable):
          → IF both pools are Orca or Raydium CLMM:
              → Resize loop: 40→20→10→4→2→1 SOL
              → executor.executeLocal() — picks builder per pool dexType
              → ALT loaded via _getAltAccount() (cached after first fetch)
              → Kamino flashloan wrap → compileToV0Message([altAccount]) → sign → Jito submit
              → 🔴 CURRENT: Raydium swap fails on-chain with Custom:3007 (wrong tick array PDAs)
      → return (ALWAYS — never fall through to Jupiter for hasLocalMath pairs)
  → Fallback slot scanner: dead pairs filtered out before tryExecute
  → Jupiter scan path (fully bypassed for hasLocalMath pairs)
```

---

## 6. KEY DECISIONS & WHY (never undo these without reading this)

(All previous entries unchanged, plus new Apr 11 entries:)

| Decision | Reason |
|----------|--------|
| `buyPool: hiPool, sellPool: loPool` (FLIPPED Apr 10) | hi/lo refer to BONK-per-SOL price ratio. hiPool = more BONK per SOL = buy there. loPool = less BONK per SOL = sell there. |
| 429 retry patch is `if (true) { break; }` | See Apr 10 entry in previous STATE.md |
| `BYPASS_COMPUTESWAP` env flag | computeSwap single-tick math overestimates price impact. Bypass lets pipeline reach submission. |
| `FORCE_EXEC` env flag | Diagnostic only. Forces executeLocal even on sub-fee spreads. |
| ALT required for local executor (Apr 11) | 34 unique accounts across 10 instructions = ~1483 bytes without ALT, exceeds 1232-byte tx limit. ALT reduces to 907 bytes. `compileToV0Message([altAccount])` in executor.js. ALT address: `FwQUPThn9uVGhtAbfGoqA4tF6XCqfRB8CFkHGc8oYiWX` |
| `sellThreshold = BYPASS_COMPUTESWAP ? 1n : amountBigInt` (Apr 11) | In bypass mode, sell threshold of 1 lamport prevents Raydium from rejecting on slippage. Flashloan atomic revert is the real safety net. |
| `writeInt32LE` for Raydium tick array PDA seed (Apr 11) | Was `writeInt32BE` — wrong endianness. Raydium CLMM uses LE i32 for tick array PDA seeds. Orca uses string representation. |
| Raydium CLMM `Custom:1` was NOT slippage (Apr 11) | Initial hypothesis was slippage threshold. Actual cause: BE tick array derivation produced wrong PDAs → account owned by wrong program. |

---

## 7. CURRENT STATUS (Apr 11, 2026)

**No successful trade has landed yet. Pipeline reaches on-chain execution. Orca swap succeeds. Raydium CLMM swap fails with Custom:3007.**

**Active error:** `InstructionError:[7,{"Custom":3007}]` = "AccountOwnedByWrongProgram" on the Raydium CLMM swap (ix[7]).

**Root cause identified but NOT yet fixed:** The pool state layout offsets used to read `tickCurrent` and `tickSpacing` from the Raydium CLMM pool are WRONG. Reading at offset 253 (tickCurrent) and 29 (tickSpacing) returns `tickCurrent: -1281521618` and `tickSpacing: 64610` — both nonsensical values. Standard Raydium CLMM tick spacings are 1, 10, 60, or 120. This means every tick array PDA derived from these values is garbage — they point to accounts not owned by the Raydium program.

**Bot is currently:** STOPPED.

### What WAS fixed in Apr 11 session:

1. ✅ **BUG 2 — Encoding overrun FIXED** — Root cause was tx size: 34 unique accounts × 32 bytes = 1088 bytes for account keys alone, exceeding the 1232-byte tx limit. Fixed by creating an on-chain Address Lookup Table (ALT) with 25 fixed addresses and passing it to `compileToV0Message([altAccount])`. Tx size dropped from ~1483 to **907 bytes**. `_getAltAccount()` function added to executor.js with lazy caching.

2. ✅ **Raydium tick array endianness FIXED** — `raydiumBuilder.js` line 18: `writeInt32BE` → `writeInt32LE`. Error changed from `Custom:1` to `Custom:3007`, confirming the endianness was one layer of the problem.

3. ✅ **Sell threshold FIXED** — `sellThreshold = BYPASS_COMPUTESWAP ? 1n : amountBigInt` — prevents Raydium from rejecting on slippage check during forced pipeline testing.

4. ✅ **First on-chain transaction execution confirmed** — Kamino borrow (40 SOL) ✅, Orca swap (40 SOL → 557M BONK) ✅, Raydium swap attempted (fails with Custom:3007). All txs revert atomically — only cost is Jito tip + base fee (~$0.005/attempt).

5. ✅ **Real latency numbers captured** — see Section 9.

### What's NOT working:

#### 🔴 BUG 5 — Raydium CLMM pool state layout offsets wrong (PRIMARY BLOCKER)

**Evidence:**
- `node -e` reading offset 253 for tickCurrent → returns `-1281521618` (nonsensical)
- `node -e` reading offset 29 for tickSpacing → returns `64610` (nonsensical — should be 1/10/60/120)
- Tick arrays derived from these values are valid PDAs but NOT owned by Raydium CLMM program
- On-chain error: `Custom:3007` = "AccountOwnedByWrongProgram"

**Fix required:** Find the correct offsets for `tickCurrent` (i32) and `tickSpacing` (u16) in the Raydium CLMM pool state layout. Options:
1. Check Raydium CLMM SDK/IDL for the `PoolState` struct layout
2. Cross-reference a known pool's on-chain data with expected values (e.g., look up the pool on Raydium UI to get current tick, then scan the account data for that value)
3. Check `localPools.js` offsets `RAYDIUM.TICK_CURRENT` and see what values they're set to

**Quick diagnostic for next session:**
```bash
grep -n "RAYDIUM\.\|TICK_CURRENT\|TICK_SPACING\|tickCurrent\|tickSpacing" src/localPools.js | head -20
```

#### 🔴 BUG 3 — XDEX cooldown not working (SECONDARY BLOCKER)

Still broken. Stats from Apr 11 run: `Detected: 12, Attempted: 12` in ~75s. Every XDEX detection fires. The cooldown `if` check passes every time. Must fix before production — currently spamming 60+ Jito submissions/min with FORCE_EXEC on.

### What IS working (confirmed Apr 11 session):

- Pipeline end-to-end: WS → spread → build → ALT → sign → Jito submit → on-chain execution ✅
- ALT loaded and applied correctly (25 addresses, tx size 907 bytes) ✅
- Kamino flash borrow 40 SOL ✅
- Orca Whirlpool swap (SOL → BONK) executes on-chain ✅
- Raydium CLMM swap reaches on-chain (input transfer happens, then fails on tick arrays) ✅
- Kamino flash repay instruction present and correctly structured ✅
- WSOL close account instruction present ✅
- Jito accepted via frankfurt/amsterdam/mainnet consistently ✅
- Direction flip correct (buy Orca, sell Raydium) ✅
- 429 storms eliminated ✅
- Latency: 148–462ms total (see Section 9) ✅

---

## 8. CROSS-DEX SPREAD ANALYSIS (Apr 11 update)

### SOL/BONK — ✅ VIABLE (only target)
- Spreads observed during Apr 11 session: **0.01% to 0.18%** (highly variable)
- Wider spreads observed than Apr 10 (up to 0.18% vs 0.20%)
- Direction: **Orca hi (more BONK/SOL), Raydium CLMM lo (less BONK/SOL)** — confirmed
- Buy on Orca, sell on Raydium CLMM
- Raydium CLMM SOL/BONK pool STILL gets ZERO WS events from Helius — relies entirely on startup seed
- Orca pool fires WS events every 3-15s

### All other pairs — ❌ DEAD (blocked from XDEX + fallback)

---

## 9. LATENCY PROFILE (REAL DATA — Apr 11)

First real latency measurements captured. ALT is fetched once and cached.

| Stage | Measured | Notes |
|-------|----------|-------|
| Gate (computeSwap check) | 1–8ms | Bypassed in test mode |
| Build (blockhash + ALT + compile) | 109–329ms | Includes getLatestBlockhash RPC call (~100-200ms) |
| Sign | 10–71ms | First sign ~60ms (cold), subsequent ~15ms |
| Submit (Jito sendTransaction) | 19–109ms | First submit ~100ms, subsequent ~25ms |
| **TOTAL** | **148–462ms** | Median ~220ms after warmup |

**Projected production latency:** ~150-250ms (remove DBG logging overhead, cached blockhash possible).

---

## 10. NEXT ACTIONS — STARTING POINT FOR NEXT SESSION

### 🎯 IMMEDIATE GOAL: Fix BUG 5 (Raydium CLMM pool state offsets)

**Step 1 — Find correct offsets:**
```bash
grep -n "RAYDIUM\.\|TICK_CURRENT\|TICK_SPACING\|tickCurrent\|tickSpacing" src/localPools.js | head -30
```

Check what offsets `localPools.js` uses for the Raydium CLMM pool state decode. The offsets used there (for `sqrtPrice`, `tickCurrent`, `tickSpacing`) may be wrong.

**Step 2 — Cross-reference with Raydium SDK:**
```bash
find ~/ARB-BOT/node_modules -path '*raydium*' -name '*.js' | xargs grep -l "tickCurrent\|tick_current" 2>/dev/null | head
```

Find the Raydium SDK's pool state layout definition and compare offsets.

**Step 3 — Binary scan for known tick value:**
Look up the SOL/BONK pool on Raydium UI or birdeye.so to get the approximate current tick. Then scan the pool account data for that value at various offsets:
```bash
node -e "
const {Connection,PublicKey} = require('@solana/web3.js');
require('dotenv').config();
const conn = new Connection(process.env.RPC_URL_PRIMARY);
conn.getAccountInfo(new PublicKey('GtKKKs3yaPdHbQd2aZS4SfWhy8zQ988BJGnKNndLxYsN')).then(a => {
    // Scan for tickSpacing values that make sense (1, 10, 60, 120)
    for (let off = 0; off < 300; off++) {
        const v = a.data.readUInt16LE(off);
        if (v === 1 || v === 10 || v === 60 || v === 120) {
            console.log('tickSpacing candidate at offset', off, '=', v);
        }
    }
    // Also try reading tickCurrent at various offsets
    for (let off = 0; off < 300; off += 4) {
        const v = a.data.readInt32LE(off);
        if (v > -500000 && v < 500000 && v !== 0) {
            console.log('tickCurrent candidate at offset', off, '=', v);
        }
    }
});
"
```

**Step 4 — Once correct offsets found:**
- Update `localPools.js` RAYDIUM offset constants
- Verify tick array PDA derivation produces accounts owned by Raydium CLMM program
- Test one cycle with FORCE_EXEC

### 🎯 AFTER BUG 5 IS FIXED:

1. **Verify Raydium swap executes on-chain** — expect `Custom:6xxx` from Kamino repay (trade is unprofitable, flashloan revert is correct behavior)
2. **Disable `FORCE_EXEC=1`** and `BYPASS_COMPUTESWAP=1` in `.env`
3. **Fix BUG 3 (cooldown)** — needed before production
4. **Tighten slippage buffer** — `buyBufferPct = 90n` → `98n` or `99n`
5. **Remove debug instrumentation** — `[DBG]` block in executor.js, `[DBG-WS]` and `[DBG] BONK pools=` in bot.js
6. **Git commit all Apr 10+11 changes**

### 🎯 PHASE PROGRESS:

- Phase 1 (XDEX logging): ✅ COMPLETE
- Phase 2 (Orca local builder): ✅ COMPLETE — confirmed on-chain
- Phase 3 (Raydium CLMM local builder): ⚠️ 95% — builder code correct, tick array PDA derivation uses wrong pool state offsets
- Phase 4 (Force-route executor): ⚠️ 95% — blocked by BUG 5 (Raydium tick arrays)
- Phase 5 (Meteora DLMM): deferred
- Phase 6 (gRPC + backrunning): deferred until trades are landing

---

## 11. THINGS THAT WERE TRIED AND FAILED / ABANDONED

(All previous entries unchanged, plus Apr 11 additions:)

- **BUG 2 was NOT a web3.js library bug** — Hypothesis #1 from Apr 10 STATE.md was wrong. web3.js version 1.98.4 is current. The real cause was tx size: 34 unique accounts × 32 bytes exceeded 1232-byte limit. Fixed with ALT.

- **BUG 2 was NOT a buffer view/copy issue** — Hypothesis #2 from Apr 10 STATE.md was wrong. All buffers are true copies via `Buffer.alloc()`.

- **BUG 2 was NOT a Kamino borrow data length issue** — Hypothesis #3 was wrong. IDL confirms borrow = 16 bytes (8 disc + 8 u64), repay = 17 bytes (8 disc + 8 u64 + 1 u8). Asymmetry is intentional.

- **`Custom:1` on Raydium was NOT a slippage/threshold issue** — Initial hypothesis was that `sellThreshold = amountBigInt` (40 SOL) was too high. Setting to `1n` didn't fix `Custom:1`. Real cause was `writeInt32BE` → should be `writeInt32LE` for tick array PDA seeds.

- **Raydium CLMM pool state offsets 253 (tickCurrent) and 29 (tickSpacing) are WRONG** — Returns `tickCurrent: -1281521618` and `tickSpacing: 64610`. Need to find correct offsets from Raydium SDK/IDL.

---

## 12. TECHNICAL REFERENCE — LOCAL INSTRUCTION BUILDING

(unchanged from previous — Orca Whirlpool builder, Raydium CLMM builder, pool addresses, layouts, PDA derivation)

**NEW: Raydium CLMM pool state offset issue:**
- Offsets 253/29 are WRONG for tickCurrent/tickSpacing
- Correct offsets TBD — need Raydium SDK cross-reference
- Pool: `GtKKKs3yaPdHbQd2aZS4SfWhy8zQ988BJGnKNndLxYsN`
- On-chain mintA: `So11111111111111111111111111111111111111112` (SOL)
- On-chain mintB: `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` (BONK)

---

## 13. CODE CHANGES

### APR 10 SESSION:

**`src/bot.js`:**
1. Lines 300–301: `buyPool: xSpread.loPool` → `buyPool: xSpread.hiPool`, `sellPool: xSpread.hiPool` → `sellPool: xSpread.loPool`. Added 3-line comment explaining hi/lo semantics.
2. Line 285: `const profitable = xSpread.spreadPct > feeSum;` → `const profitable = process.env.FORCE_EXEC === '1' ? true : (xSpread.spreadPct > feeSum);`

**`src/executor.js`:**
1. Line ~1063: Added `const _LAT = { t0: Date.now() };` and `const BYPASS_COMPUTESWAP = process.env.BYPASS_COMPUTESWAP === '1';` at top of `executeLocal`.
2. Lines ~1109–1117: Wrapped existing profitability gate in `if (BYPASS_COMPUTESWAP) { ... } else { ... }` block. Added `_LAT.tGate = Date.now();` after.
3. Lines ~1133–1135: Replaced fixed `97n / 100n` slippage buffer with `buyBufferPct = BYPASS_COMPUTESWAP ? 90n : 97n` and `sellThreshold = amountBigInt`.
4. Line ~1267: Added `[DBG] innerIxs.length=...` block with per-ix logging right before `getLatestBlockhash`.
5. Line ~1267: Added `_LAT.tBuildStart = Date.now();` after `getLatestBlockhash`.
6. Line ~1294: Added `_LAT.tSigned = Date.now();` before `bs58.encode(serializedBuf)`.
7. Line ~1322: Added `_LAT.tSubmitted = Date.now();` and `[LAT]` log line before `if (directSig)`.
8. Line ~1347: Added `logger.error(\`[LocalExec] Stack: ${e.stack}\`);` in catch block.

**`.env` (Apr 10):**
1. Added `BYPASS_COMPUTESWAP=1`
2. Added `FORCE_EXEC=1`

**`node_modules` patches (will be reverted by `npm install` — re-apply if needed):**
1. `node_modules/@solana/web3.js/lib/index.cjs.js`: `if (res.status !== 429 ...) { break; }` → `if (true) { /* ARB-BOT 429 disabled */ break; }`
2. Same patch in `node_modules/jito-ts/node_modules/@solana/web3.js/lib/index.cjs.js` (and `.native.js`, `.iife.js`, `.esm.js`, `.browser.cjs.js`, `.browser.esm.js`)
3. Same patch in `node_modules/@mrgnlabs/marginfi-client-v2/node_modules/@solana/web3.js/lib/index.cjs.js`
4. `node_modules/jito-ts/dist/sdk/rpc/connection.js` line ~197: same patch (this file has its OWN retry loop, not bundled web3.js)

### APR 11 SESSION:

**`src/executor.js`:**
1. Lines 71–81: Added `_getAltAccount()` function and `_cachedAltAccount` variable after KAMINO_PROGRAM_ID declaration (via `sed -i '68a\...'`)
2. Line ~1313: Added `const altAccount = await _getAltAccount(this.connection);` before `getLatestBlockhash`
3. Line ~1322: Changed `.compileToV0Message()` → `.compileToV0Message(altAccount ? [altAccount] : [])` with comment `// ALT for size reduction`
4. Line 1159: Changed `const sellThreshold = amountBigInt;` → `const sellThreshold = BYPASS_COMPUTESWAP ? 1n : amountBigInt;`
5. DBG block updated: now prints full base58 for all keys (`.slice(0,12)` removed), includes per-key `s=` `w=` `len=` `b58=` dump

**`src/raydiumBuilder.js`:**
1. Line 18: `buf.writeInt32BE(startTickIndex)` → `buf.writeInt32LE(startTickIndex)`

**`.env` (Apr 11):**
1. Added `ALT_ADDRESS=FwQUPThn9uVGhtAbfGoqA4tF6XCqfRB8CFkHGc8oYiWX`

**New files created:**
1. `scripts/create_alt.js` — ALT creation script (25 addresses)

### Backup files in `~/`:
- `~/executor.js.pre-bypass.<ts>`
- `~/executor.js.pre-edit2-4-v2.<ts>`
- `~/executor.js.pre-stack.<ts>`
- `~/executor.js.pre-debug.<ts>`
- `~/executor.js.pre-hexdump.<ts>`
- `~/bot.js.pre-flipfix.<ts>`
- `~/bot.js.pre-force.<ts>`
- `~/executor.js.pre-keydump.<ts>`
- `~/executor.js.pre-alt.<ts>`

### Git status at session end:
- Apr 10 commit `4f59791` on `origin/main`
- All Apr 10 + Apr 11 changes are LOCAL only — not yet committed
- `.env`, `*-keypair.json`, `target/`, `*.bak*` properly gitignored

---

## 14. HOW TO USE THIS FILE

**Start of every new chat:**
Paste sections 3, 5, 7, 10 into the new chat as context. Section 7 is the most important — it tells you exactly where the last session left off.

**End of every chat:**
Update sections 3, 5, 7, 10, 11, 13 before closing. Update Section 9 if real latency numbers were captured.

**Critical reminders for next session:**
1. BUG 5 (Raydium pool state offsets) is the PRIMARY BLOCKER — check `localPools.js` offsets first
2. `BYPASS_COMPUTESWAP=1` and `FORCE_EXEC=1` are still set in `.env` — disable before production
3. BUG 3 (cooldown) still broken — fix before production
4. After any `npm install`, re-apply all 429 patches (Section 13 from Apr 10 entry)
5. PM2 caches modules — always `pm2 kill` or `stop + delete + start`
6. `pm2 logs` shows cached output — truncate log files before fresh runs
7. ALT address: `FwQUPThn9uVGhtAbfGoqA4tF6XCqfRB8CFkHGc8oYiWX` — do NOT recreate unless accounts change
