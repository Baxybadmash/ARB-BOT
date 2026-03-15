// src/pairUpdater.js
// ============================================================
//  AUTO PAIR UPDATER
//  Runs once a month. Fetches top volume tokens from Birdeye,
//  scores them for arb potential, and replaces the active
//  pair list with the best candidates.
//  Results saved to pairs.json — scanner loads from there.
// ============================================================
const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const PAIRS_FILE    = path.join(__dirname, '../data/pairs.json');
const HISTORY_DIR   = path.join(__dirname, '../data/history');
const MAX_PAIRS     = 10;
const USDC_MINT     = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT     = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const WSOL_MINT     = 'So11111111111111111111111111111111111111112';

// Tokens to ALWAYS keep regardless of scoring (anchors)
const ANCHOR_PAIRS = [
    {
        name: 'SOL/USDC',
        tokenA: WSOL_MINT,
        tokenB: USDC_MINT,
        decimalsA: 9,
        decimalsB: 6,
        isAnchor: true
    },
    {
        name: 'SOL/USDT',
        tokenA: WSOL_MINT,
        tokenB: USDT_MINT,
        decimalsA: 9,
        decimalsB: 6,
        isAnchor: true
    }
];

// Tokens to NEVER add (stablecoins, wrapped duplicates, illiquid)
const BLACKLIST = new Set([
    USDC_MINT,
    USDT_MINT,
    '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E', // BTC (Sollet, illiquid)
    '2FPyTwcZLUgFDPWPFtinzdBuBGGsWWGkhMSzVnkYEBRq', // ETH (Sollet, illiquid)
    'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt',  // SRM (deprecated)
    'MSRMcoVyrFxnSgo5uXwone5SKcGhT1KEJMFEkMEWf9L',  // MSRM (deprecated)

    // USD-pegged stablecoins — no meaningful DEX spread
    '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
    'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM',  // USDCet (Portal)
    'Dn4noZ5jgGfkntzcQSUZ8czkreiZ1ForXYoV2H8Dm7S1',  // USD1 (first USD)
    'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC',  // USD1 (alt)

    // Bridged BTC/ETH — tight spreads, liquid only on 1-2 DEXes
    'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',   // cbBTC
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',  // WETH (Wormhole)
    'ZScHuTtqAvLSMkwSGDUqy9jkPUVaKxv2BebRuHNq8PX',   // weETH

    // Meme/political tokens with synthetic volume (very low arb potential)
    '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',  // TRUMP
    'HelioRxR5rNBqz8A7GQiWVeU3Vy7Cjd1WFPbMzJHjNfv',  // PUMP (synthetic)

    // Staked SOL variants — very tight spread vs SOL itself
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',   // bSOL
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',  // JitoSOL — low arb vs mSOL
]);

// -------------------------------------------------------
//  FETCH TOP TOKENS BY VOLUME FROM BIRDEYE
// -------------------------------------------------------
async function fetchTopTokensByVolume(limit = 50) {
    try {
        logger.info('[PairUpdater] Fetching top tokens from Birdeye...');
        const response = await axios.get(
            'https://public-api.birdeye.so/defi/tokenlist',
            {
                params: {
                    sort_by:   'v24hUSD',
                    sort_type: 'desc',
                    offset:    0,
                    limit,
                    min_liquidity: 500000, // minimum $500k liquidity
                },
                headers: {
                    'X-API-KEY': process.env.BIRDEYE_API_KEY || 'public',
                    'x-chain':   'solana'
                },
                timeout: 10000
            }
        );

        const tokens = response.data?.data?.tokens || [];
        logger.info(`[PairUpdater] Fetched ${tokens.length} tokens from Birdeye`);
        return tokens;
    } catch (e) {
        logger.warn(`[PairUpdater] Birdeye fetch failed: ${e.message}`);
        return [];
    }
}

// -------------------------------------------------------
//  FETCH TOP PAIRS FROM JUPITER (backup data source)
// -------------------------------------------------------
async function fetchJupiterTopPairs() {
    try {
        logger.info('[PairUpdater] Fetching top pairs from Jupiter...');
        const response = await axios.get(
            'https://stats.jup.ag/coingecko/pairs',
            { timeout: 10000 }
        );

        const pairs = response.data || [];
        logger.info(`[PairUpdater] Fetched ${pairs.length} pairs from Jupiter`);
        return pairs;
    } catch (e) {
        logger.warn(`[PairUpdater] Jupiter pairs fetch failed: ${e.message}`);
        return [];
    }
}

