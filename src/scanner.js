// src/scanner.js
// ============================================================
//  PRICE SCANNER
//  Uses Jupiter aggregated routing for both buy and sell legs.
//  2 API calls per pair per scan (vs 12 before) — stays well
//  within Jupiter free tier (10 RPS).
//
//  Strategy:
//    Phase 1: probe buy quote at minAmountIn (1 call/pair)
//    Phase 2: if spread looks good, get sell quote (1 call/pair)
//    Execute if sellOut > loanIn (round-trip profitable)
//
//  Jupiter's aggregated routing naturally exploits cross-DEX
//  price differences — it routes buy through the cheapest pool
//  and sell through the most expensive pool.
// ============================================================
const axios  = require('axios');
const logger = require('./logger');
const { loadPairs } = require('./pairUpdater');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Use authenticated endpoint when API key present (higher rate limit),
// otherwise fall back to the public lite endpoint.
const JUPITER_QUOTE_API = process.env.JUPITER_API_KEY
    ? 'https://api.jup.ag/swap/v1/quote'
    : 'https://lite-api.jup.ag/swap/v1/quote';

// Global 429 backoff state
let _rateLimitedUntil = 0;
const RATE_LIMIT_PAUSE_MS = 60 * 1000;

// Serial API queue — all Jupiter calls go through here, spaced apart to avoid rate limits.
// Default: 100ms (free tier). Set JUPITER_CALL_INTERVAL_MS=0 with a paid API key.
const CALL_INTERVAL_MS = parseInt(process.env.JUPITER_CALL_INTERVAL_MS || '100');
let _apiQueue = Promise.resolve();

function _enqueue(fn) {
    return new Promise((resolve, reject) => {
        _apiQueue = _apiQueue.then(async () => {
            try { resolve(await fn()); } catch (e) { reject(e); }
            await new Promise(r => setTimeout(r, CALL_INTERVAL_MS));
        });
    });
}

