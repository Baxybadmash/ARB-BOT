// diagnose.js — Live quote comparison diagnostic
// Run: node diagnose.js
// Shows exactly what each DEX quotes and whether dexes= filter works.

require('dotenv').config();
const axios = require('axios');

const JUPITER_QUOTE_API = 'https://lite-api.jup.ag/swap/v1/quote';
const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WIF_MINT  = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const JUP_MINT  = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

const LOAN_SOL = 10;  // 10 SOL test
const AMOUNT   = Math.floor(LOAN_SOL * 1e9).toString();

async function quote(inputMint, outputMint, amount, params = {}) {
    try {
        const r = await axios.get(JUPITER_QUOTE_API, {
            params: { inputMint, outputMint, amount, slippageBps: 50, ...params },
            timeout: 5000
        });
        return r.data;
    } catch (e) {
        return null;
    }
}

async function testPair(name, tokenB) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${name}  (input: ${LOAN_SOL} SOL)`);
    console.log('─'.repeat(60));

    const [jupAll, jupDirect, orca, raydium, meteora] = await Promise.all([
        quote(SOL_MINT, tokenB, AMOUNT, { onlyDirectRoutes: false }),
        quote(SOL_MINT, tokenB, AMOUNT, { onlyDirectRoutes: true }),
        quote(SOL_MINT, tokenB, AMOUNT, { dexes: 'Whirlpool' }),
        quote(SOL_MINT, tokenB, AMOUNT, { dexes: 'Raydium,Raydium CLMM,Raydium CP' }),
        quote(SOL_MINT, tokenB, AMOUNT, { dexes: 'Meteora,Meteora DLMM' }),
    ]);

    const fmt = (q, label) => {
        if (!q) return `  ${label.padEnd(18)}: null (no pool / dexes= not supported?)`;
        const out = parseInt(q.outAmount || 0);
        const route = (q.routePlan || []).map(r => r.swapInfo?.label || r.swapInfo?.ammKey?.slice(0,8) || '?').join('→');
        return `  ${label.padEnd(18)}: ${out.toLocaleString()} (route: ${route || 'n/a'})`;
    };

    console.log(fmt(jupAll,    'Jupiter (all)'));
    console.log(fmt(jupDirect, 'Jupiter (direct)'));
    console.log(fmt(orca,      'Orca only'));
    console.log(fmt(raydium,   'Raydium only'));
    console.log(fmt(meteora,   'Meteora only'));

    // Check if dexes= filter is actually doing anything
    const outAll     = parseInt(jupAll?.outAmount || 0);
    const outOrca    = parseInt(orca?.outAmount    || 0);
    const outRaydium = parseInt(raydium?.outAmount || 0);
    const outMeteora = parseInt(meteora?.outAmount || 0);

    const quotes = [outOrca, outRaydium, outMeteora].filter(v => v > 0);
    if (quotes.length === 0) {
        console.log('\n  ⚠️  ALL DEX-specific quotes returned null — dexes= filter may not be supported');
        return;
    }
    if (quotes.every(v => v === outAll)) {
        console.log('\n  ⚠️  All DEX quotes == Jupiter best → dexes= filter appears to be IGNORED');
    }

    const maxOut = Math.max(...quotes, outAll);
    const minOut = Math.min(...quotes.filter(v => v > 0));
    const spreadPct = ((maxOut - minOut) / maxOut * 100).toFixed(4);
    console.log(`\n  Spread (best vs worst DEX): ${spreadPct}%`);

    if (maxOut <= 0) return;

    // Simulate sell: best buy DEX → best sell DEX
    const bestBuyAmt = maxOut.toString();
    console.log(`\n  Sell phase (selling ${maxOut.toLocaleString()} tokens back to SOL):`);

    const [sellJup, sellOrca, sellRay, sellMet] = await Promise.all([
        quote(tokenB, SOL_MINT, bestBuyAmt, { onlyDirectRoutes: false }),
        quote(tokenB, SOL_MINT, bestBuyAmt, { dexes: 'Orca' }),
        quote(tokenB, SOL_MINT, bestBuyAmt, { dexes: 'Raydium,Raydium CLMM,Raydium CP' }),
        quote(tokenB, SOL_MINT, bestBuyAmt, { dexes: 'Meteora,Meteora DLMM' }),
    ]);

    const fmtSell = (q, label) => {
        if (!q) return `  ${label.padEnd(18)}: null`;
        const sol = parseInt(q.outAmount || 0);
        const pct = ((sol - LOAN_SOL*1e9) / (LOAN_SOL*1e9) * 100).toFixed(4);
        const profit = sol - LOAN_SOL*1e9;
        return `  ${label.padEnd(18)}: ${sol.toLocaleString()} lamports | P/L: ${pct}% (${profit > 0 ? '+' : ''}${profit.toLocaleString()})`;
    };

    console.log(fmtSell(sellJup,  'Jupiter (all)'));
    console.log(fmtSell(sellOrca, 'Orca only'));
    console.log(fmtSell(sellRay,  'Raydium only'));
    console.log(fmtSell(sellMet,  'Meteora only'));

    const bestSell = Math.max(
        parseInt(sellJup?.outAmount || 0),
        parseInt(sellOrca?.outAmount || 0),
        parseInt(sellRay?.outAmount || 0),
        parseInt(sellMet?.outAmount || 0)
    );
    const grossProfit = bestSell - LOAN_SOL * 1e9;
    const flashloanFee = 0; // MarginFi flashloans are free (confirmed: docs.marginfi.com/faqs)
    const jitoTip = parseInt(process.env.JITO_TIP_LAMPORTS || '150000');
    const txFee = 10000;
    const netProfit = grossProfit - flashloanFee - jitoTip - txFee;
    console.log(`\n  Gross profit:    ${grossProfit.toLocaleString()} lamports (${(grossProfit/1e9).toFixed(6)} SOL)`);
    console.log(`  Flashloan fee:   ${Math.round(flashloanFee).toLocaleString()} lamports`);
    console.log(`  Net profit:      ${Math.round(netProfit).toLocaleString()} lamports (${(netProfit/1e9).toFixed(6)} SOL)`);
    const solPrice = parseFloat(process.env.SOL_PRICE_USD || '130');
    console.log(`  Net profit USD:  $${(netProfit/1e9*solPrice).toFixed(4)}`);
    console.log(netProfit > 0 ? '  ✅ PROFITABLE' : '  ❌ NOT profitable (fees > gross profit)');
}

async function main() {
    console.log('═'.repeat(60));
    console.log('  LIVE QUOTE DIAGNOSTIC');
    console.log('  Testing DEX-specific pricing via Jupiter API');
    console.log('═'.repeat(60));
    console.log(`  Loan size: ${LOAN_SOL} SOL | Slippage: 50bps`);

    await testPair('SOL/BONK',  BONK_MINT);
    await testPair('SOL/WIF',   WIF_MINT);
    await testPair('SOL/JUP',   JUP_MINT);

    console.log('\n' + '═'.repeat(60));
}

main().catch(console.error);