// -------------------------------------------------------
//  FETCH PRICE SPREAD (mispricing score) FOR A TOKEN
//  Tests SOL → token direction (matches flashloan scan direction).
//  amount is in SOL lamports.
// -------------------------------------------------------
async function getMispricingScore(tokenMint, quoteMint, amount) {
    try {
        const JUPITER_QUOTE = 'https://lite-api.jup.ag/swap/v1/quote';

        // Compare single-DEX price vs best-routed price (SOL → token)
        const [directQuote, allRoutesQuote] = await Promise.all([
            axios.get(JUPITER_QUOTE, {
                params: {
                    inputMint:        WSOL_MINT,  // SOL as input
                    outputMint:       tokenMint,
                    amount,
                    onlyDirectRoutes: true,
                    slippageBps:      100
                },
                timeout: 4000
            }).catch(() => null),
            axios.get(JUPITER_QUOTE, {
                params: {
                    inputMint:        WSOL_MINT,  // SOL as input
                    outputMint:       tokenMint,
                    amount,
                    onlyDirectRoutes: false,
                    slippageBps:      100
                },
                timeout: 4000
            }).catch(() => null)
        ]);

        if (!directQuote?.data || !allRoutesQuote?.data) return 0;

        const directOut  = parseInt(directQuote.data.outAmount  || 0);
        const allOut     = parseInt(allRoutesQuote.data.outAmount || 0);

        if (directOut === 0 || allOut === 0) return 0;

        // Spread = difference between best and direct route (% of value)
        const spread = Math.abs(allOut - directOut) / allOut;
        return isNaN(spread) ? 0 : spread;
    } catch {
        return 0;
    }
}

// Jupiter strict token list — cached for the duration of a monthly update run
// (avoids fetching the same multi-MB list once per candidate token)
let _jupiterTokenCache     = null;
let _jupiterTokenCacheTime = 0;
const JUPITER_TOKEN_CACHE_TTL_MS = 15 * 60 * 1000; // 15 min

async function _getJupiterTokens() {
    if (_jupiterTokenCache && Date.now() - _jupiterTokenCacheTime < JUPITER_TOKEN_CACHE_TTL_MS) {
        return _jupiterTokenCache;
    }
    try {
        const res = await axios.get('https://token.jup.ag/strict', { timeout: 10000 });
        _jupiterTokenCache     = res.data || [];
        _jupiterTokenCacheTime = Date.now();
        logger.debug(`[PairUpdater] Jupiter strict list cached: ${_jupiterTokenCache.length} tokens`);
    } catch {
        _jupiterTokenCache = _jupiterTokenCache || [];
    }
    return _jupiterTokenCache;
}

// -------------------------------------------------------
//  SCORE A TOKEN FOR ARB POTENTIAL
//  Returns a score 0-100 (higher = better for arb)
// -------------------------------------------------------
async function scoreToken(token, flashloanLamports) {
    const score = {
        mint:      token.address,
        symbol:    token.symbol,
        name:      token.name,
        volume24h: token.v24hUSD || 0,
        liquidity: token.liquidity || 0,
        decimals:  token.decimals || 6,

        // Scoring components (each 0-1)
        volumeScore:     0,
        liquidityScore:  0,
        mispricingScore: 0,
        dexCountScore:   0,

        totalScore: 0
    };

    // Volume score (log scale — $1M vol = 0.5, $100M = 1.0)
    score.volumeScore = Math.min(
        Math.log10(Math.max(score.volume24h, 1)) / 8, 1
    );

    // Liquidity score ($1M = 0.5, $50M+ = 1.0)
    score.liquidityScore = Math.min(
        Math.log10(Math.max(score.liquidity, 1)) / 7.7, 1
    );

    // Mispricing score — SOL→token spread check (matches actual scan direction)
    // Use small amount to avoid rate limiting
    const testAmount = Math.floor(flashloanLamports / 100);
    score.mispricingScore = await getMispricingScore(token.address, null, testAmount);

    // DEX count score from Jupiter token info (uses shared cache — one fetch per update run)
    try {
        const allTokens = await _getJupiterTokens();
        const found     = allTokens.find(t => t.address === token.address);
        if (found) {
            // More tags/extensions = more DEX listings = better
            const tagCount       = (found.tags || []).length;
            score.dexCountScore  = Math.min(tagCount / 5, 1);
        }
    } catch { /* skip */ }

    // Weighted total score
    score.totalScore = (
        score.volumeScore     * 0.30 +
        score.liquidityScore  * 0.25 +
        score.mispricingScore * 0.35 + // highest weight — direct arb signal
        score.dexCountScore   * 0.10
    );

    return score;
}

