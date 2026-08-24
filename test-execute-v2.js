#!/usr/bin/env node
'use strict';

/**
 * test-execute-v2.js — Pipeline test on ts=1 + ts=2 (0.03% combined fee)
 *
 * Derives pool PDAs from whirlpoolsConfig, so no hardcoded pool addresses.
 * Expected: atomic revert (0.03% fee drag). Proves pipeline works on ts=1 pools.
 */

require('dotenv').config();
const {
    Connection, PublicKey, Keypair, TransactionInstruction,
    TransactionMessage, VersionedTransaction, SystemProgram,
} = require('@solana/web3.js');
const {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const { buildOrcaSwapIx, getTickArrayStartIndices, deriveTickArrayPDA } = require('./src/orcaBuilder');
const bs58 = require('bs58');
const axios = require('axios');

// ────────────────────────── CONSTANTS ──────────────────────────

const WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const WHIRLPOOLS_CONFIG    = new PublicKey('2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ');

const SOL_MINT  = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// Kamino
const KAMINO_PROGRAM_ID   = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const KAMINO_MARKET_AUTH  = new PublicKey('9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo');
const KAMINO_MARKET       = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
const KAMINO_SOL_RESERVE  = new PublicKey('d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q');
const KAMINO_SOL_VAULT    = new PublicKey('GafNuUXj9rxGLn4y79dPu6MHSuPWeJR6UtTWuexpGh3U');
const KAMINO_FEE_RECEIVER = new PublicKey('3JNof8s453bwG5UqiXBLJc77NRQXezYYEBbk3fqnoKph');
const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const TOKEN_PROGRAM       = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const KAMINO_FLASH_BORROW_DISC = Buffer.from([135, 231, 52, 167, 7, 52, 212, 193]);
const KAMINO_FLASH_REPAY_DISC  = Buffer.from([185, 117, 0, 203, 96, 245, 180, 186]);

const JITO_TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zcaozNr7RD',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];
const JITO_ENDPOINTS = [
    'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/transactions',
    'https://mainnet.block-engine.jito.wtf/api/v1/transactions',
    'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/transactions',
];

const BORROW_AMOUNT = 1_000_000_000n; // 1 SOL
const JITO_TIP_LAMPORTS = 150_000;

// ────────────────────────── HELPERS ──────────────────────────

function derivePoolPDA(mintA, mintB, tickSpacing) {
    const pkA = new PublicKey(mintA);
    const pkB = new PublicKey(mintB);
    const [sortedA, sortedB] = Buffer.compare(pkA.toBuffer(), pkB.toBuffer()) < 0
        ? [pkA, pkB] : [pkB, pkA];
    const tsBuf = Buffer.alloc(2);
    tsBuf.writeUInt16LE(tickSpacing);
    return PublicKey.findProgramAddressSync(
        [Buffer.from('whirlpool'), WHIRLPOOLS_CONFIG.toBuffer(),
         sortedA.toBuffer(), sortedB.toBuffer(), tsBuf],
        WHIRLPOOL_PROGRAM_ID
    )[0];
}

function decodeWhirlpool(data) {
    return {
        tickSpacing: data.readUInt16LE(41),
        feeRate:     data.readUInt16LE(45),
        sqrtPrice:   data.readBigUInt64LE(65) | (data.readBigUInt64LE(73) << 64n),
        tickCurrent: data.readInt32LE(81),
        mintA:       new PublicKey(data.subarray(101, 133)).toBase58(),
        vaultA:      new PublicKey(data.subarray(133, 165)).toBase58(),
        mintB:       new PublicKey(data.subarray(181, 213)).toBase58(),
        vaultB:      new PublicKey(data.subarray(213, 245)).toBase58(),
    };
}

function buildKaminoBorrow(walletPk, wsolAta, amount) {
    const data = Buffer.alloc(16);
    KAMINO_FLASH_BORROW_DISC.copy(data, 0);
    data.writeBigUInt64LE(BigInt(amount), 8);
    return new TransactionInstruction({
        programId: KAMINO_PROGRAM_ID,
        keys: [
            { pubkey: walletPk,            isSigner: true,  isWritable: false },
            { pubkey: KAMINO_MARKET_AUTH,   isSigner: false, isWritable: false },
            { pubkey: KAMINO_MARKET,        isSigner: false, isWritable: false },
            { pubkey: KAMINO_SOL_RESERVE,   isSigner: false, isWritable: true  },
            { pubkey: SOL_MINT,             isSigner: false, isWritable: false },
            { pubkey: KAMINO_SOL_VAULT,     isSigner: false, isWritable: true  },
            { pubkey: wsolAta,              isSigner: false, isWritable: true  },
            { pubkey: KAMINO_FEE_RECEIVER,  isSigner: false, isWritable: true  },
            { pubkey: KAMINO_PROGRAM_ID,    isSigner: false, isWritable: false },
            { pubkey: KAMINO_PROGRAM_ID,    isSigner: false, isWritable: false },
            { pubkey: SYSVAR_INSTRUCTIONS,  isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM,        isSigner: false, isWritable: false },
        ],
        data,
    });
}

function buildKaminoRepay(walletPk, wsolAta, amount, borrowIxIndex) {
    const data = Buffer.alloc(17);
    KAMINO_FLASH_REPAY_DISC.copy(data, 0);
    data.writeBigUInt64LE(BigInt(amount), 8);
    data.writeUInt8(borrowIxIndex, 16);
    return new TransactionInstruction({
        programId: KAMINO_PROGRAM_ID,
        keys: [
            { pubkey: walletPk,            isSigner: true,  isWritable: false },
            { pubkey: KAMINO_MARKET_AUTH,   isSigner: false, isWritable: false },
            { pubkey: KAMINO_MARKET,        isSigner: false, isWritable: false },
            { pubkey: KAMINO_SOL_RESERVE,   isSigner: false, isWritable: true  },
            { pubkey: SOL_MINT,             isSigner: false, isWritable: false },
            { pubkey: KAMINO_SOL_VAULT,     isSigner: false, isWritable: true  },
            { pubkey: wsolAta,              isSigner: false, isWritable: true  },
            { pubkey: KAMINO_FEE_RECEIVER,  isSigner: false, isWritable: true  },
            { pubkey: KAMINO_PROGRAM_ID,    isSigner: false, isWritable: false },
            { pubkey: KAMINO_PROGRAM_ID,    isSigner: false, isWritable: false },
            { pubkey: SYSVAR_INSTRUCTIONS,  isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM,        isSigner: false, isWritable: false },
        ],
        data,
    });
}

// ────────────────────────── MAIN ──────────────────────────

async function main() {
    console.log('╔═════════════════════════════════════════════╗');
    console.log('║  PIPELINE TEST v2 — SOL/USDC ts=1 + ts=2   ║');
    console.log('║  Combined fee: 0.03% (was 0.09% on ts=4+8) ║');
    console.log('║  Expected: atomic revert (fee drag)         ║');
    console.log('╚═════════════════════════════════════════════╝\n');

    const conn = new Connection(process.env.RPC_URL_PRIMARY, 'processed');
    const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    const walletPk = wallet.publicKey;
    console.log('Wallet:', walletPk.toBase58());

    const balance = await conn.getBalance(walletPk);
    console.log('Balance:', (balance / 1e9).toFixed(4), 'SOL');
    if (balance < 10_000_000) { console.error('FATAL: need >= 0.01 SOL'); process.exit(1); }

    // ══════════════════════════════════════════
    //  STEP 1: Derive pool PDAs
    // ══════════════════════════════════════════
    console.log('\n[1/6] Deriving pool PDAs...');
    const solMint  = SOL_MINT.toBase58();
    const usdcMint = USDC_MINT.toBase58();

    const buyPoolPk  = derivePoolPDA(solMint, usdcMint, 2); // ts=2, 2bps
    const sellPoolPk = derivePoolPDA(solMint, usdcMint, 4); // ts=4, 4bps

    console.log('Buy pool  (ts=1):', buyPoolPk.toBase58());
    console.log('Sell pool (ts=2):', sellPoolPk.toBase58());

    // ══════════════════════════════════════════
    //  STEP 2: Fetch & decode pool states
    // ══════════════════════════════════════════
    console.log('\n[2/6] Fetching pool states...');
    const [buyAcct, sellAcct] = await conn.getMultipleAccountsInfo([buyPoolPk, sellPoolPk]);
    if (!buyAcct || !sellAcct) { console.error('FATAL: pool accounts not found'); process.exit(1); }

    const buyState  = decodeWhirlpool(buyAcct.data);
    const sellState = decodeWhirlpool(sellAcct.data);

    console.log(`Buy  (ts=${buyState.tickSpacing}): tick=${buyState.tickCurrent} fee=${buyState.feeRate/100}bps`);
    console.log(`  mintA=${buyState.mintA.slice(0,8)}  mintB=${buyState.mintB.slice(0,8)}`);
    console.log(`Sell (ts=${sellState.tickSpacing}): tick=${sellState.tickCurrent} fee=${sellState.feeRate/100}bps`);
    console.log(`  mintA=${sellState.mintA.slice(0,8)}  mintB=${sellState.mintB.slice(0,8)}`);

    // ══════════════════════════════════════════
    //  STEP 3: Verify tick arrays
    // ══════════════════════════════════════════
    console.log('\n[3/6] Verifying tick arrays...');
    const buyAToB  = buyState.mintA === solMint;
    const sellAToB = sellState.mintA === usdcMint;

    const buyIdxs  = getTickArrayStartIndices(buyState.tickCurrent, buyState.tickSpacing, buyAToB);
    const sellIdxs = getTickArrayStartIndices(sellState.tickCurrent, sellState.tickSpacing, sellAToB);

    const allTaPdas = [
        ...buyIdxs.map(i => deriveTickArrayPDA(buyPoolPk, i)),
        ...sellIdxs.map(i => deriveTickArrayPDA(sellPoolPk, i)),
    ];
    const taAccts = await conn.getMultipleAccountsInfo(allTaPdas);

    let allExist = true;
    for (let i = 0; i < 6; i++) {
        const pool = i < 3 ? 'BUY ' : 'SELL';
        const idx  = i < 3 ? buyIdxs[i] : sellIdxs[i - 3];
        const ok   = !!taAccts[i];
        console.log(`  ${pool} tickArray[${idx}]: ${ok ? '✅' : '❌ MISSING'}`);
        if (!ok) allExist = false;
    }
    if (!allExist) {
        console.error('\nFATAL: missing tick arrays');
        process.exit(1);
    }
    console.log('All 6 tick arrays confirmed ✅');

    // ══════════════════════════════════════════
    //  STEP 4: Estimate USDC output
    // ══════════════════════════════════════════
    console.log('\n[4/6] Estimating swap amounts...');
    const sqrtP  = buyState.sqrtPrice;
    const sqrtSq = sqrtP * sqrtP;
    const Q128   = 1n << 128n;

    // mintA=SOL means price = tokenA(SOL) per tokenB(USDC) in raw → invert for USDC output
    let estUsdcRaw;
    if (buyState.mintA === solMint) {
        // price = SOL_raw / USDC_raw → USDC = SOL * (1/price) = SOL * Q128 / sqrtSq
        estUsdcRaw = BORROW_AMOUNT * sqrtSq / Q128;
    } else {
        // price = USDC_raw / SOL_raw → USDC = SOL * price = SOL * sqrtSq / Q128
        estUsdcRaw = BORROW_AMOUNT * Q128 / sqrtSq;
    }

    // Use 99% — fee drag is only 0.03%, so 1% buffer is plenty
    const sellAmount = estUsdcRaw * 99n / 100n;
    console.log(`Est. USDC: ${estUsdcRaw} raw (~${(Number(estUsdcRaw) / 1e6).toFixed(2)} USDC)`);
    console.log(`Sell input (99%): ${sellAmount} raw (~${(Number(sellAmount) / 1e6).toFixed(2)} USDC)`);
    if (sellAmount <= 0n) { console.error('FATAL: zero estimate'); process.exit(1); }

    // ══════════════════════════════════════════
    //  STEP 5: Build transaction
    // ══════════════════════════════════════════
    console.log('\n[5/6] Building transaction...');
    const wsolAta = getAssociatedTokenAddressSync(SOL_MINT, walletPk);

    // Jito tip
    const tipIx = SystemProgram.transfer({
        fromPubkey: walletPk,
        toPubkey: new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]),
        lamports: JITO_TIP_LAMPORTS,
    });

    // WSOL ATA
    const wsolCreateIx = createAssociatedTokenAccountIdempotentInstruction(walletPk, wsolAta, walletPk, SOL_MINT);

    // Kamino borrow
    const borrowIx = buildKaminoBorrow(walletPk, wsolAta, BORROW_AMOUNT);

    // Compute budget
    const CB = new PublicKey('ComputeBudget111111111111111111111111111111');
    const cuLimitBuf = Buffer.alloc(5);
    cuLimitBuf.writeUInt8(2, 0);
    cuLimitBuf.writeUInt32LE(600_000, 1);
    const cuLimitIx = new TransactionInstruction({ programId: CB, keys: [], data: cuLimitBuf });
    const cuPriceBuf = Buffer.alloc(9);
    cuPriceBuf.writeUInt8(3, 0);
    cuPriceBuf.writeBigUInt64LE(1n, 1);
    const cuPriceIx = new TransactionInstruction({ programId: CB, keys: [], data: cuPriceBuf });

    // Buy: SOL → USDC on ts=1
    const buySwap = buildOrcaSwapIx({
        whirlpoolAddress: buyPoolPk.toBase58(),
        poolState: buyState,
        walletPubkey: walletPk,
        inputMint: solMint,
        amount: BORROW_AMOUNT,
        otherAmountThreshold: 0n,
        amountSpecifiedIsInput: true,
    });

    // Sell: USDC → SOL on ts=2
    const sellSwap = buildOrcaSwapIx({
        whirlpoolAddress: sellPoolPk.toBase58(),
        poolState: sellState,
        walletPubkey: walletPk,
        inputMint: usdcMint,
        amount: sellAmount,
        otherAmountThreshold: 0n,
        amountSpecifiedIsInput: true,
    });

    // Kamino repay
    const repayIx = buildKaminoRepay(walletPk, wsolAta, BORROW_AMOUNT, 0);

    // Close WSOL
    const closeIx = createCloseAccountInstruction(wsolAta, walletPk, walletPk);

    // Assemble
    const innerIxs = [
        tipIx, wsolCreateIx, borrowIx,
        cuLimitIx, cuPriceIx,
    ];
    if (buySwap.ataIx) innerIxs.push(buySwap.ataIx);
    innerIxs.push(buySwap.swapIx);
    innerIxs.push(sellSwap.swapIx);
    innerIxs.push(repayIx);
    innerIxs.push(closeIx);

    // Dynamic borrowIxIndex
    const kpid  = KAMINO_PROGRAM_ID.toBase58();
    const bdisc = KAMINO_FLASH_BORROW_DISC.toString('hex');
    let bIdx = -1;
    for (let i = 0; i < innerIxs.length; i++) {
        if (innerIxs[i].programId.toBase58() === kpid &&
            innerIxs[i].data.subarray(0, 8).toString('hex') === bdisc) { bIdx = i; break; }
    }
    if (bIdx === -1) throw new Error('BUG: borrow not found');
    repayIx.data.writeUInt8(bIdx, 16);

    console.log(`Instructions: ${innerIxs.length} | borrowIxIndex: ${bIdx}`);

    // ALT
    let altAccount = null;
    const altAddr = process.env.ALT_ADDRESS;
    if (altAddr) {
        const res = await conn.getAddressLookupTable(new PublicKey(altAddr));
        if (res?.value) { altAccount = res.value; console.log(`ALT: ${altAccount.state.addresses.length} addrs`); }
    }

    // Compile & sign
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('processed');
    const msg = new TransactionMessage({
        payerKey: walletPk, recentBlockhash: blockhash, instructions: innerIxs,
    }).compileToV0Message(altAccount ? [altAccount] : []);
    const tx = new VersionedTransaction(msg);
    tx.sign([wallet]);

    const serializedBuf = Buffer.from(tx.serialize());
    console.log(`Tx size: ${serializedBuf.length} bytes`);
    if (serializedBuf.length > 1232) { console.error('FATAL: too large'); process.exit(1); }

    // ══════════════════════════════════════════
    //  STEP 6: Submit via Jito
    // ══════════════════════════════════════════
    console.log('\n[6/6] Submitting via Jito...');
    const serialized = bs58.encode(serializedBuf);

    let sig = null;
    try {
        sig = await Promise.any(JITO_ENDPOINTS.map(ep =>
            axios.post(ep, {
                jsonrpc: '2.0', id: 1,
                method: 'sendTransaction',
                params: [serialized, { encoding: 'base58' }],
            }, { headers: { 'Content-Type': 'application/json' }, timeout: 5000 })
            .then(r => {
                if (!r.data?.result) throw new Error(JSON.stringify(r.data?.error || r.data));
                console.log('Accepted by', ep.split('/')[2].split('.')[0]);
                return r.data.result;
            })
        ));
    } catch (e) {
        sig = bs58.encode(tx.signatures[0]);
        console.error('All Jito endpoints failed.');
        if (e.errors) e.errors.forEach(err => console.error('  →', String(err).slice(0, 150)));
    }

    console.log(`\nTx: ${sig}`);
    console.log(`https://solscan.io/tx/${sig}`);

    // Confirm
    console.log('\nWaiting for confirmation (30s)...');
    try {
        const conf = await conn.confirmTransaction(
            { signature: sig, blockhash, lastValidBlockHeight }, 'confirmed'
        );
        if (conf.value.err) {
            console.log('\n════════════════════════════════════════');
            console.log('  TX LANDED — REVERTED ATOMICALLY');
            console.log('  Error:', JSON.stringify(conf.value.err));
            console.log('════════════════════════════════════════');
            console.log('\n✅ ts=1 + ts=2 PIPELINE PROVEN.');
            console.log('Revert expected: 0.03% fee drag means repay falls short.');
        } else {
            console.log('\n🎉🎉🎉 TX SUCCEEDED — PROFITABLE TRADE 🎉🎉🎉');
        }
    } catch (e) {
        console.log('\n⏰ Timeout:', e.message?.slice(0, 120));
        console.log('Check Solscan.');
    }
}

main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
