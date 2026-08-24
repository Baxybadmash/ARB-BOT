#!/usr/bin/env node
'use strict';

/**
 * spread-monitor.js — Real-time cross-tier spread logger
 *
 * Subscribes to Orca pool accounts via WebSocket, computes price from sqrtPrice,
 * logs spread between pool pairs on every update.
 *
 * Usage:
 *   node spread-monitor.js                          # logs to console
 *   node spread-monitor.js 2>&1 | tee spreads.csv   # logs to file + console
 *
 * Run with PM2 for background collection:
 *   pm2 start spread-monitor.js --name spread-mon --log spreads.log
 */

require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');

// ── Pool pairs to monitor ──
// Each entry: [label, poolA_address, poolA_ts, poolB_address, poolB_ts]
const MONITOR_PAIRS = [
    ['SOL/USDC', 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', 4,
                 '7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm', 8],
    // Add more pairs here after scan-pairs.js finds them:
    // ['SOL/WIF', 'D6NdKrKN...', 4, '4E6q7eJE...', 8],
];

// ── Decode price from Whirlpool account data ──
function decodeSqrtPrice(data) {
    const lo = data.readBigUInt64LE(65);
    const hi = data.readBigUInt64LE(73);
    return lo | (hi << 64n);
}

function decodeTickCurrent(data) {
    return data.readInt32LE(81);
}

function decodeMintA(data) {
    return new PublicKey(data.subarray(101, 133)).toBase58();
}

// sqrtPriceX64 → human-readable price
// price = (sqrtPrice / 2^64)^2 = sqrtPrice^2 / 2^128
// This gives tokenA per tokenB in raw units
function sqrtPriceToPrice(sqrtPrice) {
    // Use floating point for display (good enough for spread calc)
    const s = Number(sqrtPrice) / (2 ** 64);
    return s * s;
}

// ── State ──
const poolStates = new Map(); // address → { sqrtPrice, price, tick, lastUpdate }
let updateCount = 0;

function logSpread(label, addrA, addrB, tsA, tsB) {
    const a = poolStates.get(addrA);
    const b = poolStates.get(addrB);
    if (!a || !b) return;

    const spread = Math.abs(a.price - b.price) / Math.min(a.price, b.price);
    const spreadPct = (spread * 100).toFixed(5);
    const hiPool = a.price > b.price ? `ts=${tsA}` : `ts=${tsB}`;

    const now = new Date().toISOString();
    const ageA = ((Date.now() - a.lastUpdate) / 1000).toFixed(1);
    const ageB = ((Date.now() - b.lastUpdate) / 1000).toFixed(1);

    console.log(
        `${now},${label},${spreadPct}%,hi=${hiPool},` +
        `tickA=${a.tick},tickB=${b.tick},` +
        `ageA=${ageA}s,ageB=${ageB}s`
    );
}

async function main() {
    console.log('=== SPREAD MONITOR ===');
    console.log(`Monitoring ${MONITOR_PAIRS.length} pair(s)`);
    console.log('Press Ctrl+C to stop\n');
    console.log('timestamp,pair,spread,hi_pool,tickA,tickB,ageA,ageB');

    const conn = new Connection(process.env.RPC_URL_PRIMARY, {
        commitment: 'processed',
        wsEndpoint: process.env.RPC_URL_PRIMARY.replace('https://', 'wss://'),
    });

    // Initial fetch for all pools
    const allAddrs = [];
    const addrMeta = [];
    for (const [label, addrA, tsA, addrB, tsB] of MONITOR_PAIRS) {
        allAddrs.push(new PublicKey(addrA), new PublicKey(addrB));
        addrMeta.push({ label, addr: addrA, ts: tsA }, { label, addr: addrB, ts: tsB });
    }

    console.log('# Fetching initial pool states...');
    const initAccts = await conn.getMultipleAccountsInfo(allAddrs);
    for (let i = 0; i < initAccts.length; i++) {
        if (!initAccts[i]) { console.error(`# WARN: pool ${addrMeta[i].addr.slice(0,8)} not found`); continue; }
        const sqrtPrice = decodeSqrtPrice(initAccts[i].data);
        const tick = decodeTickCurrent(initAccts[i].data);
        const price = sqrtPriceToPrice(sqrtPrice);
        poolStates.set(addrMeta[i].addr, { sqrtPrice, price, tick, lastUpdate: Date.now() });
    }

    // Log initial spreads
    for (const [label, addrA, tsA, addrB, tsB] of MONITOR_PAIRS) {
        logSpread(label, addrA, addrB, tsA, tsB);
    }

    // Subscribe to each pool
    for (const [label, addrA, tsA, addrB, tsB] of MONITOR_PAIRS) {
        // Pool A subscription
        conn.onAccountChange(new PublicKey(addrA), (accountInfo) => {
            const sqrtPrice = decodeSqrtPrice(accountInfo.data);
            const tick = decodeTickCurrent(accountInfo.data);
            const price = sqrtPriceToPrice(sqrtPrice);
            const prev = poolStates.get(addrA);
            if (prev && prev.sqrtPrice === sqrtPrice) return; // no price change
            poolStates.set(addrA, { sqrtPrice, price, tick, lastUpdate: Date.now() });
            updateCount++;
            logSpread(label, addrA, addrB, tsA, tsB);
        }, 'processed');

        // Pool B subscription
        conn.onAccountChange(new PublicKey(addrB), (accountInfo) => {
            const sqrtPrice = decodeSqrtPrice(accountInfo.data);
            const tick = decodeTickCurrent(accountInfo.data);
            const price = sqrtPriceToPrice(sqrtPrice);
            const prev = poolStates.get(addrB);
            if (prev && prev.sqrtPrice === sqrtPrice) return;
            poolStates.set(addrB, { sqrtPrice, price, tick, lastUpdate: Date.now() });
            updateCount++;
            logSpread(label, addrA, addrB, tsA, tsB);
        }, 'processed');
    }

    // Periodic stats
    setInterval(() => {
        console.log(`# --- ${new Date().toISOString()} | updates: ${updateCount} | pools tracked: ${poolStates.size} ---`);
    }, 60_000);

    // Keep alive
    process.on('SIGINT', () => {
        console.log(`\n# Stopped. Total updates: ${updateCount}`);
        process.exit(0);
    });
}

main().catch(e => {
    console.error('FATAL:', e.message);
    process.exit(1);
});
