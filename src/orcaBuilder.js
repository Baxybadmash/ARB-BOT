'use strict';

const { PublicKey, TransactionInstruction } = require('@solana/web3.js');
const {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');

// ── Orca Whirlpool program ──
const WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

// ── Swap discriminator (first 8 bytes of sha256("global:swap")) ──
const SWAP_DISCRIMINATOR = Buffer.from('f8c69e91e17587c8', 'hex');

// ── sqrt price limits (same as your localPools.js) ──
const MIN_SQRT_PRICE_X64 = 4295048017n;
const MAX_SQRT_PRICE_X64 = 79226673515401279992447579055n;

/**
 * Derive Orca tick array PDA for a given startTickIndex.
 * seeds = ["tick_array", whirlpool_pubkey, startTickIndex_as_i32_le_string]
 *
 * IMPORTANT: Orca uses the string representation of the i32, not raw bytes.
 */
function deriveTickArrayPDA(whirlpoolPubkey, startTickIndex) {
    return PublicKey.findProgramAddressSync(
        [
            Buffer.from('tick_array'),
            whirlpoolPubkey.toBuffer(),
            Buffer.from(startTickIndex.toString()),
        ],
        WHIRLPOOL_PROGRAM_ID
    )[0];
}

/**
 * Derive Orca oracle PDA.
 * seeds = ["oracle", whirlpool_pubkey]
 */
function deriveOraclePDA(whirlpoolPubkey) {
    return PublicKey.findProgramAddressSync(
        [
            Buffer.from('oracle'),
            whirlpoolPubkey.toBuffer(),
        ],
        WHIRLPOOL_PROGRAM_ID
    )[0];
}

/**
 * Calculate the startTickIndex for the tick array containing a given tick.
 * Formula: floor(tick / (tickSpacing * TICKS_PER_ARRAY)) * (tickSpacing * TICKS_PER_ARRAY)
 * 
 * CRITICAL: Must use floor-toward-negative-infinity, not truncation.
 * JavaScript Math.floor handles this correctly for negative numbers.
 */
const TICKS_PER_ARRAY = 88;

function getStartTickIndex(tick, tickSpacing) {
    const ticksInArray = tickSpacing * TICKS_PER_ARRAY;
    return Math.floor(tick / ticksInArray) * ticksInArray;
}

/**
 * Get the 3 tick array start indices needed for a swap.
 * For aToB (selling token A / buying token B): tick moves DOWN → current, current-1, current-2
 * For bToA (selling token B / buying token A): tick moves UP → current, current+1, current+2
 */
function getTickArrayStartIndices(tickCurrent, tickSpacing, aToB) {
    const ticksInArray = tickSpacing * TICKS_PER_ARRAY;
    const startIdx = getStartTickIndex(tickCurrent, tickSpacing);

    if (aToB) {
        // Price goes down → tick decreases → need arrays below
        return [startIdx, startIdx - ticksInArray, startIdx - 2 * ticksInArray];
    } else {
        // Price goes up → tick increases → need arrays above
        return [startIdx, startIdx + ticksInArray, startIdx + 2 * ticksInArray];
    }
}

/**
 * Build the 42-byte swap instruction data buffer.
 * Layout: discriminator(8) + amount(u64) + otherAmountThreshold(u64) + sqrtPriceLimit(u128) + amountSpecifiedIsInput(bool) + aToB(bool)
 */
function buildSwapData(amount, otherAmountThreshold, sqrtPriceLimit, amountSpecifiedIsInput, aToB) {
    const buf = Buffer.alloc(42);
    let offset = 0;

    // 8-byte discriminator
    SWAP_DISCRIMINATOR.copy(buf, offset);
    offset += 8;

    // amount: u64 LE
    buf.writeBigUInt64LE(BigInt(amount), offset);
    offset += 8;

    // otherAmountThreshold: u64 LE
    buf.writeBigUInt64LE(BigInt(otherAmountThreshold), offset);
    offset += 8;

    // sqrtPriceLimit: u128 LE (write as two u64 halves)
    const limit = BigInt(sqrtPriceLimit);
    buf.writeBigUInt64LE(limit & 0xFFFFFFFFFFFFFFFFn, offset);        // low 8 bytes
    buf.writeBigUInt64LE((limit >> 64n) & 0xFFFFFFFFFFFFFFFFn, offset + 8); // high 8 bytes
    offset += 16;

    // amountSpecifiedIsInput: bool (1 byte)
    buf.writeUInt8(amountSpecifiedIsInput ? 1 : 0, offset);
    offset += 1;

    // aToB: bool (1 byte)
    buf.writeUInt8(aToB ? 1 : 0, offset);

    return buf;
}

/**
 * Build an Orca Whirlpool swap TransactionInstruction.
 *
 * @param {object} opts
 * @param {string} opts.whirlpoolAddress  - Pool pubkey string
 * @param {object} opts.poolState         - Decoded pool state from localPools (must have sqrtPrice, tickCurrent, tickSpacing, mintA, mintB, vaultA, vaultB)
 * @param {PublicKey} opts.walletPubkey   - Signer/authority
 * @param {string} opts.inputMint        - Mint of token being sold
 * @param {bigint|string} opts.amount    - Amount to swap (in smallest units)
 * @param {bigint|string} opts.otherAmountThreshold - Min output (exactIn) or max input (exactOut)
 * @param {boolean} [opts.amountSpecifiedIsInput=true] - true for exact-in swaps
 *
 * @returns {{ swapIx: TransactionInstruction, ataIx: TransactionInstruction|null, aToB: boolean }}
 *   swapIx: the swap instruction
 *   ataIx:  createAssociatedTokenAccountIdempotent for the OUTPUT token (null if not needed — caller should check)
 *   aToB:   direction of the swap
 */
function buildOrcaSwapIx(opts) {
    const {
        whirlpoolAddress,
        poolState,
        walletPubkey,
        inputMint,
        amount,
        otherAmountThreshold,
        amountSpecifiedIsInput = true,
    } = opts;

    // ── Direction ──
    const aToB = inputMint === poolState.mintA;
    if (!aToB && inputMint !== poolState.mintB) {
        throw new Error(`inputMint ${inputMint} doesn't match pool mints (${poolState.mintA}, ${poolState.mintB})`);
    }

    // ── Pubkeys ──
    const whirlpoolPk = new PublicKey(whirlpoolAddress);
    const vaultA = new PublicKey(poolState.vaultA);
    const vaultB = new PublicKey(poolState.vaultB);
    const mintAPk = new PublicKey(poolState.mintA);
    const mintBPk = new PublicKey(poolState.mintB);

    // ── User ATAs ──
    const userAtaA = getAssociatedTokenAddressSync(mintAPk, walletPubkey);
    const userAtaB = getAssociatedTokenAddressSync(mintBPk, walletPubkey);

    // ── Output token ATA creation (idempotent — safe to include even if exists) ──
    const outputMintPk = aToB ? mintBPk : mintAPk;
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
        walletPubkey,   // payer
        aToB ? userAtaB : userAtaA,  // ata
        walletPubkey,   // owner
        outputMintPk,   // mint
    );

    // ── Oracle PDA ──
    const oraclePda = deriveOraclePDA(whirlpoolPk);

    // ── Tick array PDAs ──
    const startIndices = getTickArrayStartIndices(
        poolState.tickCurrent,
        poolState.tickSpacing,
        aToB
    );
    const tickArray0 = deriveTickArrayPDA(whirlpoolPk, startIndices[0]);
    const tickArray1 = deriveTickArrayPDA(whirlpoolPk, startIndices[1]);
    const tickArray2 = deriveTickArrayPDA(whirlpoolPk, startIndices[2]);

    // ── sqrt price limit ──
    // For aToB (price decreasing): use MIN as floor
    // For bToA (price increasing): use MAX as ceiling
    const sqrtPriceLimit = aToB ? MIN_SQRT_PRICE_X64 : MAX_SQRT_PRICE_X64;

    // ── Instruction data ──
    const data = buildSwapData(
        amount,
        otherAmountThreshold,
        sqrtPriceLimit,
        amountSpecifiedIsInput,
        aToB
    );

    // ── Account keys (11 accounts, exact order from Whirlpool IDL) ──
    const keys = [
        { pubkey: TOKEN_PROGRAM_ID,  isSigner: false, isWritable: false }, // 0: tokenProgram
        { pubkey: walletPubkey,      isSigner: true,  isWritable: false }, // 1: tokenAuthority (signer)
        { pubkey: whirlpoolPk,       isSigner: false, isWritable: true  }, // 2: whirlpool
        { pubkey: userAtaA,          isSigner: false, isWritable: true  }, // 3: tokenOwnerAccountA
        { pubkey: vaultA,            isSigner: false, isWritable: true  }, // 4: tokenVaultA
        { pubkey: userAtaB,          isSigner: false, isWritable: true  }, // 5: tokenOwnerAccountB
        { pubkey: vaultB,            isSigner: false, isWritable: true  }, // 6: tokenVaultB
        { pubkey: tickArray0,        isSigner: false, isWritable: true  }, // 7: tickArray0
        { pubkey: tickArray1,        isSigner: false, isWritable: true  }, // 8: tickArray1
        { pubkey: tickArray2,        isSigner: false, isWritable: true  }, // 9: tickArray2
        { pubkey: oraclePda,         isSigner: false, isWritable: false }, // 10: oracle (non-AdaptiveFee pool)
    ];

    const swapIx = new TransactionInstruction({
        programId: WHIRLPOOL_PROGRAM_ID,
        keys,
        data,
    });

    return { swapIx, ataIx, aToB };
}

module.exports = {
    buildOrcaSwapIx,
    deriveTickArrayPDA,
    deriveOraclePDA,
    getStartTickIndex,
    getTickArrayStartIndices,
    WHIRLPOOL_PROGRAM_ID,
};
