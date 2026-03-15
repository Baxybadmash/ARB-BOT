// src/poolWatcher.js
// ============================================================
//  POOL WATCHER — WebSocket account subscriptions
//  Subscribes directly to pool accounts on Orca (all fee tiers
//  via PDA), Raydium AMM v4 + CLMM (v3 per-pair API), and
//  Meteora DLMM. Fires callback within ~50-100ms of any swap.
//
//  Free — uses the existing WebSocket RPC endpoint.
// ============================================================
const { PublicKey } = require('@solana/web3.js');
const axios  = require('axios');
const logger = require('./logger');

const DEBOUNCE_MS = 150; // deduplicate rapid multi-pool fires for same pair; real rate limit is 500ms in bot.js

// -------------------------------------------------------
//  ORCA PDA DERIVATION  (no API call needed)
//  Orca Whirlpool pool addresses are deterministic PDAs.
//  We derive all common fee tiers and subscribe to all —
//  pools that don't exist simply never fire.
// -------------------------------------------------------
const WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const ORCA_CONFIG       = new PublicKey('2LecshUwdy9xi7meFgHZFAxnRRKFZC8CdCXQSQCDfxFu');
// Tick spacings for fee tiers: 0.01%, 0.05%, 0.3%, 1%, 2%
const ORCA_TICK_SPACINGS = [1, 8, 64, 128, 256];

function deriveOrcaPoolAddresses(pairs) {
    const found = [];
    for (const pair of pairs) {
        try {
            if (!pair.tokenA || !pair.tokenB) continue;
            const a = new PublicKey(pair.tokenA);
            const b = new PublicKey(pair.tokenB);
            // Orca requires mintA < mintB (lexicographic by buffer)
            const [mintA, mintB] = a.toBuffer().compare(b.toBuffer()) < 0 ? [a, b] : [b, a];

            for (const tickSpacing of ORCA_TICK_SPACINGS) {
                try {
                    const [pda] = PublicKey.findProgramAddressSync(
                        [
                            Buffer.from('whirlpool'),
                            ORCA_CONFIG.toBuffer(),
                            mintA.toBuffer(),
                            mintB.toBuffer(),
                            Buffer.from([tickSpacing & 0xff, (tickSpacing >> 8) & 0xff]), // u16 LE
                        ],
                        WHIRLPOOL_PROGRAM
                    );
                    found.push({ address: pda.toString(), dex: 'Orca', pair });
                } catch { /* skip invalid PDA */ }
            }
        } catch (e) {
            logger.debug(`[PoolWatcher] Orca PDA skipped ${pair.name}: ${e.message}`);
        }
    }
    logger.debug(`[PoolWatcher] Orca: derived ${found.length} addresses via PDA`);
    return found;
}

// -------------------------------------------------------
//  POOL ADDRESS FETCHERS
// -------------------------------------------------------
function fetchOrcaPools(pairs) {
    // PDA derivation — zero API calls, covers all 5 fee tiers per pair.
    // Better than API which only returns 1 pool (highest TVL).
    // Non-existent PDAs simply never fire — no harm.
    return deriveOrcaPoolAddresses(pairs);
}

