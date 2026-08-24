'use strict';
const { PublicKey } = require('@solana/web3.js');

// ── Orca Whirlpool (653 bytes) ──
const ORCA = { TICK_SPACING:43, FEE_RATE:45, LIQUIDITY:49, SQRT_PRICE:65, TICK_CURRENT:81, MINT_A:101, VAULT_A:133, MINT_B:181, VAULT_B:213, DATA_LEN:653, FEE_DENOM:1_000_000n };

// ── Raydium CLMM (1544 bytes) ──
const RAYDIUM = { AMM_CONFIG:9, MINT_A:73, MINT_B:105, VAULT_A:137, VAULT_B:169, OBSERVATION_KEY:201, TICK_SPACING:235, LIQUIDITY:237, SQRT_PRICE:253, TICK_CURRENT:269, DATA_LEN:1544, DEFAULT_FEE:100n, FEE_DENOM:1_000_000n };

// ── Meteora DLMM (904 bytes) ──

// ── Raydium AMM v4 (752 bytes) ──
const RAYDIUM_AMM = { COIN_VAULT_AMOUNT:208, PC_VAULT_AMOUNT:216, MINT_A:400, MINT_B:432, DATA_LEN:752, FEE_NUM:9975n, FEE_DENOM:10000n };
const METEORA = { MINT_X:88, MINT_Y:120, BIN_STEP:80, ACTIVE_BIN_ID:48, DATA_LEN:904 };

const Q64 = 1n << 64n;
const MIN_SQRT_PRICE = 4295048017n;
const MAX_SQRT_PRICE = 79226673515401279992447579055n;
const poolCache = new Map();
const poolRegistry = new Map();

function readU128(d, o) { return (d.readBigUInt64LE(o+8) << 64n) | d.readBigUInt64LE(o); }

function decodePoolState(data, dexType) {
    if (!data) return null;
    if (!dexType) {
        if (data.length === ORCA.DATA_LEN) dexType = 'Orca';
        else if (data.length === RAYDIUM.DATA_LEN) dexType = 'Raydium CLMM';
        else if (data.length === METEORA.DATA_LEN) dexType = 'Meteora';
        else if (data.length === RAYDIUM_AMM.DATA_LEN) dexType = 'Raydium AMM';
        else return null;
    }

    if (dexType === 'Orca' && data.length >= ORCA.DATA_LEN) {
        return { dexType:'Orca', sqrtPrice:readU128(data,ORCA.SQRT_PRICE), liquidity:readU128(data,ORCA.LIQUIDITY),
            tickCurrent:data.readInt32LE(ORCA.TICK_CURRENT), feeRate:BigInt(data.readUInt16LE(ORCA.FEE_RATE)), feeDenom:ORCA.FEE_DENOM,
            tickSpacing:data.readUInt16LE(ORCA.TICK_SPACING),
            mintA:new PublicKey(data.slice(ORCA.MINT_A,ORCA.MINT_A+32)).toBase58(),
            vaultA:new PublicKey(data.slice(ORCA.VAULT_A,ORCA.VAULT_A+32)).toBase58(),
            mintB:new PublicKey(data.slice(ORCA.MINT_B,ORCA.MINT_B+32)).toBase58(),
            vaultB:new PublicKey(data.slice(ORCA.VAULT_B,ORCA.VAULT_B+32)).toBase58() };
    }

    if (dexType === 'Raydium CLMM' && data.length >= RAYDIUM.DATA_LEN) {
        return { dexType:'Raydium CLMM', sqrtPrice:readU128(data,RAYDIUM.SQRT_PRICE), liquidity:readU128(data,RAYDIUM.LIQUIDITY),
            tickCurrent:data.readInt32LE(RAYDIUM.TICK_CURRENT), feeRate:null, feeDenom:RAYDIUM.FEE_DENOM,
            mintA:new PublicKey(data.slice(RAYDIUM.MINT_A,RAYDIUM.MINT_A+32)).toBase58(),
            mintB:new PublicKey(data.slice(RAYDIUM.MINT_B,RAYDIUM.MINT_B+32)).toBase58(),
            vaultA:new PublicKey(data.slice(RAYDIUM.VAULT_A,RAYDIUM.VAULT_A+32)).toBase58(),
            vaultB:new PublicKey(data.slice(RAYDIUM.VAULT_B,RAYDIUM.VAULT_B+32)).toBase58(),
            ammConfig:new PublicKey(data.slice(RAYDIUM.AMM_CONFIG,RAYDIUM.AMM_CONFIG+32)).toBase58(),
            observationKey:new PublicKey(data.slice(RAYDIUM.OBSERVATION_KEY,RAYDIUM.OBSERVATION_KEY+32)).toBase58(),
            tickSpacing:data.readUInt16LE(RAYDIUM.TICK_SPACING) };
    }

    if (dexType === 'Meteora' && data.length >= METEORA.DATA_LEN) {
        const binStep = data.readUInt16LE(METEORA.BIN_STEP);
        const activeBinId = data.readInt32LE(METEORA.ACTIVE_BIN_ID);
        return { dexType:'Meteora', binStep, activeBinId, feeRate:null, feeDenom:1_000_000n,
            sqrtPrice:0n, liquidity:0n, tickCurrent:0,
            mintA:new PublicKey(data.slice(METEORA.MINT_X,METEORA.MINT_X+32)).toBase58(),
            mintB:new PublicKey(data.slice(METEORA.MINT_Y,METEORA.MINT_Y+32)).toBase58() };
    }

    if (dexType === 'Raydium AMM' && data.length >= RAYDIUM_AMM.DATA_LEN) {
        return { dexType:'Raydium AMM',
            mintA:new PublicKey(data.slice(RAYDIUM_AMM.MINT_A,RAYDIUM_AMM.MINT_A+32)).toBase58(),
            mintB:new PublicKey(data.slice(RAYDIUM_AMM.MINT_B,RAYDIUM_AMM.MINT_B+32)).toBase58(),
            reserveA:data.readBigUInt64LE(RAYDIUM_AMM.COIN_VAULT_AMOUNT),
            reserveB:data.readBigUInt64LE(RAYDIUM_AMM.PC_VAULT_AMOUNT) / 100n,
            sqrtPrice:0n, liquidity:0n, tickCurrent:0, feeRate:null, feeDenom:RAYDIUM_AMM.FEE_DENOM };
    }

    return null;
}