// -------------------------------------------------------
//  BUILD PAIR FROM TOKEN
//  Always SOL-based: tokenA=SOL, tokenB=token.
//  Flashloan borrows SOL, so all scans run SOL→token→SOL.
// -------------------------------------------------------
function buildPair(token) {
    return {
        name:      `SOL/${token.symbol}`,
        tokenA:    WSOL_MINT,
        tokenB:    token.mint || token.address, // scoreToken() stores address as .mint; raw Birdeye tokens use .address
        decimalsA: 9,
        decimalsB: token.decimals || 6,
        isAnchor:  false,
        score:     token.totalScore,
        volume24h: token.volume24h,
        addedAt:   new Date().toISOString()
    };
}

// -------------------------------------------------------
//  MAIN UPDATE FUNCTION
// -------------------------------------------------------
async function updatePairs(flashloanLamports, telegramAlert = null, discordAlert = null) {
    logger.info('');
    logger.info('═'.repeat(50));
    logger.info('  🔄 MONTHLY PAIR UPDATE STARTING');
    logger.info('═'.repeat(50));

    // Ensure dirs exist
    fs.mkdirSync(path.dirname(PAIRS_FILE), { recursive: true });
    fs.mkdirSync(HISTORY_DIR, { recursive: true });

    // Archive current pairs
    if (fs.existsSync(PAIRS_FILE)) {
        const timestamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', 'h');
        const archivePath = path.join(HISTORY_DIR, `pairs_${timestamp}.json`);
        fs.copyFileSync(PAIRS_FILE, archivePath);
        logger.info(`[PairUpdater] Archived current pairs to ${archivePath}`);
    }

    // Fetch candidates
    const topTokens = await fetchTopTokensByVolume(50);

    if (topTokens.length === 0) {
        logger.warn('[PairUpdater] No tokens fetched — keeping existing pairs');
        if (telegramAlert) await telegramAlert('⚠️ *Monthly pair update failed* — keeping existing pairs. Check Birdeye API.');
        if (discordAlert)  await discordAlert('⚠️ **Monthly pair update failed** — keeping existing pairs. Check Birdeye API.');
        return loadPairs();
    }

    // Filter out blacklisted tokens and any token already covered by an anchor pair
    const anchorMints = new Set(ANCHOR_PAIRS.flatMap(p => [p.tokenA, p.tokenB]));
    const candidates  = topTokens.filter(t =>
        t.address &&
        t.symbol &&
        !BLACKLIST.has(t.address) &&
        !anchorMints.has(t.address) &&
        t.v24hUSD > 100000 &&    // min $100k daily volume
        t.liquidity > 200000      // min $200k liquidity
    );

    logger.info(`[PairUpdater] Scoring ${candidates.length} candidate tokens...`);

    // Score all candidates (in batches to avoid rate limits)
    const scored  = [];
    const batchSize = 10;

    for (let i = 0; i < Math.min(candidates.length, 30); i += batchSize) {
        const batch   = candidates.slice(i, i + batchSize);
        const results = await Promise.all(
            batch.map(t => scoreToken(t, flashloanLamports))
        );
        scored.push(...results);

        // Small delay between batches
        if (i + batchSize < candidates.length) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    // Sort by total score descending
    scored.sort((a, b) => b.totalScore - a.totalScore);

    // Take top (MAX_PAIRS - anchor count) tokens
    const slotsAvailable = MAX_PAIRS - ANCHOR_PAIRS.length;
    const topCandidates  = scored.slice(0, slotsAvailable);

    // Build final pair list: anchors first, then top scored tokens
    const newPairs = [
        ...ANCHOR_PAIRS,
        ...topCandidates.map(buildPair)
    ];

    // Save to file
    const pairsData = {
        updatedAt:   new Date().toISOString(),
        nextUpdateAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        pairCount:   newPairs.length,
        pairs:       newPairs,
        scoreSummary: topCandidates.map(t => ({
            symbol:         t.symbol,
            totalScore:     t.totalScore.toFixed(4),
            volumeScore:    t.volumeScore.toFixed(4),
            mispricingScore: t.mispricingScore.toFixed(4),
            volume24h:      `$${Math.round(t.volume24h / 1000)}k`
        }))
    };

    fs.writeFileSync(PAIRS_FILE, JSON.stringify(pairsData, null, 2));

    // Log results
    logger.info('');
    logger.info('✅ PAIR UPDATE COMPLETE');
    logger.info(`   Total pairs: ${newPairs.length}`);
    logger.info('   New pair list:');
    newPairs.forEach((p, i) => {
        const tag = p.isAnchor ? ' [anchor]' : ` [score: ${p.score?.toFixed(3) || 'n/a'}]`;
        logger.info(`   ${i + 1}. ${p.name}${tag}`);
    });
    logger.info('');

    // Telegram alert
    if (telegramAlert || discordAlert) {
        const pairList  = newPairs.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
        const topScores = topCandidates.slice(0, 3)
            .map(t => `${t.symbol}: score ${t.totalScore.toFixed(3)}, vol $${Math.round(t.volume24h/1000)}k`)
            .join('\n');
        const nextDate  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('en-IN');

        if (telegramAlert) {
            await telegramAlert(
`🔄 *Monthly Pair Update Complete*
📊 Active pairs: ${newPairs.length}

*New pair list:*
${pairList}

*Top new additions by score:*
${topScores}

_Next update: ${nextDate}_`
            );
        }

        if (discordAlert) {
            await discordAlert(
`🔄 **Monthly Pair Update Complete**
📊 Active pairs: ${newPairs.length}

**New pair list:**
${pairList}

**Top new additions by score:**
${topScores}

Next update: ${nextDate}`
            );
        }
    }

    return newPairs;
}

// -------------------------------------------------------
//  LOAD PAIRS FROM FILE (used by scanner on startup)
// -------------------------------------------------------
function loadPairs() {
    try {
        if (!fs.existsSync(PAIRS_FILE)) return null;
        const data = JSON.parse(fs.readFileSync(PAIRS_FILE, 'utf8'));
        return data.pairs || null;
    } catch (e) {
        logger.warn(`[PairUpdater] Failed to load pairs.json: ${e.message}`);
        return null;
    }
}

// -------------------------------------------------------
//  CHECK IF UPDATE IS DUE
// -------------------------------------------------------
function isUpdateDue() {
    try {
        if (!fs.existsSync(PAIRS_FILE)) return true;
        const data = JSON.parse(fs.readFileSync(PAIRS_FILE, 'utf8'));
        if (!data.nextUpdateAt) return true;
        return new Date() >= new Date(data.nextUpdateAt);
    } catch {
        return true;
    }
}

// -------------------------------------------------------
//  GET UPDATE STATUS (for logging)
// -------------------------------------------------------
function getUpdateStatus() {
    try {
        if (!fs.existsSync(PAIRS_FILE)) {
            return { exists: false, message: 'No pairs file — will update on startup' };
        }
        const data = JSON.parse(fs.readFileSync(PAIRS_FILE, 'utf8'));
        const next = new Date(data.nextUpdateAt);
        const diff = next - new Date();
        const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
        return {
            exists:      true,
            updatedAt:   data.updatedAt,
            nextUpdate:  data.nextUpdateAt,
            daysUntil:   days,
            pairCount:   data.pairCount,
            message:     days > 0
                ? `Next update in ${days} day(s) on ${next.toLocaleDateString('en-IN')}`
                : 'Update due now'
        };
    } catch {
        return { exists: false, message: 'Could not read pairs file' };
    }
}

module.exports = { updatePairs, loadPairs, isUpdateDue, getUpdateStatus };