// -------------------------------------------------------
//  DEFAULT PAIRS — all SOL-based (tokenA = SOL)
// -------------------------------------------------------
// Top 5 pairs by arb potential — fewer pairs = faster full scan (~3.5s vs 9.5s)
// Meme coins chosen for high volatility and multi-DEX presence.
// USDT anchor kept as it shows persistent small spreads.
const DEFAULT_PAIRS = [
    { name: 'SOL/USDT',   tokenA: SOL_MINT, tokenB: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimalsA: 9, decimalsB: 6,  isAnchor: true },
    { name: 'SOL/BONK',   tokenA: SOL_MINT, tokenB: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimalsA: 9, decimalsB: 5 },
    { name: 'SOL/WIF',    tokenA: SOL_MINT, tokenB: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimalsA: 9, decimalsB: 6 },
    { name: 'SOL/POPCAT', tokenA: SOL_MINT, tokenB: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',  decimalsA: 9, decimalsB: 9 },
    { name: 'SOL/JUP',    tokenA: SOL_MINT, tokenB: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  decimalsA: 9, decimalsB: 6 },
];

// -------------------------------------------------------
function _normalizePair(pair) {
    if (pair.tokenA === SOL_MINT) return pair;
    if (pair.tokenB === SOL_MINT) {
        return { ...pair, name: `SOL/${pair.name.split('/')[0]}`, tokenA: SOL_MINT, tokenB: pair.tokenA, decimalsA: 9, decimalsB: pair.decimalsA };
    }
    const symbol = pair.name.split('/')[0];
    return { ...pair, name: `SOL/${symbol}`, tokenA: SOL_MINT, tokenB: pair.tokenA, decimalsA: 9, decimalsB: pair.decimalsA };
}

// -------------------------------------------------------
//  JUPITER QUOTE  (rate-limit aware)
// -------------------------------------------------------
async function _jupiterQuote(inputMint, outputMint, amount, extraParams = {}) {
    return _enqueue(async () => {
        const now = Date.now();
        if (now < _rateLimitedUntil) {
            logger.debug(`[Scanner] Rate limited — skipping (${Math.ceil((_rateLimitedUntil - now) / 1000)}s remaining)`);
            return null;
        }
        try {
            const response = await axios.get(JUPITER_QUOTE_API, {
                params: {
                    inputMint,
                    outputMint,
                    amount,
                    slippageBps:         parseInt(process.env.SLIPPAGE_BPS || '50'),
                    asLegacyTransaction: false,
                    maxAccounts:         parseInt(process.env.JUPITER_MAX_ACCOUNTS || '14'),
                    ...extraParams
                },
                timeout: 4000,
                headers: process.env.JUPITER_API_KEY
                    ? { 'x-api-key': process.env.JUPITER_API_KEY }
                    : {},
            });
            return response.data;
        } catch (e) {
            if (e.response?.status === 429) {
                _rateLimitedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
                logger.warn(`[Scanner] Jupiter rate limit hit — pausing quotes for ${RATE_LIMIT_PAUSE_MS / 1000}s`);
            } else {
                logger.debug(`Jupiter quote error: ${e.message}`);
            }
            return null;
        }
    });
}

// -------------------------------------------------------
class PriceScanner {
    constructor(connection) {
        this.connection  = connection;
        this.activePairs = this._loadActivePairs();
        this.slotCounter = 0;
        this.SCAN_EVERY_N_SLOTS = parseInt(process.env.SCAN_EVERY_N_SLOTS || '3');
    }

    _loadActivePairs() {
        const saved = loadPairs();
        if (saved && saved.length > 0) {
            const normalized = saved.map(_normalizePair);
            logger.info(`[Scanner] Loaded ${normalized.length} pairs from pairs.json`);
            return normalized;
        }
        logger.info(`[Scanner] Using ${DEFAULT_PAIRS.length} default pairs`);
        return DEFAULT_PAIRS;
    }

    reloadPairs() {
        const prev = this.activePairs.length;
        this.activePairs = this._loadActivePairs();
        logger.info(`[Scanner] Pairs reloaded: ${prev} → ${this.activePairs.length}`);
        this._logActivePairs();
    }

    _logActivePairs() {
        logger.info('[Scanner] Active pairs:');
        this.activePairs.forEach((p, i) => {
            const tag = p.isAnchor ? ' [anchor]' : '';
            logger.info(`  ${i + 1}. ${p.name}${tag}`);
        });
    }

    shouldScanThisSlot() {
        this.slotCounter++;
        return this.slotCounter % this.SCAN_EVERY_N_SLOTS === 0;
    }

    // -------------------------------------------------------
    //  SCAN ONE PAIR
    //  Phase 1: buy probe at minAmountIn  (1 call)
    //  Phase 2: sell at optimal size      (1 call)
    //  Total: 2 API calls per pair
    // -------------------------------------------------------
    async scanPair(pair, minAmountIn, maxAmountIn) {
        // Phase 1 — buy probe to check liquidity and spread direction
        const buyProbe = await _jupiterQuote(pair.tokenA, pair.tokenB, minAmountIn);
        if (!buyProbe || !buyProbe.outAmount) return null;

        const tokenOut = BigInt(buyProbe.outAmount);
        if (tokenOut === 0n) return null;

        // Phase 2 — sell at same size, reverse direction
        const sellProbe = await _jupiterQuote(pair.tokenB, pair.tokenA, tokenOut.toString());
        if (!sellProbe || !sellProbe.outAmount) return null;

        const solBack = BigInt(sellProbe.outAmount);
        if (solBack === 0n) return null;

        // Check round-trip profitability at min size
        const probeProfit  = solBack - BigInt(minAmountIn);
        const spreadPct    = Number(probeProfit) / minAmountIn;

        // Sanity check — spread above 50% is a data error (API blip / decimal mismatch)
        if (spreadPct > 0.50) {
            logger.warn(`[${pair.name}] Implausible spread ${(spreadPct * 100).toFixed(2)}% — skipping (data error)`);
            return null;
        }

        // Must be positive after fees (MarginFi flashloan is free, just need > 0)
        if (probeProfit <= 0n) return null;

        logger.debug(
            `[${pair.name}] probe: in=${minAmountIn} → tokenOut=${tokenOut} → solBack=${solBack} | ` +
            `profit=${probeProfit} (${(spreadPct * 100).toFixed(4)}%)`
        );

        // Scale loan size linearly with spread
        const ratio          = Math.min(Math.abs(spreadPct) / 0.01, 1.0); // 0→0, 1%+→1
        const optimalAmount  = Math.round(minAmountIn + ratio * (maxAmountIn - minAmountIn));
        const optimalAmount_ = Math.min(Math.max(optimalAmount, minAmountIn), maxAmountIn);

        let bestBuyQuote  = buyProbe;
        let bestSellQuote = sellProbe;
        let grossProfit   = probeProfit;
        let amountIn      = BigInt(minAmountIn);

        // Re-quote at optimal size only if meaningfully larger than probe
        if (optimalAmount_ > minAmountIn * 1.5) {
            const buyFull = await _jupiterQuote(pair.tokenA, pair.tokenB, optimalAmount_);
            if (buyFull?.outAmount) {
                const fullTokenOut = BigInt(buyFull.outAmount);
                const sellFull = await _jupiterQuote(pair.tokenB, pair.tokenA, fullTokenOut.toString());
                if (sellFull?.outAmount) {
                    const fullSolBack = BigInt(sellFull.outAmount);
                    const fullProfit  = fullSolBack - BigInt(optimalAmount_);
                    if (fullProfit > 0n) {
                        bestBuyQuote  = buyFull;
                        bestSellQuote = sellFull;
                        grossProfit   = fullProfit;
                        amountIn      = BigInt(optimalAmount_);
                    }
                }
            }
        }

        if (grossProfit <= 0n) return null;

        return {
            pair,
            amountIn,
            loanSizeSol:     Number(amountIn) / 1e9,
            grossProfit,
            spreadPct,
            priceDiffPct:    (Math.abs(spreadPct) * 100).toFixed(3),
            bestDex:         'Jupiter',
            bestBuyQuote,
            reverseQuote:    bestSellQuote,
            amountAfterBuy:  BigInt(bestBuyQuote.outAmount),
            amountAfterSell: BigInt(bestSellQuote.outAmount),
        };
    }

    // -------------------------------------------------------
    async findOpportunities(minLamports, maxLamports) {
        // Check rate limit before starting
        if (Date.now() < _rateLimitedUntil) {
            logger.debug(`[Scanner] Rate limited — skipping full scan`);
            return [];
        }

        const opportunities = [];

        // Scan pairs sequentially to avoid burst API calls
        for (const pair of this.activePairs) {
            try {
                const result = await this.scanPair(pair, minLamports, maxLamports);
                if (result) {
                    opportunities.push(result);
                    logger.debug(
                        `[${pair.name}] profit: ${(Number(result.grossProfit) / 1e9).toFixed(6)} SOL ` +
                        `| spread: ${result.priceDiffPct}% | loan: ${result.loanSizeSol.toFixed(1)} SOL`
                    );
                }
            } catch (e) {
                logger.debug(`Scan error [${pair.name}]: ${e.message}`);
            }
        }

        return opportunities.sort((a, b) =>
            b.grossProfit > a.grossProfit ? 1 : b.grossProfit < a.grossProfit ? -1 : 0
        );
    }

    // -------------------------------------------------------
    async findOpportunitiesForPair(pair, minLamports, maxLamports) {
        try {
            const result = await this.scanPair(pair, minLamports, maxLamports);
            if (result && result.grossProfit > 0n) return [result];
        } catch (e) {
            logger.debug(`Scan error [${pair.name}]: ${e.message}`);
        }
        return [];
    }
}

module.exports = { PriceScanner, DEFAULT_PAIRS };