function registerPool(addr, pair, dexType, feeOverride) {
    poolRegistry.set(addr, { pairName:pair.name, tokenA:pair.tokenA, tokenB:pair.tokenB,
        decimalsA:pair.decimalsA, decimalsB:pair.decimalsB, dexType:dexType||'Orca',
        feeRate:feeOverride!=null?BigInt(feeOverride):null });
}

function updatePoolState(addr, data, dexType) {
    const reg = poolRegistry.get(addr);
    if (!reg) return null;
    const state = decodePoolState(data, dexType || reg.dexType);
    if (!state) return null;
    if (state.feeRate === null) {
        // BUG 6 fix: SOL/BONK Raydium CLMM pool uses 0.25% fee (2500/1000000)
        if (state.dexType === 'Raydium CLMM' && addr === 'GtKKKs3yaPdHbQd2aZS4SfWhy8zQ988BJGnKNndLxYsN') {
            state.feeRate = 2500n;
        } else {
            state.feeRate = reg.feeRate || RAYDIUM.DEFAULT_FEE;
        }
    }
    const prev = poolCache.get(addr);
    const priceChanged = !prev || prev.sqrtPrice !== state.sqrtPrice;
    const cached = { ...state, pairName:reg.pairName, tokenA:reg.tokenA, tokenB:reg.tokenB,
        decimalsA:reg.decimalsA, decimalsB:reg.decimalsB, lastUpdate:Date.now() };
    poolCache.set(addr, cached);
    return cached;
}

function getPoolState(a) { return poolCache.get(a)||null; }
function getPoolsForPair(n) { const r=[]; for(const[a,s]of poolCache){if(s.pairName===n)r.push({address:a,...s});} return r; }

