// src/loanSizer.js
// ============================================================
//  OPTIMAL LOAN SIZER
//
//  Three-layer system:
//  1. Pool reserve fetcher  — real liquidity from Orca (cached 5 min)
//  2. AMM formula           — analytical optimal: sqrt(r_in * r_out) - r_in
//  3. Safety cap            — never exceed POOL_DEPTH_CAP% of pool reserve
//
//  Execution:
//  - AMM formula gives instant starting point (0 extra API calls)
//  - 3 fine probes refine around that point (vs blind 8-probe search)
//  - Falls back to 5-probe coarse search if pool data unavailable
// ============================================================
const axios  = require('axios');
const logger = require('./logger');

const SOL_MINT      = 'So11111111111111111111111111111111111111112';
const POOL_DEPTH_CAP = parseFloat(process.env.POOL_DEPTH_CAP || '0.05'); // 5% of pool depth

// -------------------------------------------------------
//  POOL RESERVE CACHE  (refreshed every 5 minutes)
// -------------------------------------------------------
let _poolCache     = null;
let _poolCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchOrcaPools() {
    if (_poolCache && Date.now() - _poolCacheTime < CACHE_TTL_MS) return _poolCache;
    try {
        const res = await axios.get('https://api.mainnet.orca.so/v1/whirlpool/list', { timeout: 8000 });
        _poolCache     = res.data.whirlpools || [];
        _poolCacheTime = Date.now();
        logger.debug(`[loanSizer] Pool cache updated: ${_poolCache.length} Orca pools`);
    } catch (e) {
        logger.debug(`[loanSizer] Orca pool fetch failed (using cache): ${e.message}`);
        _poolCache = _poolCache || [];
    }
    return _poolCache;
}

function findOrcaPool(pools, pair) {
    return pools.find(p =>
        (p.tokenA?.mint === pair.tokenA && p.tokenB?.mint === pair.tokenB) ||
        (p.tokenA?.mint === pair.tokenB && p.tokenB?.mint === pair.tokenA)
    ) || null;
}

// -------------------------------------------------------
//  AMM FORMULA
//  For a constant-product pool (x * y = k), the input size
//  that maximises single-hop profit is:
//      optimal = sqrt(reserve_in * reserve_out) - reserve_in
//  Source: standard AMM arbitrage derivation (Uniswap/Orca)
// -------------------------------------------------------
function calcAmmOptimal(reserveIn, reserveOut) {
    if (!reserveIn || !reserveOut || reserveIn <= 0 || reserveOut <= 0) return null;
    const optimal = Math.sqrt(reserveIn * reserveOut) - reserveIn;
    return optimal > 0 ? Math.floor(optimal) : null;
}

// -------------------------------------------------------
//  SAFETY CAP
//  Cap at POOL_DEPTH_CAP% of the pool's input-side reserve.
//  Only applied when input token is SOL (lamport units known).
// -------------------------------------------------------
function calcSafetyCap(pool, pair, configMaxLamports) {
    if (!pool) return configMaxLamports;

    const isTokenAInput  = pool.tokenA?.mint === pair.tokenA;
    const reserveRaw     = isTokenAInput ? pool.tokenA?.amount : pool.tokenB?.amount;

    if (!reserveRaw || pair.tokenA !== SOL_MINT) return configMaxLamports;

    const reserveLamports = parseFloat(reserveRaw);
    const cap = Math.floor(reserveLamports * POOL_DEPTH_CAP);

    logger.debug(
        `[loanSizer] Pool reserve: ${(reserveLamports / 1e9).toFixed(0)} SOL | ` +
        `safety cap (${(POOL_DEPTH_CAP * 100).toFixed(0)}%): ${(cap / 1e9).toFixed(1)} SOL`
    );

    return Math.min(cap, configMaxLamports);
}

