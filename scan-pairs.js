#!/usr/bin/env node
'use strict';

/**
 * scan-pairs.js — Find viable cross-fee-tier Orca Whirlpool pairs
 *
 * For each popular token pair, checks all tick spacings for existing pools,
 * then verifies tick arrays in both directions. Reports pairs where
 * cross-fee-tier arb is structurally possible.
 */

require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const { deriveTickArrayPDA, getTickArrayStartIndices } = require('./src/orcaBuilder');

const WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

// ── Popular Solana token mints ──
const TOKENS = {
    SOL:     'So11111111111111111111111111111111111111112',
    USDC:    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT:    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    jitoSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    mSOL:    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    bSOL:    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
    INF:     '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm',
    BONK:    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    WIF:     'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    JUP:     'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    RAY:     '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    ORCA:    'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
    PYTH:    'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
    HNT:     'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux',
    RENDER:  'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',
    W:       '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ',
};

// Pairs to scan — focus on high-volume + LST pairs
const PAIRS_TO_SCAN = [
    // SOL pairs
    ['SOL', 'USDC'], ['SOL', 'USDT'], ['SOL', 'BONK'], ['SOL', 'WIF'],
    ['SOL', 'JUP'], ['SOL', 'RAY'], ['SOL', 'ORCA'], ['SOL', 'PYTH'],
    ['SOL', 'HNT'], ['SOL', 'RENDER'], ['SOL', 'W'],
    // LST pairs (tight correlation = small natural spread → low fees could work)
    ['SOL', 'jitoSOL'], ['SOL', 'mSOL'], ['SOL', 'bSOL'], ['SOL', 'INF'],
    ['jitoSOL', 'mSOL'], ['jitoSOL', 'bSOL'], ['mSOL', 'bSOL'],
    // Stablecoin pairs
    ['USDC', 'USDT'],
    // USDC quote pairs
    ['USDC', 'BONK'], ['USDC', 'WIF'], ['USDC', 'JUP'],
    ['USDC', 'jitoSOL'], ['USDC', 'mSOL'],
];

const TICK_SPACINGS = [1, 2, 4, 8, 16, 32, 64, 128, 256];

