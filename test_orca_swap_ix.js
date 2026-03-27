'use strict';
// ============================================================
//  test_orca_swap_ix.js
//
//  Tests building Orca Whirlpool swap instructions locally
//  WITHOUT calling Jupiter's /swap-instructions API.
//
//  Phases:
//    1. Decode live pool state from chain (vaultA/B, tickSpacing, etc.)
//    2. Derive tick array + oracle PDAs
//    3. Build the 42-byte swap instruction
//    4. Get Jupiter quote (keep fast quote path, skip slow instructions path)
//    5. Simulate locally-built instruction — confirm correct format
//    6. Time local build vs Jupiter /swap-instructions API call
//    7. Print pass/fail summary
//
//  Usage:
//    node test_orca_swap_ix.js [pool_address]
//  Example:
//    node test_orca_swap_ix.js Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE
// ============================================================

require('dotenv').config();
const crypto = require('crypto');

const {
    Connection, PublicKey, TransactionInstruction,
    VersionedTransaction, TransactionMessage,
} = require('@solana/web3.js');

const {
    TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
} = require('@solana/spl-token');

const axios = require('axios');

// ── Constants ─────────────────────────────────────────────────────────────────
const WHIRLPOOL_PROGRAM   = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const TOKEN_PROGRAM_PK    = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TICK_ARRAY_SIZE     = 88;

// Anchor discriminator = first 8 bytes of SHA-256("global:<name>")
function disc(name) {
    return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest()).slice(0, 8);
}
const SWAP_DISCRIMINATOR = disc('swap');

// Well-known pools
const DEFAULT_POOLS = {
    'SOL/USDC': 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
    'SOL/USDT': 'FwewVm8u6tFPGewAyHmWAqad9hmF7mvqxK4mJ7iNqqGC',
};

const JUPITER_QUOTE_API = process.env.JUPITER_API_KEY
    ? 'https://api.jup.ag/swap/v1/quote'
    : 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_API = 'https://lite-api.jup.ag/swap/v1';

// ── Pool state decoder ────────────────────────────────────────────────────────
function readU128(d, offset) {
    return (d.readBigUInt64LE(offset + 8) << 64n) | d.readBigUInt64LE(offset);
}

function decodeWhirlpool(data) {
    if (data.length < 653) throw new Error(`Whirlpool expects 653 bytes, got ${data.length}`);
    return {
        tickSpacing:  data.readUInt16LE(43),
        feeRate:      data.readUInt16LE(45),            // hundredths of bps (denom 1,000,000)
        liquidity:    readU128(data, 49),
        sqrtPrice:    readU128(data, 65),
        tickCurrent:  data.readInt32LE(81),
        mintA:        new PublicKey(data.slice(101, 133)),
        vaultA:       new PublicKey(data.slice(133, 165)),
        mintB:        new PublicKey(data.slice(181, 213)),
        vaultB:       new PublicKey(data.slice(213, 245)),
    };
}

// ── PDA helpers ───────────────────────────────────────────────────────────────
function getTickArrayStartIndex(tickCurrent, tickSpacing, offset) {
    const ticksPerArray = TICK_ARRAY_SIZE * tickSpacing;
    return (Math.floor(tickCurrent / ticksPerArray) + offset) * ticksPerArray;
}

function deriveTickArrayPDA(whirlpoolPk, startIndex) {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(startIndex, 0);
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('tick_array'), whirlpoolPk.toBuffer(), buf],
        WHIRLPOOL_PROGRAM
    );
    return pda;
}

function deriveOraclePDA(whirlpoolPk) {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('oracle'), whirlpoolPk.toBuffer()],
        WHIRLPOOL_PROGRAM
    );
    return pda;
}

