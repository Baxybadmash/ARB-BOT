'use strict';
const { PublicKey } = require('@solana/web3.js');

// ── Orca Whirlpool (653 bytes) ──
const ORCA = { FEE_RATE:45, LIQUIDITY:49, SQRT_PRICE:65, TICK_CURRENT:81, MINT_A:101, MINT_B:181, DATA_LEN:653, FEE_DENOM:1_000_000n };

// ── Raydium CLMM (1544 bytes) ──
const RAYDIUM = { MINT_A:73, MINT_B:105, LIQUIDITY:237, SQRT_PRICE:253, TICK_CURRENT:269, DATA_LEN:1544, DEFAULT_FEE:100n, FEE_DENOM:1_000_000n };

// ── Meteora DLMM (904 bytes) ──
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
        else return null;
    }

    if (dexType === 'Orca' && data.length >= ORCA.DATA_LEN) {
        return { dexType:'Orca', sqrtPrice:readU128(data,ORCA.SQRT_PRICE), liquidity:readU128(data,ORCA.LIQUIDITY),
            tickCurrent:data.readInt32LE(ORCA.TICK_CURRENT), feeRate:BigInt(data.readUInt16LE(ORCA.FEE_RATE)), feeDenom:ORCA.FEE_DENOM,
            mintA:new PublicKey(data.slice(ORCA.MINT_A,ORCA.MINT_A+32)).toBase58(),
            mintB:new PublicKey(data.slice(ORCA.MINT_B,ORCA.MINT_B+32)).toBase58() };
    }

    if (dexType === 'Raydium CLMM' && data.length >= RAYDIUM.DATA_LEN) {
        return { dexType:'Raydium CLMM', sqrtPrice:readU128(data,RAYDIUM.SQRT_PRICE), liquidity:readU128(data,RAYDIUM.LIQUIDITY),
            tickCurrent:data.readInt32LE(RAYDIUM.TICK_CURRENT), feeRate:null, feeDenom:RAYDIUM.FEE_DENOM,
            mintA:new PublicKey(data.slice(RAYDIUM.MINT_A,RAYDIUM.MINT_A+32)).toBase58(),
            mintB:new PublicKey(data.slice(RAYDIUM.MINT_B,RAYDIUM.MINT_B+32)).toBase58() };
    }

    if (dexType === 'Meteora' && data.length >= METEORA.DATA_LEN) {
        const binStep = data.readUInt16LE(METEORA.BIN_STEP);
        const activeBinId = data.readInt32LE(METEORA.ACTIVE_BIN_ID);
        return { dexType:'Meteora', binStep, activeBinId, feeRate:null, feeDenom:1_000_000n,
            sqrtPrice:0n, liquidity:0n, tickCurrent:0,
            mintA:new PublicKey(data.slice(METEORA.MINT_X,METEORA.MINT_X+32)).toBase58(),
            mintB:new PublicKey(data.slice(METEORA.MINT_Y,METEORA.MINT_Y+32)).toBase58() };
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
    if (state.feeRate === null) state.feeRate = reg.feeRate || RAYDIUM.DEFAULT_FEE;
    const cached = { ...state, pairName:reg.pairName, tokenA:reg.tokenA, tokenB:reg.tokenB,
        decimalsA:reg.decimalsA, decimalsB:reg.decimalsB, lastUpdate:Date.now() };
    poolCache.set(addr, cached);
    return cached;
}

function getPoolState(a) { return poolCache.get(a)||null; }
function getPoolsForPair(n) { const r=[]; for(const[a,s]of poolCache){if(s.pairName===n)r.push({address:a,...s});} return r; }

function computeSwap(inputMint, outputMint, amountIn, ps) {
    if (!ps) return null;
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

module.exports = { registerPool, updatePoolState, decodePoolState, getPoolState, getPoolsForPair, getPoolPrice,
    computeSwap, simulateSwap, checkSpread, _poolCache:poolCache, _poolRegistry:poolRegistry };