// -------------------------------------------------------
//  SINGLE PROBE  — delegates to scanner.scanPair
// -------------------------------------------------------
async function probe(scanner, pair, amountLamports) {
    const result = await scanner.scanPair(pair, amountLamports, amountLamports);
    if (!result || result.grossProfit <= 0n) return null;
    return {
        size:           amountLamports,
        grossProfit:    result.grossProfit,
        bestBuyQuote:   result.bestBuyQuote,
        reverseQuote:   result.reverseQuote,
        bestDex:        result.bestDex,
        amountAfterBuy: result.amountAfterBuy,
    };
}

// -------------------------------------------------------
//  FIND OPTIMAL LOAN SIZE
// -------------------------------------------------------
async function findOptimalLoanSize(scanner, pair, minLamports, configMaxLamports) {
    // Step 1: fetch pool reserves (cached — usually 0ms latency)
    const pools   = await fetchOrcaPools();
    const pool    = findOrcaPool(pools, pair);

    // Step 2: safety cap from real pool depth
    // If Orca fetch failed entirely (empty cache), use conservative 10% cap to avoid
    // submitting against unknown liquidity depth.
    const safeMax = pool
        ? calcSafetyCap(pool, pair, configMaxLamports)
        : pools.length === 0
            ? Math.floor(configMaxLamports * 0.10) // fetch failed — be conservative
            : configMaxLamports;                    // pool not on Orca — use config max
    const clampedMin = Math.min(minLamports, safeMax);

    // Step 3: AMM formula analytical estimate
    const isTokenAInput = pool?.tokenA?.mint === pair.tokenA;
    const reserveIn     = parseFloat(isTokenAInput ? pool?.tokenA?.amount : pool?.tokenB?.amount) || 0;
    const reserveOut    = parseFloat(isTokenAInput ? pool?.tokenB?.amount : pool?.tokenA?.amount) || 0;
    const ammOptimal    = calcAmmOptimal(reserveIn, reserveOut);

    let searchCenter;
    if (ammOptimal && ammOptimal >= clampedMin && ammOptimal <= safeMax) {
        // AMM formula gave a valid in-range estimate — use it as center
        searchCenter = ammOptimal;
        logger.debug(
            `[loanSizer:${pair.name}] AMM optimal: ${(ammOptimal / 1e9).toFixed(1)} SOL`
        );
    } else {
        // No pool data or out of range — coarse 5-probe search to find peak
        const COARSE = 5;
        const coarseSizes = Array.from({ length: COARSE }, (_, i) =>
            Math.round(clampedMin + (i / (COARSE - 1)) * (safeMax - clampedMin))
        );
        const coarseResults = await Promise.all(
            coarseSizes.map(s => probe(scanner, pair, s).catch(() => null))
        );
        let peakIdx = 0;
        for (let i = 1; i < coarseResults.length; i++) {
            if ((coarseResults[i]?.grossProfit ?? -1n) > (coarseResults[peakIdx]?.grossProfit ?? -1n)) peakIdx = i;
        }
        if (!coarseResults[peakIdx] || coarseResults[peakIdx].grossProfit <= 0n) return null;
        searchCenter = coarseSizes[peakIdx];
        logger.debug(`[loanSizer:${pair.name}] coarse peak: ${(searchCenter / 1e9).toFixed(1)} SOL`);
    }

    // Step 4: 3 fine probes bracketing the center (lo, center, hi)
    const bracket = Math.floor((safeMax - clampedMin) / 4);
    const lo  = Math.max(clampedMin, searchCenter - bracket);
    const hi  = Math.min(safeMax,    searchCenter + bracket);
    const mid = Math.round((lo + hi) / 2);

    const fineResults = await Promise.all(
        [lo, mid, hi].map(s => probe(scanner, pair, s).catch(() => null))
    );

    let best = null;
    for (const r of fineResults) {
        if (r && r.grossProfit > (best?.grossProfit ?? -1n)) best = r;
    }

    if (!best || best.grossProfit <= 0n) return null;

    logger.debug(
        `[loanSizer:${pair.name}] optimal: ${(best.size / 1e9).toFixed(1)} SOL | ` +
        `profit: ${(Number(best.grossProfit) / 1e9).toFixed(6)} SOL`
    );

    return best;
}

module.exports = { findOptimalLoanSize };