function computeSwap(inputMint, outputMint, amountIn, ps) {
    if (!ps) return null;
    // Raydium AMM v4 constant-product swap
    if (ps.dexType === 'Raydium AMM') {
        if (!ps.reserveA || !ps.reserveB || ps.reserveA === 0n || ps.reserveB === 0n) return null;
        const isAtoB = inputMint === ps.mintA;
        if (!isAtoB && inputMint !== ps.mintB) return null;
        const reserveIn  = isAtoB ? ps.reserveA : ps.reserveB;
        const reserveOut = isAtoB ? ps.reserveB : ps.reserveA;
        const amtWithFee = amountIn * RAYDIUM_AMM.FEE_NUM;
        const out = (reserveOut * amtWithFee) / (reserveIn * RAYDIUM_AMM.FEE_DENOM + amtWithFee);
        if (out <= 0n) return null;
        const priceImpactBps = Number(amountIn * 10000n / (reserveIn + amountIn));
        return { amountOut:out, newSqrtPrice:0n, priceImpactBps };
    }
    // CLMM swap math (Orca + Raydium)
    if (ps.dexType !== 'Meteora') {
        if (ps.liquidity === 0n) return null;
        const { sqrtPrice, liquidity, feeRate, feeDenom } = ps;
        const isAtoB = inputMint === ps.mintA;
        if (!isAtoB && inputMint !== ps.mintB) return null;
        const den = feeDenom || 1_000_000n;
        const amt = amountIn * (den - feeRate) / den;
        let out, nsp;
        if (isAtoB) {
            const d = liquidity + (amt * sqrtPrice / Q64);
            if (d === 0n) return null;
            nsp = liquidity * sqrtPrice / d;
            if (nsp < MIN_SQRT_PRICE) nsp = MIN_SQRT_PRICE;
            out = liquidity * (sqrtPrice - nsp) / Q64;
        } else {
            nsp = sqrtPrice + (amt * Q64 / liquidity);
            if (nsp > MAX_SQRT_PRICE) nsp = MAX_SQRT_PRICE;
            out = (liquidity * Q64 / sqrtPrice) - (liquidity * Q64 / nsp);
        }
        if (out <= 0n) return null;
        const oP=Number(sqrtPrice), nP=Number(nsp);
        return { amountOut:out, newSqrtPrice:nsp, priceImpactBps:Math.abs(1-(nP/oP)**2)*10000 };
    }
    // Meteora: no swap math, only price detection
    return null;
}

function getPoolPrice(s) {
    if (!s) return 0;
    // Raydium AMM v4: constant-product price
    if (s.dexType === 'Raydium AMM') {
        if (!s.reserveA || !s.reserveB || s.reserveA === 0n || s.reserveB === 0n) return 0;
        return (Number(s.reserveB) / Number(s.reserveA)) * (10 ** (s.decimalsA - s.decimalsB));
    }
    // Meteora DLMM: price from binStep + activeBinId
    if (s.dexType === 'Meteora') {
        if (!s.binStep || s.activeBinId === undefined) return 0;
        const base = 1 + s.binStep / 10000;
        return Math.pow(base, s.activeBinId) * (10 ** (s.decimalsA - s.decimalsB));
    }
    // CLMM (Orca + Raydium): price from sqrtPrice
    if (s.sqrtPrice === 0n) return 0;
    const f = Number(s.sqrtPrice) / (2**64);
    return f * f * (10 ** (s.decimalsA - s.decimalsB));
}

function simulateSwap(im, om, ai, pn) {
    const pools=getPoolsForPair(pn); let best=0n, bp=null;
    for(const p of pools){const r=computeSwap(im,om,BigInt(ai),p);if(r&&r.amountOut>best){best=r.amountOut;bp=p.address;}}
    if(best===0n)return null; return{outAmount:best.toString(),poolAddress:bp};
}

function checkSpread(pn, ref) {
    const pools=getPoolsForPair(pn); let best=0, res=null;
    for(const p of pools){if(p.dexType!=='Meteora'&&p.liquidity===0n)continue;
    const pp=getPoolPrice(p);if(pp===0)continue;
    const s=Math.abs(pp-ref)/ref;if(s>best){best=s;res={spreadPct:s,poolPrice:pp,poolAddress:p.address,dexType:p.dexType};}}
    return res;
}

