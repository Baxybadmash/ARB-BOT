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

const DEBOUNCE_MS = 50; // deduplicate rapid multi-pool fires for same pair; real rate limit is 500ms in bot.js

// -------------------------------------------------------
//  ORCA PDA DERIVATION  (no API call needed)
//  Orca Whirlpool pool addresses are deterministic PDAs.
//  We derive all common fee tiers and subscribe to all —
//  pools that don't exist simply never fire.
// -------------------------------------------------------
const WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const ORCA_CONFIG       = new PublicKey('2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ');
// Tick spacings for fee tiers: 0.01%, 0.05%, 0.3%, 1%, 2% + Splash pools
const ORCA_TICK_SPACINGS = [1, 8, 64, 128, 256, 32768];

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
// permanent. Verified 2026-03-20 via GeckoTerminal + Solscan.
// If the monthly updater adds new pairs, CLMM + Orca + Meteora still cover them.
const RAYDIUM_AMM_POOLS = new Map([
    ['So11111111111111111111111111111111111111112:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', '7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX'], // SOL/USDT  — $8.8M liq
    ['So11111111111111111111111111111111111111112:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'], // SOL/USDC  — $8.8M liq
    ['So11111111111111111111111111111111111111112:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'HVNwzt7Pxfu76KHCMQPTLuTCLTm6WnQ1esLv4eizseSv'], // SOL/BONK
    ['So11111111111111111111111111111111111111112:EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx'], // SOL/WIF   — $8.9M liq
    ['So11111111111111111111111111111111111111112:9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump', 'Bzc9NZfMqkXR6fz1DBph7BDf9BroyEf6pnzESP7v5iiw'], // SOL/FARTCOIN — $7.6M liq
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
            } else {
                logger.info(`[PoolWatcher] Raydium CLMM: no pool found for ${pair.name}`);
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
        } else {
            logger.info(`[PoolWatcher] Raydium AMM v4: no hardcoded pool for ${pair.name}`);
        }
    }

    logger.debug(`[PoolWatcher] Raydium: ${found.length} pools found`);
    return found;
}

// Meteora DLMM pool addresses — hardcoded because dlmm-api.meteora.ag/pair/all is decommissioned (404).
// Verified 2026-03-26 via DexScreener + Helius on-chain owner check (LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo).
// SOL/USDT and SOL/USDC have no Meteora DLMM pools; those pairs are covered by Orca + Raydium.
const METEORA_DLMM_POOLS = new Map([
    ['So11111111111111111111111111111111111111112:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', '6oFWm7KPLfxnwMb3z5xwBoXNSPP3JJyirAPqPSiVcnsp'], // SOL/BONK     — $361K liq
    ['So11111111111111111111111111111111111111112:EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', '8Ve9KtGNtLRxCQNAVfkHEP5GRZHjdj6BjB1RQFZewG6V'], // SOL/WIF      — $5.9K liq
    ['So11111111111111111111111111111111111111112:9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump', '6wJ7W3oHj7ex6MVFp2o26NSof3aey7U8Brs8E371WCXA'], // SOL/FARTCOIN — $118K liq
]);

async function fetchMeteoraPools(pairs) {
    const found = [];
    for (const pair of pairs) {
        const address = METEORA_DLMM_POOLS.get(`${pair.tokenA}:${pair.tokenB}`)
                     || METEORA_DLMM_POOLS.get(`${pair.tokenB}:${pair.tokenA}`);
        if (address) {
            found.push({ address, dex: 'Meteora', pair });
        }
    }
    logger.debug(`[PoolWatcher] Meteora DLMM: ${found.length} pools found (hardcoded)`);
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
                    (accountInfo) => this._handleChange(pool, callback, accountInfo),
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

        // Per-pair coverage breakdown so we know exactly what's covered
        const byPair = {};
        for (const s of this.subscriptions) {
            if (!byPair[s.pair.name]) byPair[s.pair.name] = [];
            byPair[s.pair.name].push(s.dex);
        }
        for (const [name, dexes] of Object.entries(byPair)) {
            const counts = {};
            for (const d of dexes) counts[d] = (counts[d] || 0) + 1;
            const detail = Object.entries(counts).map(([d, n]) => `${d}:${n}`).join(' ');
            logger.info(`[PoolWatcher]   ${name} → ${dexes.length} subs (${detail})`);
        }
    }

    _handleChange(pool, callback, accountInfo) {
        const now  = Date.now();
        const last = this._debounce[pool.pair.name] || 0;
        if (now - last < DEBOUNCE_MS) return; // deduplicate within same slot
        this._debounce[pool.pair.name] = now;
        logger.debug(`[PoolWatcher] 🔔 ${pool.dex} pool changed → ${pool.pair.name}`);
        // Pass accountInfo through for local pool math pre-filtering
        Promise.resolve().then(() => callback(pool.pair, accountInfo, pool.dex, pool.address)).catch(e => {
            logger.error(`[PoolWatcher] Callback error [${pool.pair.name}]: ${e.message}`);
        });
    }

    // Refresh subscriptions when pair list changes (monthly update)
    async resubscribe(pairs, callback) {
        await this.unsubscribeAll();
        await this.subscribe(pairs, callback);
    }

    async unsubscribeAll() {
        await Promise.all(
            this.subscriptions.map(({ subId }) =>
                this.connection.removeAccountChangeListener(subId).catch(() => {})
            )
        );
        this.subscriptions = [];
        logger.info('[PoolWatcher] All subscriptions removed');
    }
}

module.exports = { PoolWatcher };