// Raydium AMM v4 pool addresses for our default pairs — hardcoded because the
// full pairs endpoint returns 700k entries (~100MB). These on-chain addresses are
// permanent. Looked up 2026-03-15 from api.raydium.io/v2/main/pairs by highest liquidity.
// If the monthly updater adds new pairs, CLMM + Orca + Meteora still cover them.
const RAYDIUM_AMM_POOLS = new Map([
    ['So11111111111111111111111111111111111111112:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', '7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX'], // SOL/USDT
    ['So11111111111111111111111111111111111111112:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'HVNwzt7Pxfu76KHCMQPTLuTCLTm6WnQ1esLv4eizseSv'], // SOL/BONK
    ['So11111111111111111111111111111111111111112:EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx'], // SOL/WIF
    ['So11111111111111111111111111111111111111112:7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',  'FRhB8L7Y9Qq41qZXYLtC2nw8An1RJfLLxRF2x9RwLLMo'], // SOL/POPCAT
    ['So11111111111111111111111111111111111111112:JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  'EYErUp5muPYEEkeaUCY22JibeZX7E9UuMcJFZkmNAN7c'], // SOL/JUP
]);

async function fetchRaydiumPools(pairs) {
    const found = [];

    // CLMM (concentrated) — v2 bulk fetch, filter locally
    try {
        const res = await axios.get('https://api.raydium.io/v2/ammV3/ammPools', { timeout: 10000 });
        const pools = res.data.data || [];
        for (const pair of pairs) {
            const matches = pools
                .filter(p =>
                    (p.mintA === pair.tokenA && p.mintB === pair.tokenB) ||
                    (p.mintA === pair.tokenB && p.mintB === pair.tokenA)
                )
                .sort((a, b) => parseFloat(b.tvl || 0) - parseFloat(a.tvl || 0));
            if (matches.length > 0) {
                found.push({ address: matches[0].id, dex: 'Raydium CLMM', pair });
            }
        }
    } catch (e) {
        logger.warn(`[PoolWatcher] Raydium CLMM fetch failed: ${e.message}`);
    }

    // AMM v4 (legacy, highest volume for major SOL pairs) — hardcoded, zero API calls
    for (const pair of pairs) {
        const address = RAYDIUM_AMM_POOLS.get(`${pair.tokenA}:${pair.tokenB}`)
                     || RAYDIUM_AMM_POOLS.get(`${pair.tokenB}:${pair.tokenA}`);
        if (address) {
            found.push({ address, dex: 'Raydium AMM', pair });
        }
    }

    logger.debug(`[PoolWatcher] Raydium: ${found.length} pools found`);
    return found;
}

async function fetchMeteoraPools(pairs) {
    const found = [];
    try {
        const res = await axios.get('https://dlmm-api.meteora.ag/pair/all', { timeout: 10000 });
        const pools = res.data || [];
        for (const pair of pairs) {
            const matches = pools
                .filter(p =>
                    (p.mint_x === pair.tokenA && p.mint_y === pair.tokenB) ||
                    (p.mint_x === pair.tokenB && p.mint_y === pair.tokenA)
                )
                .sort((a, b) => parseFloat(b.liquidity || 0) - parseFloat(a.liquidity || 0));
            if (matches.length > 0) {
                found.push({ address: matches[0].address, dex: 'Meteora', pair });
            }
        }
        logger.debug(`[PoolWatcher] Meteora DLMM: ${found.length} pools found`);
    } catch (e) {
        logger.warn(`[PoolWatcher] Meteora pool fetch failed: ${e.message}`);
    }
    return found;
}

// -------------------------------------------------------
//  POOL WATCHER CLASS
// -------------------------------------------------------
class PoolWatcher {
    constructor(connection) {
        this.connection    = connection;
        this.subscriptions = []; // [{subId, address, dex, pairName}]
        this._debounce     = {}; // pairName → last fire timestamp
    }

    // Subscribe to all pools for all active pairs.
    // callback(pair) fires when any pool for that pair changes.
    async subscribe(pairs, callback) {
        logger.info('[PoolWatcher] Fetching pool addresses (Orca + Raydium + Meteora)...');

        const [orcaPools, raydiumPools, meteoraPools] = await Promise.all([
            fetchOrcaPools(pairs),
            fetchRaydiumPools(pairs),
            fetchMeteoraPools(pairs),
        ]);

        const allPools = [...orcaPools, ...raydiumPools, ...meteoraPools];

        if (allPools.length === 0) {
            logger.warn('[PoolWatcher] No pool addresses found — falling back to slot polling only');
            return;
        }

        for (const pool of allPools) {
            try {
                const pubkey = new PublicKey(pool.address);
                const subId  = this.connection.onAccountChange(
                    pubkey,
                    () => this._handleChange(pool, callback),
                    'confirmed'
                );
                this.subscriptions.push({ subId, ...pool });
            } catch (e) {
                logger.debug(`[PoolWatcher] Subscribe failed [${pool.dex} ${pool.pair.name}]: ${e.message}`);
            }
        }

        // Summary by DEX
        const byDex = {};
        for (const s of this.subscriptions) {
            byDex[s.dex] = (byDex[s.dex] || 0) + 1;
        }
        const summary = Object.entries(byDex).map(([d, n]) => `${d}:${n}`).join(' | ');
        logger.info(`[PoolWatcher] ✅ ${this.subscriptions.length} subscriptions — ${summary}`);
    }

    _handleChange(pool, callback) {
        const now  = Date.now();
        const last = this._debounce[pool.pair.name] || 0;
        if (now - last < DEBOUNCE_MS) return; // deduplicate within same slot
        this._debounce[pool.pair.name] = now;
        logger.debug(`[PoolWatcher] ${pool.dex} pool changed → scanning ${pool.pair.name}`);
        // callback is async — wrap in Promise to catch both sync throws and async rejections
        Promise.resolve().then(() => callback(pool.pair)).catch(e => {
            logger.error(`[PoolWatcher] Callback error [${pool.pair.name}]: ${e.message}`);
        });
    }

    // Refresh subscriptions when pair list changes (monthly update)
    async resubscribe(pairs, callback) {
        this.unsubscribeAll();
        await this.subscribe(pairs, callback);
    }

    unsubscribeAll() {
        for (const { subId } of this.subscriptions) {
            this.connection.removeAccountChangeListener(subId).catch(() => {});
        }
        this.subscriptions = [];
        logger.info('[PoolWatcher] All subscriptions removed');
    }
}

module.exports = { PoolWatcher };