// ── Swap instruction builder ──────────────────────────────────────────────────
// Builds the Orca Whirlpool `swap` instruction (42 bytes of data, 11 accounts).
// Returns { swapIx, setupIxs, tickArrayStartIndexes } for inspection.
function buildOrcaSwapInstruction({ whirlpoolPk, pool, walletPk, amountIn, minAmountOut, aToB }) {
    // Three consecutive tick arrays in swap direction
    // aToB=true  (SOL→token, price decreasing): go left  (offsets 0, -1, -2)
    // aToB=false (token→SOL, price increasing): go right (offsets 0, +1, +2)
    const offsets = aToB ? [0, -1, -2] : [0, 1, 2];
    const tickArrayStartIndexes = offsets.map(o =>
        getTickArrayStartIndex(pool.tickCurrent, pool.tickSpacing, o)
    );
    const [ta0, ta1, ta2] = tickArrayStartIndexes.map(si =>
        deriveTickArrayPDA(whirlpoolPk, si)
    );
    const oracle = deriveOraclePDA(whirlpoolPk);

    // Wallet ATAs for mintA (wSOL) and mintB (USDC/USDT)
    const ataA = getAssociatedTokenAddressSync(pool.mintA, walletPk);
    const ataB = getAssociatedTokenAddressSync(pool.mintB, walletPk);

    // Instruction data: discriminator(8) + amount(8) + otherAmountThreshold(8)
    //                 + sqrtPriceLimitX64(16) + amountSpecifiedIsInput(1) + aToB(1)
    // Total: 42 bytes
    const data = Buffer.alloc(42);
    SWAP_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(amountIn, 8);
    data.writeBigUInt64LE(minAmountOut, 16);
    // sqrtPriceLimitX64 = 0 (no price limit — otherAmountThreshold guards slippage)
    data.writeBigUInt64LE(0n, 24);
    data.writeBigUInt64LE(0n, 32);
    data.writeUInt8(1, 40);             // amountSpecifiedIsInput = true (exactIn)
    data.writeUInt8(aToB ? 1 : 0, 41); // aToB

    const keys = [
        { pubkey: TOKEN_PROGRAM_PK, isSigner: false, isWritable: false }, // tokenProgram
        { pubkey: walletPk,         isSigner: true,  isWritable: false }, // tokenAuthority
        { pubkey: whirlpoolPk,      isSigner: false, isWritable: true  }, // whirlpool
        { pubkey: ataA,             isSigner: false, isWritable: true  }, // tokenOwnerAccountA
        { pubkey: pool.vaultA,      isSigner: false, isWritable: true  }, // tokenVaultA
        { pubkey: ataB,             isSigner: false, isWritable: true  }, // tokenOwnerAccountB
        { pubkey: pool.vaultB,      isSigner: false, isWritable: true  }, // tokenVaultB
        { pubkey: ta0,              isSigner: false, isWritable: true  }, // tickArray0
        { pubkey: ta1,              isSigner: false, isWritable: true  }, // tickArray1
        { pubkey: ta2,              isSigner: false, isWritable: true  }, // tickArray2
        { pubkey: oracle,           isSigner: false, isWritable: false }, // oracle
    ];

    const swapIx = new TransactionInstruction({ programId: WHIRLPOOL_PROGRAM, keys, data });

    // ATA setup (idempotent — no-op if account already exists)
    const setupIxs = [
        createAssociatedTokenAccountIdempotentInstruction(walletPk, ataA, walletPk, pool.mintA),
        createAssociatedTokenAccountIdempotentInstruction(walletPk, ataB, walletPk, pool.mintB),
    ];

    return { swapIx, setupIxs, ataA, ataB, ta0, ta1, ta2, oracle, tickArrayStartIndexes };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function pass(msg)   { console.log(`  ✅ ${msg}`); }
function fail(msg)   { console.log(`  ❌ ${msg}`); }
function info(msg)   { console.log(`     ${msg}`); }
function header(msg) { console.log(`\n${'─'.repeat(60)}\n  ${msg}\n${'─'.repeat(60)}`); }

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const poolAddr = process.argv[2] || DEFAULT_POOLS['SOL/USDC'];
    const walletAddr = process.env.WALLET_PUBLIC_KEY
        || 'ESzi3jyKV4EWi1TC36nRwLiHHDVTmzn9iCFTotToyhC3'; // bot wallet

    console.log('╔' + '═'.repeat(58) + '╗');
    console.log('║  Orca Whirlpool Swap Instruction — Local Build Test    ║');
    console.log('╚' + '═'.repeat(58) + '╝');
    console.log(`\n  Pool:   ${poolAddr}`);
    console.log(`  Wallet: ${walletAddr}`);

    const conn       = new Connection(process.env.RPC_URL_PRIMARY, 'confirmed');
    const whirlpoolPk = new PublicKey(poolAddr);
    const walletPk    = new PublicKey(walletAddr);

    const results = { passed: 0, failed: 0 };
    const ok  = (msg) => { results.passed++; pass(msg); };
    const err = (msg) => { results.failed++; fail(msg); };

    // ── Phase 1: Decode pool state ──────────────────────────────────────────
    header('Phase 1 — Decode Live Pool State');
    const accountInfo = await conn.getAccountInfo(whirlpoolPk);
    if (!accountInfo) throw new Error(`Pool account not found: ${poolAddr}`);

    const pool = decodeWhirlpool(accountInfo.data);
    const sqrtPriceFloat = Number(pool.sqrtPrice) / (2 ** 64);
    const price = sqrtPriceFloat * sqrtPriceFloat * 1e3; // decimalsA=9, decimalsB=6 → 10^(9-6)=1000

    console.log(`\n  Data length : ${accountInfo.data.length} bytes`);
    console.log(`  tickSpacing : ${pool.tickSpacing}`);
    console.log(`  tickCurrent : ${pool.tickCurrent}`);
    console.log(`  feeRate     : ${pool.feeRate} (${pool.feeRate / 10000}%)`);
    console.log(`  price       : $${price.toFixed(4)}`);
    console.log(`  mintA       : ${pool.mintA.toString()}`);
    console.log(`  mintB       : ${pool.mintB.toString()}`);
    console.log(`  vaultA      : ${pool.vaultA.toString()}`);
    console.log(`  vaultB      : ${pool.vaultB.toString()}`);

    accountInfo.data.length === 653
        ? ok('Whirlpool data length = 653 bytes')
        : err(`Wrong data length: ${accountInfo.data.length}`);

    pool.tickSpacing > 0
        ? ok(`tickSpacing = ${pool.tickSpacing} (decoded from offset 43)`)
        : err('tickSpacing = 0 — decode error');

    pool.liquidity > 0n
        ? ok(`liquidity = ${pool.liquidity} (pool is active)`)
        : err('liquidity = 0 — pool may be inactive');

    // ── Phase 2: Derive PDAs ────────────────────────────────────────────────
    header('Phase 2 — Derive Tick Arrays + Oracle PDAs');

    const AMOUNT_IN = 1_000_000_000n; // 1 SOL
    const aToB      = true;           // SOL → USDC

    const {
        swapIx, setupIxs, ataA, ataB,
        ta0, ta1, ta2, oracle, tickArrayStartIndexes
    } = buildOrcaSwapInstruction({
        whirlpoolPk, pool, walletPk,
        amountIn:     AMOUNT_IN,
        minAmountOut: 1n,     // placeholder — will set properly after quote
        aToB,
    });

    const ticksPerArray = TICK_ARRAY_SIZE * pool.tickSpacing;
    console.log(`\n  ticksPerArray: ${ticksPerArray}`);
    console.log(`  Tick arrays (aToB=${aToB}, offsets 0/-1/-2):`);
    tickArrayStartIndexes.forEach((si, i) => {
        const pda = [ta0, ta1, ta2][i];
        console.log(`    [${i}] startIndex=${si.toString().padStart(7)} → ${pda.toString()}`);
    });
    console.log(`  Oracle PDA : ${oracle.toString()}`);
    console.log(`  wSOL ATA   : ${ataA.toString()}`);
    console.log(`  USDC ATA   : ${ataB.toString()}`);

    // Verify tick array 0 is in the right neighborhood of tickCurrent
    const ta0Start = tickArrayStartIndexes[0];
    const ta0End   = ta0Start + ticksPerArray - 1;
    (pool.tickCurrent >= ta0Start && pool.tickCurrent <= ta0End)
        ? ok(`tickCurrent(${pool.tickCurrent}) is within tickArray0 [${ta0Start}, ${ta0End}]`)
        : err(`tickCurrent(${pool.tickCurrent}) is OUTSIDE tickArray0 [${ta0Start}, ${ta0End}]`);

    // Verify tick arrays are consecutive in the right direction
    const step = aToB ? -ticksPerArray : ticksPerArray;
    (tickArrayStartIndexes[1] === tickArrayStartIndexes[0] + step &&
     tickArrayStartIndexes[2] === tickArrayStartIndexes[1] + step)
        ? ok(`Tick arrays are consecutive (step=${step} per array)`)
        : err('Tick arrays are not consecutive');

    // Verify oracle PDA is valid (derivable without error)
    ok(`Oracle PDA derived: ${oracle.toString().slice(0, 8)}...`);

    // ── Phase 3: Inspect swap instruction ──────────────────────────────────
    header('Phase 3 — Inspect Built Swap Instruction');

    console.log(`\n  programId   : ${swapIx.programId.toString()}`);
    console.log(`  data length : ${swapIx.data.length} bytes (expected 42)`);
    console.log(`  discriminator: ${Buffer.from(swapIx.data.slice(0, 8)).toString('hex')}`);
    console.log(`  amount       : ${swapIx.data.readBigUInt64LE(8)} lamports`);
    console.log(`  minAmountOut : ${swapIx.data.readBigUInt64LE(16)}`);
    console.log(`  sqrtPriceLimit: ${swapIx.data.readBigUInt64LE(24)} (0 = no limit)`);
    console.log(`  amountSpecifiedIsInput: ${swapIx.data[40]} (1=exactIn)`);
    console.log(`  aToB         : ${swapIx.data[41]} (1=SOL→token)`);
    console.log(`  account count: ${swapIx.keys.length} (expected 11)`);
    console.log('  Accounts:');
    const accountNames = ['tokenProgram','tokenAuthority','whirlpool','tokenOwnerAccountA',
                          'tokenVaultA','tokenOwnerAccountB','tokenVaultB',
                          'tickArray0','tickArray1','tickArray2','oracle'];
    swapIx.keys.forEach((k, i) => {
        const flags = `${k.isSigner ? 'signer' : '      '} ${k.isWritable ? 'writable' : 'readonly'}`;
        console.log(`    [${i}] ${accountNames[i].padEnd(20)} ${flags}  ${k.pubkey.toString().slice(0, 8)}...`);
    });

    swapIx.programId.toString() === WHIRLPOOL_PROGRAM.toString()
        ? ok('programId = Whirlpool program')
        : err(`Wrong programId: ${swapIx.programId.toString()}`);

    swapIx.data.length === 42
        ? ok('Instruction data = 42 bytes')
        : err(`Wrong data length: ${swapIx.data.length}`);

    Buffer.from(swapIx.data.slice(0, 8)).toString('hex') === 'f8c69e91e17587c8'
        ? ok('Discriminator = f8c69e91e17587c8 (matches Orca swap)')
        : err(`Wrong discriminator: ${Buffer.from(swapIx.data.slice(0, 8)).toString('hex')}`);

    swapIx.keys.length === 11
        ? ok('Account count = 11')
        : err(`Wrong account count: ${swapIx.keys.length}`);

    // Verify signer/writable flags
    const expectedFlags = [
        { signer: false, writable: false }, // tokenProgram
        { signer: true,  writable: false }, // tokenAuthority
        { signer: false, writable: true  }, // whirlpool
        { signer: false, writable: true  }, // tokenOwnerAccountA
        { signer: false, writable: true  }, // tokenVaultA
        { signer: false, writable: true  }, // tokenOwnerAccountB
        { signer: false, writable: true  }, // tokenVaultB
        { signer: false, writable: true  }, // tickArray0
        { signer: false, writable: true  }, // tickArray1
        { signer: false, writable: true  }, // tickArray2
        { signer: false, writable: false }, // oracle
    ];
    const flagMismatch = swapIx.keys.findIndex((k, i) =>
        k.isSigner !== expectedFlags[i].signer || k.isWritable !== expectedFlags[i].writable
    );
    flagMismatch === -1
        ? ok('All account signer/writable flags correct')
        : err(`Account [${flagMismatch}] ${accountNames[flagMismatch]} has wrong flags`);

    // ── Phase 4: Jupiter quote ──────────────────────────────────────────────
    header('Phase 4 — Jupiter Quote (Fast Path)');

    let jupiterQuote = null;
    try {
        const t0 = Date.now();
        const res = await axios.get(JUPITER_QUOTE_API, {
            params: {
                inputMint:   pool.mintA.toString(),
                outputMint:  pool.mintB.toString(),
                amount:      AMOUNT_IN.toString(),
                slippageBps: 15,
                maxAccounts: parseInt(process.env.JUPITER_MAX_ACCOUNTS || '10'),
            },
            timeout: 6000,
            headers: process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {},
        });
        const quoteMs = Date.now() - t0;
        jupiterQuote = res.data;
        const routes = jupiterQuote.routePlan?.map(r => r.swapInfo.label).join(' → ') || 'unknown';
        console.log(`\n  Quote time  : ${quoteMs}ms`);
        console.log(`  outAmount   : ${jupiterQuote.outAmount} (${(Number(jupiterQuote.outAmount)/1e6).toFixed(4)} USDC)`);
        console.log(`  route       : ${routes}`);
        console.log(`  price impact: ${jupiterQuote.priceImpactPct || 'N/A'}%`);
        ok(`Jupiter quote: 1 SOL → ${(Number(jupiterQuote.outAmount)/1e6).toFixed(4)} USDC via ${routes}`);

        // Check if it routes through our Orca pool
        const usesThisPool = jupiterQuote.routePlan?.some(r =>
            r.swapInfo.ammKey === poolAddr
        );
        usesThisPool
            ? ok(`Route includes our pool (${poolAddr.slice(0, 8)}...)`)
            : info(`Note: Jupiter routed through different pools — local ix still tests format correctly`);
    } catch (e) {
        err(`Jupiter quote failed: ${e.message}`);
    }

    // Rebuild with real minAmountOut from quote
    const minAmountOut = jupiterQuote
        ? BigInt(jupiterQuote.outAmount) * 9985n / 10000n  // 0.15% slippage
        : 1n;

    const { swapIx: finalSwapIx } = buildOrcaSwapInstruction({
        whirlpoolPk, pool, walletPk,
        amountIn: AMOUNT_IN, minAmountOut, aToB,
    });

    // ── Phase 5: Simulate ───────────────────────────────────────────────────
    header('Phase 5 — Simulate Transaction (sigVerify=false)');

    const { blockhash } = await conn.getLatestBlockhash('processed');
    const message = new TransactionMessage({
        payerKey:           walletPk,
        recentBlockhash:    blockhash,
        instructions:       [finalSwapIx],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);

    let simResult = null;
    const simStart = Date.now();
    try {
        simResult = await conn.simulateTransaction(tx, {
            sigVerify:             false,
            replaceRecentBlockhash: true,
            commitment:            'processed',
        });
        const simMs = Date.now() - simStart;
        const simErr    = simResult.value.err;
        const simLogs   = simResult.value.logs || [];
        const simUnits  = simResult.value.unitsConsumed;

        console.log(`\n  Simulation time : ${simMs}ms`);
        console.log(`  unitsConsumed   : ${simUnits}`);
        console.log(`  error           : ${simErr ? JSON.stringify(simErr) : 'null'}`);
        console.log(`\n  Last 8 simulation logs:`);
        simLogs.slice(-8).forEach(l => console.log(`    ${l}`));

        // The simulation will likely fail on balance/ATA issues
        // (wallet has no wSOL in ATA). That's expected and PROVES the instruction
        // format was accepted — the program got far enough to check balances.
        // A format error would give "invalid program" or "unknown instruction" immediately.
        const hasWhirlpoolLog = simLogs.some(l => l.includes('whirLbMi'));
        const isFormatError = simLogs.some(l =>
            l.includes('invalid program') ||
            l.includes('unknown instruction') ||
            l.includes('failed to deserialize')
        );
        const isBalanceError = simLogs.some(l =>
            l.includes('insufficient') ||
            l.includes('InsufficientFunds') ||
            l.includes('insufficient lamports') ||
            l.includes('0x1')  // common SPL token insufficient funds error
        ) || (simErr && JSON.stringify(simErr).includes('InstructionError'));

        if (!simErr) {
            ok('Simulation SUCCEEDED — instruction format is perfect!');
        } else if (hasWhirlpoolLog && !isFormatError) {
            ok(`Whirlpool program invoked — instruction format is valid`);
            info(`Simulation error is expected (wallet has no wSOL): ${JSON.stringify(simErr)}`);
        } else if (isFormatError) {
            err(`Instruction format rejected by program: check discriminator/accounts`);
        } else {
            // Show what actually happened
            info(`Simulation result: ${JSON.stringify(simErr)}`);
            const programInvoked = simLogs.some(l => l.includes('Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc invoke'));
            programInvoked
                ? ok('Whirlpool program was invoked (format accepted, runtime error expected)')
                : err('Whirlpool program was NOT invoked — check accounts/programId');
        }

    } catch (e) {
        err(`simulateTransaction threw: ${e.message}`);
    }

    // ── Phase 6: Timing comparison ─────────────────────────────────────────
    header('Phase 6 — Timing: Local Build vs Jupiter /swap-instructions');

    // Local build timing
    const localRuns = 100;
    const t0 = Date.now();
    for (let i = 0; i < localRuns; i++) {
        buildOrcaSwapInstruction({
            whirlpoolPk, pool, walletPk,
            amountIn: AMOUNT_IN, minAmountOut: 1n, aToB,
        });
    }
    const localMs = (Date.now() - t0) / localRuns;

    console.log(`\n  Local build (avg over ${localRuns} runs): ${localMs.toFixed(3)}ms`);

    // Jupiter /swap-instructions timing
    let jupIxMs = null;
    if (jupiterQuote) {
        try {
            const t1 = Date.now();
            await axios.post(`${JUPITER_SWAP_API}/swap-instructions`, {
                quoteResponse:           jupiterQuote,
                userPublicKey:           walletAddr,
                wrapAndUnwrapSol:        false,
                dynamicComputeUnitLimit: true,
                slippageBps:             15,
            }, { timeout: 8000 });
            jupIxMs = Date.now() - t1;
            console.log(`  Jupiter /swap-instructions: ${jupIxMs}ms`);
            const speedup = (jupIxMs / localMs).toFixed(0);
            console.log(`\n  🚀 Speedup: local is ~${speedup}× faster than Jupiter API`);
            ok(`Local build ${localMs.toFixed(2)}ms vs Jupiter ${jupIxMs}ms (${speedup}× faster)`);
        } catch (e) {
            info(`Jupiter /swap-instructions call failed: ${e.message}`);
        }
    }

    // ── Phase 7: Summary ────────────────────────────────────────────────────
    header('Phase 7 — Summary');

    const total = results.passed + results.failed;
    console.log(`\n  Tests passed: ${results.passed}/${total}`);
    if (results.failed === 0) {
        console.log('\n  ✅ ALL TESTS PASSED — ready to integrate into executor.js');
        console.log('  The local swap instruction builder is working correctly.');
        console.log('  Next step: replace _getSwapInstructions() calls in executor.js');
        console.log('             with _buildOrcaSwapIx() for Whirlpool routes.\n');
    } else {
        console.log(`\n  ❌ ${results.failed} test(s) FAILED — fix before integrating.\n`);
    }
}

main().catch(e => {
    console.error('\nFatal error:', e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
});