function checkCrossPoolSpread(pairName, maxAgeMs = 3000) {
    const pools = getPoolsForPair(pairName);
    if (pools.length < 2) return null;

    // Collect ALL fresh pools with their fee info
    const fresh = [];
    for (const p of pools) {
        if (p.liquidity === 0n) continue; if (p.dexType === 'Meteora') continue;
        const age = Date.now() - (p.lastUpdate || 0);
        if (age > maxAgeMs) continue;
        const px = getPoolPrice(p);
        if (px <= 0) continue;
        const fee = (p.feeRate !== null && p.feeDenom) ? Number(p.feeRate) / Number(p.feeDenom) : 0.0025;
        // Only allow pools with VERIFIED tick arrays at current tick
        const VERIFIED_POOLS = new Set([
            // ts=2 pools (2bps fee) — PRIMARY BUY SIDE
            'FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q', // SOL/USDC Orca ts=2 (0.02%)
            'FwewVm8u6tFPGewAyHmWAqad9hmF7mvqxK4mJ7iNqqGC', // SOL/USDT Orca ts=2 (0.02%)
            // ts=4 pools (4bps fee) — PRIMARY SELL SIDE
            'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', // SOL/USDC Orca ts=4 (0.04%)
            'HcoJqG325TTifs6jyWvRJ9ET4pDu12Xrt2EQKZGFmuKX', // SOL/USDT Orca ts=4 (0.04%)
            // ts=8 pools (5bps fee) — BACKUP
            '7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm', // SOL/USDC Orca ts=8 (0.05%)
            // SOL/WIF kept for future use
            'D6NdKrKNQPmRZCCnG1GqXtF7MMoHB7qR6GU5TkG59Qz1', // SOL/WIF Orca ts=4 (0.04%)
        ]);
        if (!VERIFIED_POOLS.has(p.address)) continue;
        fresh.push({ address: p.address, dexType: p.dexType, price: px, liquidity: p.liquidity, fee });
    }

    if (fresh.length < 2) return null;

    // Find the best pair: highest spread MINUS combined fees
    // Only consider pairs where combined fee < 0.20% (viable for arb)
    const MAX_COMBINED_FEE = 0.0020; // 0.20%
    let bestNet = -Infinity, bestHi = null, bestLo = null;
    for (let i = 0; i < fresh.length; i++) {
        for (let j = i + 1; j < fresh.length; j++) {
            const a = fresh[i], b = fresh[j];
            const combinedFee = a.fee + b.fee;
            if (combinedFee > MAX_COMBINED_FEE) continue;
            const hi = a.price > b.price ? a : b;
            const lo = a.price > b.price ? b : a;
            const spread = (hi.price - lo.price) / lo.price;
            const net = spread - combinedFee;
            if (net > bestNet) { bestNet = net; bestHi = hi; bestLo = lo; }
        }
    }

    if (!bestHi || !bestLo) return null;
    const spread = (bestHi.price - bestLo.price) / bestLo.price;
    return { spreadPct: spread, hiPool: bestHi, loPool: bestLo };
}

function localReSizeScan(pair, maxLamports, minProfitLamports) {
    const MIN_LAM = 1_000_000_000n; // 1 SOL floor
    const maxLam = BigInt(maxLamports);
    const minProfit = BigInt(minProfitLamports);
    const pools = getPoolsForPair(pair.name);
    if (!pools || pools.length === 0) return null;

    const steps = [1.0, 0.75, 0.5, 0.25];
    for (const step of steps) {
        const lam = BigInt(Math.floor(Number(maxLam) * step));
        if (lam < MIN_LAM) continue;

        // Best buy: SOL -> tokenB across all pools
        let bestBuyOut = 0n;
        for (const p of pools) {
            const r = computeSwap(pair.tokenA, pair.tokenB, lam, p);
            if (r && r.amountOut > bestBuyOut) bestBuyOut = r.amountOut;
        }
        if (bestBuyOut === 0n) continue;

        // Best sell: tokenB -> SOL across all pools
        let bestSellOut = 0n;
        for (const p of pools) {
            const r = computeSwap(pair.tokenB, pair.tokenA, bestBuyOut, p);
            if (r && r.amountOut > bestSellOut) bestSellOut = r.amountOut;
        }
        if (bestSellOut === 0n) continue;

        const profit = bestSellOut - lam;
        if (profit >= minProfit) {
            return {
                amountIn: lam,
                loanSizeSol: Number(lam) / 1e9,
                estimatedProfit: profit,
                spreadPct: Number(profit) / Number(lam),
            };
        }
    }
    return null;
}

module.exports = { registerPool, updatePoolState, decodePoolState, getPoolState, getPoolsForPair, getPoolPrice,
    computeSwap, simulateSwap, checkSpread, checkCrossPoolSpread, localReSizeScan, _poolCache:poolCache, _poolRegistry:poolRegistry };
