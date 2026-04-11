"use strict";

const { PublicKey, TransactionInstruction } = require("@solana/web3.js");
const {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");

const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const SWAP_DISCRIMINATOR = Buffer.from("f8c69e91e17587c8", "hex");
const MIN_SQRT_PRICE_X64 = 4295048017n;
const MAX_SQRT_PRICE_X64 = 79226673515401279992447579055n;
const TICK_ARRAY_SIZE = 60;

function deriveTickArrayPDA(poolPubkey, startTickIndex) {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(startTickIndex);
    return PublicKey.findProgramAddressSync(
        [Buffer.from("tick_array"), poolPubkey.toBuffer(), buf],
        RAYDIUM_CLMM_PROGRAM_ID
    )[0];
}

function getStartTickIndex(tick, tickSpacing) {
    const ticksInArray = tickSpacing * TICK_ARRAY_SIZE;
    return Math.floor(tick / ticksInArray) * ticksInArray;
}

function getTickArrayStartIndices(tickCurrent, tickSpacing, aToB) {
    const ticksInArray = tickSpacing * TICK_ARRAY_SIZE;
    const startIdx = getStartTickIndex(tickCurrent, tickSpacing);
    if (aToB) {
        return [startIdx, startIdx - ticksInArray, startIdx - 2 * ticksInArray];
    } else {
        return [startIdx, startIdx + ticksInArray, startIdx + 2 * ticksInArray];
    }
}

function buildSwapData(amount, otherAmountThreshold, sqrtPriceLimit, isBaseInput) {
    const buf = Buffer.alloc(41);
    let offset = 0;
    SWAP_DISCRIMINATOR.copy(buf, offset); offset += 8;
    buf.writeBigUInt64LE(BigInt(amount), offset); offset += 8;
    buf.writeBigUInt64LE(BigInt(otherAmountThreshold), offset); offset += 8;
    const limit = BigInt(sqrtPriceLimit);
    buf.writeBigUInt64LE(limit & 0xFFFFFFFFFFFFFFFFn, offset);
    buf.writeBigUInt64LE((limit >> 64n) & 0xFFFFFFFFFFFFFFFFn, offset + 8);
    offset += 16;
    buf.writeUInt8(isBaseInput ? 1 : 0, offset);
    return buf;
}

function buildRaydiumSwapIx(opts) {
    const { poolAddress, poolState, walletPubkey, inputMint, amount, otherAmountThreshold, isBaseInput = true } = opts;
    if (!poolState.vaultA || !poolState.vaultB || !poolState.ammConfig || !poolState.observationKey) {
        throw new Error("Pool state missing required fields for Raydium builder");
    }
    if (!poolState.tickSpacing) {
        throw new Error("Pool state missing tickSpacing for Raydium builder");
    }
    const aToB = inputMint === poolState.mintA;
    if (!aToB && inputMint !== poolState.mintB) {
        throw new Error("inputMint " + inputMint + " does not match pool mints");
    }
    const poolPk = new PublicKey(poolAddress);
    const ammConfigPk = new PublicKey(poolState.ammConfig);
    const observationPk = new PublicKey(poolState.observationKey);
    const vaultAPk = new PublicKey(poolState.vaultA);
    const vaultBPk = new PublicKey(poolState.vaultB);
    const mintAPk = new PublicKey(poolState.mintA);
    const mintBPk = new PublicKey(poolState.mintB);
    const userAtaA = getAssociatedTokenAddressSync(mintAPk, walletPubkey);
    const userAtaB = getAssociatedTokenAddressSync(mintBPk, walletPubkey);
    const inputTokenAccount  = aToB ? userAtaA : userAtaB;
    const outputTokenAccount = aToB ? userAtaB : userAtaA;
    const inputVault  = aToB ? vaultAPk : vaultBPk;
    const outputVault = aToB ? vaultBPk : vaultAPk;
    const outputMintPk = aToB ? mintBPk : mintAPk;
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
        walletPubkey, aToB ? userAtaB : userAtaA, walletPubkey, outputMintPk
    );
    const startIndices = getTickArrayStartIndices(poolState.tickCurrent, poolState.tickSpacing, aToB);
    const tickArray0 = deriveTickArrayPDA(poolPk, startIndices[0]);
    const tickArray1 = deriveTickArrayPDA(poolPk, startIndices[1]);
    const tickArray2 = deriveTickArrayPDA(poolPk, startIndices[2]);
    const sqrtPriceLimit = aToB ? MIN_SQRT_PRICE_X64 : MAX_SQRT_PRICE_X64;
    const data = buildSwapData(amount, otherAmountThreshold, sqrtPriceLimit, isBaseInput);
    const keys = [
        { pubkey: walletPubkey,       isSigner: true,  isWritable: true  },
        { pubkey: ammConfigPk,        isSigner: false, isWritable: false },
        { pubkey: poolPk,             isSigner: false, isWritable: true  },
        { pubkey: inputTokenAccount,  isSigner: false, isWritable: true  },
        { pubkey: outputTokenAccount, isSigner: false, isWritable: true  },
        { pubkey: inputVault,         isSigner: false, isWritable: true  },
        { pubkey: outputVault,        isSigner: false, isWritable: true  },
        { pubkey: observationPk,      isSigner: false, isWritable: true  },
        { pubkey: TOKEN_PROGRAM_ID,   isSigner: false, isWritable: false },
        { pubkey: tickArray0,         isSigner: false, isWritable: true  },
        { pubkey: tickArray1,         isSigner: false, isWritable: true  },
        { pubkey: tickArray2,         isSigner: false, isWritable: true  },
    ];
    const swapIx = new TransactionInstruction({ programId: RAYDIUM_CLMM_PROGRAM_ID, keys, data });
    return { swapIx, ataIx, aToB };
}

module.exports = { buildRaydiumSwapIx, deriveTickArrayPDA, getStartTickIndex, getTickArrayStartIndices, RAYDIUM_CLMM_PROGRAM_ID };