function decodeWhirlpool(data) {
    if (!data || data.length < 245) return null;
    const liqLo = data.readBigUInt64LE(49);
    const liqHi = data.readBigUInt64LE(57);
    return {
        tickSpacing: data.readUInt16LE(41),
        feeRate:     data.readUInt16LE(45),
        liquidity:   liqLo | (liqHi << 64n),
        sqrtPrice:   data.readBigUInt64LE(65) | (data.readBigUInt64LE(73) << 64n),
        tickCurrent: data.readInt32LE(81),
        mintA:       new PublicKey(data.subarray(101, 133)).toBase58(),
        mintB:       new PublicKey(data.subarray(181, 213)).toBase58(),
        vaultA:      new PublicKey(data.subarray(133, 165)).toBase58(),
        vaultB:      new PublicKey(data.subarray(213, 245)).toBase58(),
    };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    console.log('══════════════════════════════════════════════');
    console.log('  ORCA CROSS-FEE-TIER PAIR SCANNER');
    console.log('══════════════════════════════════════════════\n');

    const conn = new Connection(process.env.RPC_URL_PRIMARY, 'confirmed');

    // ── Step 1: Get whirlpoolsConfig from known pool ──
    console.log('[1] Fetching whirlpoolsConfig from known SOL/USDC pool...');
    const knownAcct = await conn.getAccountInfo(
        new PublicKey('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE')
    );
    if (!knownAcct) { console.error('FATAL: known pool not found'); process.exit(1); }
    const whirlpoolsConfig = new PublicKey(knownAcct.data.subarray(8, 40));
    console.log('Config:', whirlpoolsConfig.toBase58(), '\n');

    // ── Step 2: Derive all pool PDAs ──
    console.log(`[2] Deriving PDAs for ${PAIRS_TO_SCAN.length} pairs x ${TICK_SPACINGS.length} tick spacings...`);

    const pdaLookups = [];
    for (const [symA, symB] of PAIRS_TO_SCAN) {
        const mintA = TOKENS[symA];
        const mintB = TOKENS[symB];
        if (!mintA || !mintB) { console.warn(`  Skipping ${symA}/${symB}: mint not found`); continue; }

        // Orca sorts mints by pubkey bytes (lexicographic)
        const pkA = new PublicKey(mintA);
        const pkB = new PublicKey(mintB);
        const [sortedA, sortedB] = Buffer.compare(pkA.toBuffer(), pkB.toBuffer()) < 0
            ? [pkA, pkB] : [pkB, pkA];

        for (const ts of TICK_SPACINGS) {
            const tsBuf = Buffer.alloc(2);
            tsBuf.writeUInt16LE(ts);

            const [pda] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from('whirlpool'),
                    whirlpoolsConfig.toBuffer(),
                    sortedA.toBuffer(),
                    sortedB.toBuffer(),
                    tsBuf,
                ],
                WHIRLPOOL_PROGRAM_ID
            );

            pdaLookups.push({ pair: `${symA}/${symB}`, tickSpacing: ts, pda });
        }
    }

    console.log(`Derived ${pdaLookups.length} PDAs. Fetching on-chain...\n`);

    // ── Step 3: Batch fetch all PDAs ──
    const BATCH = 100;
    const allAccounts = [];
    for (let i = 0; i < pdaLookups.length; i += BATCH) {
        const batch = pdaLookups.slice(i, i + BATCH);
        const accounts = await conn.getMultipleAccountsInfo(batch.map(p => p.pda));
        allAccounts.push(...accounts);
        process.stdout.write(`  Fetched ${Math.min(i + BATCH, pdaLookups.length)}/${pdaLookups.length}\r`);
        if (i + BATCH < pdaLookups.length) await sleep(250);
    }
    console.log('');

    // ── Step 4: Decode, group by pair ──
    const poolsByPair = {};
    let found = 0;
    for (let i = 0; i < pdaLookups.length; i++) {
        if (!allAccounts[i]) continue;
        const decoded = decodeWhirlpool(allAccounts[i].data);
        if (!decoded) continue;
        found++;

        const key = pdaLookups[i].pair;
        if (!poolsByPair[key]) poolsByPair[key] = [];
        poolsByPair[key].push({
            pair: key,
            address: pdaLookups[i].pda.toBase58(),
            ...decoded,
        });
    }
    console.log(`Found ${found} pools across ${Object.keys(poolsByPair).length} pairs\n`);

    // ── Step 5: Filter pairs with 2+ tick spacings + liquidity ──
    const multiTier = {};
    for (const [pair, pools] of Object.entries(poolsByPair)) {
        const withLiq = pools.filter(p => p.liquidity > 0n);
        const uniqueTs = new Set(withLiq.map(p => p.tickSpacing));
        if (uniqueTs.size >= 2) multiTier[pair] = withLiq;
    }

    console.log(`[3] Pairs with 2+ fee tiers (with liquidity): ${Object.keys(multiTier).length}\n`);
    if (Object.keys(multiTier).length === 0) {
        console.log('No multi-tier pairs found. Nothing to arb.');
        process.exit(0);
    }

    // ── Step 6: Check tick arrays for each viable combination ──
    console.log('[4] Verifying tick arrays...\n');

    const results = [];

    for (const [pair, pools] of Object.entries(multiTier)) {
        pools.sort((a, b) => a.feeRate - b.feeRate);

        console.log(`── ${pair} (${pools.length} pools with liquidity) ──`);
        for (const p of pools) {
            console.log(`  ts=${String(p.tickSpacing).padStart(3)} fee=${String(p.feeRate/100).padStart(3)}bps tick=${String(p.tickCurrent).padStart(7)} ${p.address.slice(0,12)}`);
        }

        // Find combos with combined fee < 0.25%
        for (let i = 0; i < pools.length; i++) {
            for (let j = i + 1; j < pools.length; j++) {
                const combinedBps = pools[i].feeRate + pools[j].feeRate;
                if (combinedBps > 2500) continue; // >0.25% = too expensive

                const pA = pools[i], pB = pools[j];
                const pAPk = new PublicKey(pA.address);
                const pBPk = new PublicKey(pB.address);

                // Check tick arrays: both directions on both pools
                const checks = [
                    { pool: 'A', dir: 'aToB', indices: getTickArrayStartIndices(pA.tickCurrent, pA.tickSpacing, true), pk: pAPk },
                    { pool: 'A', dir: 'bToA', indices: getTickArrayStartIndices(pA.tickCurrent, pA.tickSpacing, false), pk: pAPk },
                    { pool: 'B', dir: 'aToB', indices: getTickArrayStartIndices(pB.tickCurrent, pB.tickSpacing, true), pk: pBPk },
                    { pool: 'B', dir: 'bToA', indices: getTickArrayStartIndices(pB.tickCurrent, pB.tickSpacing, false), pk: pBPk },
                ];

                const allPdas = [];
                const pdaMeta = [];
                for (const c of checks) {
                    for (const idx of c.indices) {
                        allPdas.push(deriveTickArrayPDA(c.pk, idx));
                        pdaMeta.push({ pool: c.pool, dir: c.dir, idx });
                    }
                }

                const taAccts = await conn.getMultipleAccountsInfo(allPdas);
                await sleep(200);

                const status = { A: { aToB: true, bToA: true }, B: { aToB: true, bToA: true } };
                const missing = [];
                for (let k = 0; k < taAccts.length; k++) {
                    if (!taAccts[k]) {
                        status[pdaMeta[k].pool][pdaMeta[k].dir] = false;
                        missing.push(`${pdaMeta[k].pool}-${pdaMeta[k].dir}[${pdaMeta[k].idx}]`);
                    }
                }

                const fullyViable = status.A.aToB && status.A.bToA && status.B.aToB && status.B.bToA;
                // Partial: at least one valid arb route (buy on A sell on B, or vice versa)
                const route1 = status.A.aToB && status.B.bToA; // buy=A(aToB), sell=B(bToA)
                const route2 = status.A.bToA && status.B.aToB; // buy=A(bToA), sell=B(aToB)
                const partiallyViable = route1 || route2;

                const combinedPct = (combinedBps / 10000).toFixed(3);
                const minSpread = (combinedBps / 10000 + 0.002).toFixed(3); // +Kamino+tip

                if (fullyViable) {
                    console.log(`  ts=${pA.tickSpacing}+${pB.tickSpacing} (${combinedPct}%) → ✅ FULLY VIABLE`);
                    results.push({ pair, pA, pB, combinedPct, minSpread, status: 'FULL' });
                } else if (partiallyViable) {
                    console.log(`  ts=${pA.tickSpacing}+${pB.tickSpacing} (${combinedPct}%) → ⚠️  PARTIAL (${route1 ? 'A→B' : ''}${route1 && route2 ? '+' : ''}${route2 ? 'B→A' : ''} only)`);
                    if (missing.length) console.log(`    Missing: ${missing.join(', ')}`);
                    results.push({ pair, pA, pB, combinedPct, minSpread, status: 'PARTIAL' });
                } else {
                    console.log(`  ts=${pA.tickSpacing}+${pB.tickSpacing} (${combinedPct}%) → ❌ BROKEN`);
                    if (missing.length <= 4) console.log(`    Missing: ${missing.join(', ')}`);
                }
            }
        }
        console.log('');
    }

    // ── Summary ──
    console.log('══════════════════════════════════════════════');
    console.log('               RESULTS SUMMARY');
    console.log('══════════════════════════════════════════════\n');

    if (results.length === 0) {
        console.log('No viable cross-fee-tier pairs found.\n');
        console.log('Options:');
        console.log('  1. Cross-DEX arb (Orca ↔ Raydium) — needs working Raydium pools');
        console.log('  2. gRPC-triggered arb (react to whale trades)');
        console.log('  3. Liquidation bot (different strategy entirely)');
    } else {
        results.sort((a, b) => parseFloat(a.combinedPct) - parseFloat(b.combinedPct));

        for (const r of results) {
            console.log(`${r.pair} [${r.status}]`);
            console.log(`  Pool A: ${r.pA.address.slice(0,16)}  ts=${r.pA.tickSpacing}  fee=${r.pA.feeRate/100}bps`);
            console.log(`  Pool B: ${r.pB.address.slice(0,16)}  ts=${r.pB.tickSpacing}  fee=${r.pB.feeRate/100}bps`);
            console.log(`  Combined fee: ${r.combinedPct}%  |  Min spread for profit: ~${r.minSpread}%`);
            console.log('');
        }

        console.log('Next steps:');
        console.log('  1. Add FULL pairs to bot poolWatcher + whitelist');
        console.log('  2. Run spread-monitor.js on best pairs to measure real spreads');
        console.log('  3. Compare observed spreads vs min spread thresholds above');
    }
}

main().catch(e => {
    console.error('FATAL:', e.message);
    console.error(e.stack);
    process.exit(1);
});
