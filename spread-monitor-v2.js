#!/usr/bin/env node
'use strict';

/**
 * spread-monitor-v2.js — Real-time spread logger for low-fee tier pairs
 *
 * Monitors ts=1 vs ts=2 spreads for SOL/USDC, SOL/USDT, USDC/USDT.
 * Combined fee = 0.03% → profitable if spread > ~0.032%
 *
 * Usage:
 *   node spread-monitor-v2.js                           # console
 *   pm2 start spread-monitor-v2.js --name spread-v2     # background
 *   pm2 logs spread-v2 --lines 50                       # view logs
 */

require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');

const WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const WHIRLPOOLS_CONFIG    = new PublicKey('2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ');

const MINTS = {
    SOL:  'So11111111111111111111111111111111111111112',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

// Pairs to monitor: [label, mintA_sym, mintB_sym, ts_low, ts_high]
const PAIRS = [
    ['SOL/USDC',  'SOL',  'USDC', 1, 2],
    ['SOL/USDT',  'SOL',  'USDT', 1, 2],
    ['SOL/USDC',  'SOL',  'USDC', 1, 4],
    ['SOL/USDT',  'SOL',  'USDT', 1, 4],
    // ts=2+4: executable combo (proven on-chain)
    ['SOL/USDC',  'SOL',  'USDC', 2, 4],
    ['SOL/USDT',  'SOL',  'USDT', 2, 4],
];

function derivePoolPDA(mintA, mintB, tickSpacing) {
    const pkA = new PublicKey(mintA);
    const pkB = new PublicKey(mintB);
    const [sA, sB] = Buffer.compare(pkA.toBuffer(), pkB.toBuffer()) < 0
        ? [pkA, pkB] : [pkB, pkA];
    const tsBuf = Buffer.alloc(2);
    tsBuf.writeUInt16LE(tickSpacing);
    return PublicKey.findProgramAddressSync(
        [Buffer.from('whirlpool'), WHIRLPOOLS_CONFIG.toBuffer(),
         sA.toBuffer(), sB.toBuffer(), tsBuf],
        WHIRLPOOL_PROGRAM_ID
    )[0];
}

function decodeSqrtPrice(data) {
    return data.readBigUInt64LE(65) | (data.readBigUInt64LE(73) << 64n);
}

function decodeTickCurrent(data) {
    return data.readInt32LE(81);
}

function sqrtPriceToPrice(sqrtPrice) {
    const s = Number(sqrtPrice) / (2 ** 64);
    return s * s;
}

// ── State ──
const poolStates = new Map(); // poolAddr → { price, tick, lastUpdate }
let updateCount = 0;
let maxSpreads = {};  // label → max spread seen
let profitableCount = {};  // label → count of readings above threshold

const PROFIT_THRESHOLDS = {
    'ts1+2': 0.00032,  // 0.032%
    'ts1+4': 0.00052,  // 0.052%
    'ts2+4': 0.00062,  // 0.062%
};

function getThresholdKey(tsLow, tsHigh) {
    return `ts${tsLow}+${tsHigh}`;
}

function logSpread(label, addrLow, addrHigh, tsLow, tsHigh) {
    const lo = poolStates.get(addrLow);
    const hi = poolStates.get(addrHigh);
    if (!lo || !hi) return;

    const spread = Math.abs(lo.price - hi.price) / Math.min(lo.price, hi.price);
    const spreadPct = spread * 100;
    const hiPool = lo.price > hi.price ? `ts=${tsLow}` : `ts=${tsHigh}`;

    const key = `${label}_${tsLow}+${tsHigh}`;
    const threshKey = getThresholdKey(tsLow, tsHigh);
    const threshold = PROFIT_THRESHOLDS[threshKey] || 0.00032;

    if (!maxSpreads[key] || spread > maxSpreads[key]) maxSpreads[key] = spread;
    if (!profitableCount[key]) profitableCount[key] = 0;
    if (spread > threshold) profitableCount[key]++;

    const profitable = spread > threshold ? ' 💰 PROFITABLE' : '';
    const now = new Date().toISOString().slice(11, 23);

    console.log(
        `${now} | ${label.padEnd(9)} ts=${tsLow}+${tsHigh} | ` +
        `spread=${spreadPct.toFixed(4)}% | hi=${hiPool} | ` +
        `max=${(maxSpreads[key] * 100).toFixed(4)}% | ` +
        `tickΔ=${Math.abs(lo.tick - hi.tick)}${profitable}`
    );
}

async function main() {
    console.log('══════════════════════════════════════════════════════════════');
    console.log('  SPREAD MONITOR v2 — Low-fee tier pairs (ts=1 vs ts=2/4)');
    console.log('  Profitable threshold: 0.032% (ts1+2) / 0.052% (ts1+4)');
    console.log('══════════════════════════════════════════════════════════════\n');

    const conn = new Connection(process.env.RPC_URL_PRIMARY, {
        commitment: 'processed',
        wsEndpoint: process.env.RPC_URL_PRIMARY.replace('https://', 'wss://'),
    });

    // Derive all unique pool addresses
    const poolMap = new Map(); // addr → { label, ts }
    const subPairs = []; // { label, addrLow, addrHigh, tsLow, tsHigh }
    const uniqueAddrs = new Set();

    for (const [label, symA, symB, tsLow, tsHigh] of PAIRS) {
        const mintA = MINTS[symA];
        const mintB = MINTS[symB];
        const addrLow  = derivePoolPDA(mintA, mintB, tsLow).toBase58();
        const addrHigh = derivePoolPDA(mintA, mintB, tsHigh).toBase58();
        uniqueAddrs.add(addrLow);
        uniqueAddrs.add(addrHigh);
        subPairs.push({ label, addrLow, addrHigh, tsLow, tsHigh });
        console.log(`${label} ts=${tsLow}: ${addrLow.slice(0,12)}`);
        console.log(`${label} ts=${tsHigh}: ${addrHigh.slice(0,12)}`);
    }

    const addrList = [...uniqueAddrs];
    console.log(`\nUnique pools: ${addrList.length}`);
    console.log('Fetching initial states...\n');

    // Initial fetch
    const initAccts = await conn.getMultipleAccountsInfo(addrList.map(a => new PublicKey(a)));
    for (let i = 0; i < addrList.length; i++) {
        if (!initAccts[i]) { console.error(`WARN: ${addrList[i].slice(0,12)} not found`); continue; }
        const sqrtPrice = decodeSqrtPrice(initAccts[i].data);
        const tick = decodeTickCurrent(initAccts[i].data);
        poolStates.set(addrList[i], {
            price: sqrtPriceToPrice(sqrtPrice),
            tick,
            sqrtPrice,
            lastUpdate: Date.now(),
        });
    }

    // Log initial spreads
    console.log('TIME         | PAIR      TIERS     | SPREAD      | HI       | MAX         | TICK_DELTA');
    console.log('─────────────┼─────────────────────┼─────────────┼──────────┼─────────────┼──────────');
    for (const sp of subPairs) {
        logSpread(sp.label, sp.addrLow, sp.addrHigh, sp.tsLow, sp.tsHigh);
    }

    // Subscribe to all unique pools
    for (const addr of addrList) {
        conn.onAccountChange(new PublicKey(addr), (accountInfo) => {
            const sqrtPrice = decodeSqrtPrice(accountInfo.data);
            const tick = decodeTickCurrent(accountInfo.data);
            const prev = poolStates.get(addr);
            if (prev && prev.sqrtPrice === sqrtPrice) return;

            poolStates.set(addr, {
                price: sqrtPriceToPrice(sqrtPrice),
                tick,
                sqrtPrice,
                lastUpdate: Date.now(),
            });
            updateCount++;

            // Log all pairs that use this pool
            for (const sp of subPairs) {
                if (sp.addrLow === addr || sp.addrHigh === addr) {
                    logSpread(sp.label, sp.addrLow, sp.addrHigh, sp.tsLow, sp.tsHigh);
                }
            }
        }, 'processed');
    }

    // Periodic summary
    setInterval(() => {
        console.log('\n── SUMMARY ──');
        console.log(`Updates: ${updateCount} | Uptime: ${((Date.now() - startTime) / 60000).toFixed(1)} min`);
        for (const key of Object.keys(maxSpreads).sort()) {
            const profitable = profitableCount[key] || 0;
            console.log(`  ${key}: max=${(maxSpreads[key] * 100).toFixed(4)}% | profitable_readings=${profitable}`);
        }
        console.log('');
    }, 5 * 60_000); // every 5 minutes

    const startTime = Date.now();

    process.on('SIGINT', () => {
        console.log('\n\n══ FINAL REPORT ══');
        console.log(`Runtime: ${((Date.now() - startTime) / 60000).toFixed(1)} minutes`);
        console.log(`Total updates: ${updateCount}`);
        for (const key of Object.keys(maxSpreads).sort()) {
            const profitable = profitableCount[key] || 0;
            console.log(`  ${key}: max_spread=${(maxSpreads[key] * 100).toFixed(4)}% | profitable=${profitable}`);
        }
        process.exit(0);
    });
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
