// src/simulate.js — Test mode, no transactions sent
require('dotenv').config();
const { Connection, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { PriceScanner } = require('./scanner');
const { getSolPrice, initPriceStream } = require('./price');

async function simulate() {
    console.log('\n🧪 SIMULATION MODE — No transactions will be sent\n');

    const connection = new Connection(
        process.env.RPC_URL_PRIMARY || 'https://api.mainnet-beta.solana.com',
        'confirmed'
    );
    const slot = await connection.getSlot();
    console.log(`Connected to Solana | Slot: ${slot}`);

    // Latency test
    const times = [];
    for (let i = 0; i < 5; i++) {
        const t = Date.now();
        await connection.getSlot();
        times.push(Date.now() - t);
    }
    const avg = times.reduce((a, b) => a + b) / times.length;
    console.log(`Average RPC latency: ${avg.toFixed(0)}ms`);
    if (avg < 50)       console.log('✅ Excellent latency');
    else if (avg < 150) console.log('✅ Good latency');
    else                console.log('⚠️  High latency — check your RPC endpoint');

    const minSol        = parseFloat(process.env.MIN_FLASHLOAN_AMOUNT_SOL || '10');
    const maxSol        = parseFloat(process.env.FLASHLOAN_AMOUNT_SOL     || '100');
    const minLamports   = Math.floor(minSol * LAMPORTS_PER_SOL);
    const maxLamports   = Math.floor(maxSol * LAMPORTS_PER_SOL);
    initPriceStream();
    await new Promise(r => setTimeout(r, 1500)); // wait for seed HTTP fetch + first WS price
    const solPrice = getSolPrice();

    console.log(`\nScanning ${minSol}–${maxSol} SOL flashloan range (SOL price: $${solPrice.toFixed(2)})...\n`);

    const scanner = new PriceScanner(connection);
    const start   = Date.now();
    const opps    = await scanner.findOpportunities(minLamports, maxLamports);
    console.log(`Scan completed in ${Date.now() - start}ms\n`);

    if (opps.length === 0) {
        console.log('No profitable opportunities right now — normal in quiet markets.');
        console.log('Bot will catch them automatically during volatile conditions.\n');
    } else {
        console.log(`Found ${opps.length} opportunity(ies):\n`);
        opps.forEach((o, i) => {
            const profitSol = Number(o.grossProfit) / 1e9;
            const profitUsd = (profitSol * solPrice).toFixed(4);
            console.log(`  #${i + 1} ${o.pair.name}`);
            console.log(`      Spread:       ${o.priceDiffPct}%`);
            console.log(`      Best DEX:     ${o.bestDex}`);
            console.log(`      Loan size:    ${o.loanSizeSol?.toFixed(1)} SOL`);
            console.log(`      Gross profit: ${profitSol.toFixed(6)} SOL (~$${profitUsd} USD)\n`);
        });
    }

    console.log('✅ Simulation done. If RPC looks good, run: npm start\n');
}

simulate().catch(e => {
    console.error('\n❌ Simulation failed:', e.message);
    console.error('Check your .env and RPC URL\n');
});
