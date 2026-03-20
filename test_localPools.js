'use strict';

// Test script — run on VPS to verify local pool math vs Jupiter
// Usage: node test_localPools.js

require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const { registerPool, updatePoolState, simulateSwap, computeSwap, decodeWhirlpoolState } = require('./src/localPools');

const conn = new Connection(process.env.RPC_URL_PRIMARY);

// Pool configs
const POOLS = [
    {
        address: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
        pair: {
            name: 'SOL/USDC',
            tokenA: 'So11111111111111111111111111111111111111112',
            tokenB: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            decimalsA: 9,
            decimalsB: 6,
        },
    },
    {
        address: 'FwewVm8u6tFPGewAyHmWAqad9hmF7mvqxK4mJ7iNqqGC',
        pair: {
            name: 'SOL/USDT',
            tokenA: 'So11111111111111111111111111111111111111112',
            tokenB: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
            decimalsA: 9,
            decimalsB: 6,
        },
    },
];

async function main() {
    console.log('=== Local Pool Math Verification ===\n');

    // Step 1: Register pools
    for (const p of POOLS) {
        registerPool(p.address, p.pair);
    }

    // Step 2: Fetch on-chain state and update cache
    for (const p of POOLS) {
        const info = await conn.getAccountInfo(new PublicKey(p.address));
        if (!info) { console.log(`Pool ${p.address} not found`); continue; }
        const state = updatePoolState(p.address, info.data);
        console.log(`${p.pair.name} pool loaded:`);
        console.log(`  sqrtPrice:  ${state.sqrtPrice}`);
        console.log(`  liquidity:  ${state.liquidity}`);
        console.log(`  tickCurrent: ${state.tickCurrent}`);
        console.log(`  feeRate:    ${state.feeRate} (${Number(state.feeRate)/100} bps)`);

        // Compute price
        const sqrtPriceF = Number(state.sqrtPrice) / (2 ** 64);
        const price = sqrtPriceF * sqrtPriceF * (10 ** (p.pair.decimalsA - p.pair.decimalsB));
        console.log(`  price:      $${price.toFixed(4)}`);
        console.log('');
    }

    // Step 3: Test swap math vs Jupiter for different amounts
    const testAmounts = [
        { sol: 1,  lamports: 1_000_000_000n },
        { sol: 5,  lamports: 5_000_000_000n },
        { sol: 10, lamports: 10_000_000_000n },
    ];

    for (const p of POOLS) {
        console.log(`\n--- ${p.pair.name} Swap Comparison ---`);

        for (const { sol, lamports } of testAmounts) {
            // Local math: SOL → token
            const localBuy = simulateSwap(p.pair.tokenA, p.pair.tokenB, lamports, p.pair.name);

            // Jupiter quote: SOL → token
            let jupBuy = null;
            try {
                const res = await axios.get('https://lite-api.jup.ag/swap/v1/quote', {
                    params: {
                        inputMint:  p.pair.tokenA,
                        outputMint: p.pair.tokenB,
                        amount:     lamports.toString(),
                        slippageBps: 0,
                    },
                    timeout: 5000,
                });
                jupBuy = res.data;
            } catch (e) {
                console.log(`  Jupiter quote failed: ${e.message}`);
            }

            if (localBuy && jupBuy) {
                const localOut = BigInt(localBuy.outAmount);
                const jupOut   = BigInt(jupBuy.outAmount);
                const diff     = Number(localOut - jupOut);
                const diffPct  = (diff / Number(jupOut)) * 100;
                const decimals = p.pair.decimalsB;

                console.log(`  ${sol} SOL → ${p.pair.name.split('/')[1]}:`);
                console.log(`    Local:   ${(Number(localOut) / 10**decimals).toFixed(decimals)} (${localOut})`);
                console.log(`    Jupiter: ${(Number(jupOut) / 10**decimals).toFixed(decimals)} (${jupOut})`);
                console.log(`    Diff:    ${diffPct.toFixed(4)}% (${diff > 0 ? '+' : ''}${diff})`);
                console.log(`    Route:   ${jupBuy.routePlan ? jupBuy.routePlan.map(r => r.swapInfo.label).join(' → ') : 'unknown'}`);
            } else {
                console.log(`  ${sol} SOL: local=${localBuy ? localBuy.outAmount : 'null'}, jup=${jupBuy ? jupBuy.outAmount : 'null'}`);
            }

            // Rate limit Jupiter
            await new Promise(r => setTimeout(r, 300));
        }
    }

    // Step 4: Test round-trip (buy + sell)
    console.log('\n\n--- Round-Trip Test (1 SOL) ---');
    for (const p of POOLS) {
        const state = Array.from(require('./src/localPools')._poolCache.values())
            .find(s => s.pairName === p.pair.name);
        if (!state) continue;

        const buyResult  = computeSwap(p.pair.tokenA, p.pair.tokenB, 1_000_000_000n, state);
        if (!buyResult) { console.log(`${p.pair.name}: buy failed`); continue; }

        const sellResult = computeSwap(p.pair.tokenB, p.pair.tokenA, buyResult.amountOut, state);
        if (!sellResult) { console.log(`${p.pair.name}: sell failed`); continue; }

        const profit = sellResult.amountOut - 1_000_000_000n;
        console.log(`${p.pair.name}:`);
        console.log(`  Buy:    1 SOL → ${Number(buyResult.amountOut) / 1e6} ${p.pair.name.split('/')[1]}`);
        console.log(`  Sell:   ${Number(buyResult.amountOut) / 1e6} → ${Number(sellResult.amountOut) / 1e9} SOL`);
        console.log(`  Profit: ${Number(profit)} lamports (${(Number(profit) / 1e9).toFixed(6)} SOL)`);
        console.log(`  Spread: ${(Number(profit) / 1e9 * 100).toFixed(4)}%`);
    }

    console.log('\n=== Done ===');
}

main().catch(e => console.error('Fatal:', e.message));
