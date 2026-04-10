// src/executor.js
const bs58 = require('bs58');
// ============================================================
//  MARGINFI FLASHLOAN ARB EXECUTOR
//
//  Atomic transaction layout:
//    beginFlashLoan (MarginFi)
//    lendingAccountBorrow  ← borrows X SOL from MarginFi bank
//    [compute budget ixs]
//    [setup ixs from Jupiter buy]
//    swapInstruction (buy tokenB cheap on DEX A)
//    swapInstruction (sell tokenB dear on DEX B)
//    lendingAccountRepay   ← repays X SOL (0% fee — confirmed: docs.marginfi.com/faqs)
//    endFlashLoan (MarginFi)
//
//  No wallet capital required — the borrow funds the swap.
// ============================================================
const { MarginfiClient, MarginfiAccountWrapper, getConfig } = require('@mrgnlabs/marginfi-client-v2');
const { NodeWallet }      = require('@mrgnlabs/mrgn-common');
const { Connection, PublicKey, TransactionInstruction, SystemProgram } = require('@solana/web3.js');
const axios        = require('axios');
const fs           = require('fs');
const { getSolPrice } = require('./price');
const path   = require('path');
const logger = require('./logger');
const discord  = require('./discord');

// -------------------------------------------------------
//  CONSTANTS
// -------------------------------------------------------
// Instruction discriminators for patching cached instruction templates
const BORROW_DISCRIMINATOR = Buffer.from([0x04, 0x7e, 0x74, 0x35, 0x30, 0x05, 0xd4, 0x1f]); // lendingAccountBorrow
const REPAY_DISCRIMINATOR  = Buffer.from([0x4f, 0xd1, 0xac, 0xb1, 0xde, 0x33, 0xad, 0x97]); // lendingAccountRepay
// swap-instructions endpoint rejects API key with 401 — use lite-api directly
const JUPITER_SWAP_API  = 'https://lite-api.jup.ag/swap/v1';

// Vote program ID — used to filter vote accounts from ALTs (Jito rejects bundles that lock vote accounts)
const VOTE_PROGRAM_ID = 'Vote111111111111111111111111111111111111111';

// Persistent cache: pubkey → true (vote) | false (not vote). Vote status is permanent — no TTL needed.
const _voteAccountCache = new Map();

// Jito tip accounts — one is picked per bundle submission
// Source: https://jito-labs.gitbook.io/mev/searcher-resources/bundles
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

// MarginFi production SOL bank
// Source: https://storage.googleapis.com/mrgn-public/mrgn-bank-metadata-cache.json
const SOL_BANK_PK       = new PublicKey('CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh');

// MarginFi flashloans are free — no fee (confirmed: docs.marginfi.com/faqs)
const FLASHLOAN_FEE_BPS = 0n;

const DATA_DIR          = path.join(__dirname, '..', 'data');

// -------------------------------------------------------
//  KAMINO FLASHLOAN CONSTANTS
// -------------------------------------------------------
const KAMINO_PROGRAM_ID   = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const KAMINO_MARKET       = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
const KAMINO_MARKET_AUTH  = new PublicKey('9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo');
const KAMINO_SOL_RESERVE  = new PublicKey('d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q');
const KAMINO_SOL_VAULT    = new PublicKey('GafNuUXj9rxGLn4y79dPu6MHSuPWeJR6UtTWuexpGh3U');
const KAMINO_FEE_RECEIVER = new PublicKey('3JNof8s453bwG5UqiXBLJc77NRQXezYYEBbk3fqnoKph');
const KAMINO_FLASH_BORROW_DISC = Buffer.from([135, 231, 52, 167, 7, 52, 212, 193]);
const KAMINO_FLASH_REPAY_DISC  = Buffer.from([185, 117, 0, 203, 96, 245, 180, 186]);
const SOL_MINT            = new PublicKey('So11111111111111111111111111111111111111112');
const TOKEN_PROGRAM       = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const MFI_ACCOUNT_FILE  = path.join(DATA_DIR, 'marginfi_account.json');
const LUT_CACHE_TTL_MS  = 30 * 60 * 1000; // LUTs are immutable on-chain — 30-min TTL is safe

// -------------------------------------------------------
class Executor {
    constructor(connection, wallet, config = {}) {
        this.connection = connection;   // Helius — for tx submission
        this.wallet     = wallet;
        this.config     = config;
        this.mfiClient  = null;
        this.mfiAccount = null;
        this.stats = {
            slotsScanned:  0,
            oppsDetected:  0,  // scanner found a spread (any size)
            oppsAttempted: 0,  // passed profitability check, tx built
            txSent:        0,
            txSuccess:     0,
            totalProfit:   0n,
        };
        this._lutCache     = new Map(); // key: sorted LUT addrs, value: { tables, cachedAt }
        this._blockhashCache = null;    // { blockhash, lastValidBlockHeight } — refreshed every 200ms
    }

    // -------------------------------------------------------
    //  INIT — call once before bot loop starts
    // -------------------------------------------------------
    async init() {
        logger.info('[Executor] Initializing MarginFi flashloan client...');

        // Use Shyft RPC for MarginFi data fetching — Helius blocks bulk getAccountInfo
        // on free tier; Shyft blocks getProgramAccounts but not getMultipleAccountInfos.
        // Providing preloadedBankAddresses skips getProgramAccounts entirely.
        const mfiConn = new Connection(
            process.env.RPC_URL_SECONDARY || process.env.RPC_URL_PRIMARY,
            { commitment: 'confirmed', disableRetryOnRateLimit: true }
        );

        // ---- 429 circuit breaker for MarginFi's Shyft connection ----
        {
            const MAX_CONCURRENT = 3;
            const MIN_SPACING_MS = 100;
            let inFlight = 0;
            let lastCall = 0;
            const origRpc = mfiConn._rpcRequest.bind(mfiConn);

            mfiConn._rpcRequest = async function throttledRpc(method, args) {
                const now = Date.now();
                const wait = MIN_SPACING_MS - (now - lastCall);
                if (wait > 0) await new Promise(r => setTimeout(r, wait));

                while (inFlight >= MAX_CONCURRENT) {
                    await new Promise(r => setTimeout(r, 50));
                }

                inFlight++;
                lastCall = Date.now();
                try {
                    return await origRpc(method, args);
                } finally {
                    inFlight--;
                }
            };
            logger.info('[Executor] 429 circuit breaker installed on MarginFi connection');
        }
        const nodeWallet = new NodeWallet(this.wallet);
        const mfiConfig  = getConfig('production');

        this.mfiClient = await MarginfiClient.fetch(mfiConfig, nodeWallet, mfiConn, {
            preloadedBankAddresses: [SOL_BANK_PK],
        });

        logger.info(`[Executor] MarginFi loaded. Banks: ${this.mfiClient.banks.size}`);

        await this._loadOrCreateAccount();

        logger.info(`[Executor] MarginFi account: ${this.mfiAccount.address.toString()}`);
        logger.info('[Executor] ✅ Flash loan ready (all MarginFi accounts support flashloans)');

        // Pre-compute Anchor account overrides so makeBorrowIx/makeRepayIx never
        // trigger Anchor v0.30 account resolution (which makes RPC calls per trade).
        // authority, group, and liquidityVault are all static — safe to cache forever.
        const solBank = this.mfiClient.banks.get(SOL_BANK_PK.toBase58());
        this._mfiOpts = {
            overrideInferAccounts: {
                authority:      this.wallet.publicKey,
                group:          this.mfiClient.config.groupPk,
                liquidityVault: solBank?.liquidityVault,
            },
        };
        logger.info(`[Executor] MFI account overrides cached (group: ${this.mfiClient.config.groupPk.toString().slice(0, 8)}...)`);

        // Pre-build borrow/repay instruction templates once — avoids Anchor's
        // _accountsResolver.resolve() (~200ms RPC call) on every trade.
        // Per trade we only patch the 8-byte amount field in-place (pure CPU).
        const [borrowTemplate, repayTemplate] = await Promise.all([
            this.mfiAccount.makeBorrowIx(10, SOL_BANK_PK, this._mfiOpts),
            this.mfiAccount.makeRepayIx(10, SOL_BANK_PK, true, this._mfiOpts),
        ]);
        // Remove CloseAccount (data[0]=9) from borrow — it destroys the WSOL ATA before Jupiter can use it
        this._borrowIxTemplate = borrowTemplate.instructions.filter(ix => !(ix.data.length <= 4 && ix.data[0] === 9)).map(ix => ({
            programId: ix.programId, keys: ix.keys, data: Buffer.from(ix.data),
        }));
        this._repayIxTemplate = repayTemplate.instructions.map(ix => ({
            programId: ix.programId, keys: ix.keys, data: Buffer.from(ix.data),
        }));
        logger.info('[Executor] MFI instruction templates cached ✅');

        await this._initKamino();
        this._startBlockhashCache();
    }

    // -------------------------------------------------------
    //  BLOCKHASH CACHE — refreshes every 500ms in background
    //  Eliminates the ~75ms getLatestBlockhash call from the
    //  critical path on every trade.
    // -------------------------------------------------------
    _startBlockhashCache() {
        const refresh = async () => {
            try {
                this._blockhashCache = await this.connection.getLatestBlockhash('processed');
            } catch (e) {
                logger.debug(`[Executor] Blockhash refresh failed: ${e.message}`);
            }
        };
        refresh(); // warm up immediately
        setInterval(refresh, 200);
        logger.info('[Executor] Blockhash cache started (refresh every 200ms) ✅');
    }

    // -------------------------------------------------------
    //  BUILD MFI BORROW/REPAY INSTRUCTIONS  (CPU only — no RPC)
    //  Clones the startup-cached templates and patches only the
    //  amount bytes.  Discriminator offsets verified empirically:
    //    lendingAccountBorrow data: [discriminator(8) | amount u64 LE(8)]
    //    lendingAccountRepay  data: [discriminator(8) | amount u64 LE(8) | repayAll(2)]
    //    SystemProgram.transfer   data: [type u32 LE(4) | amount+10000 u64 LE(8)]
    // -------------------------------------------------------

    // -------------------------------------------------------
    //  KAMINO FLASHLOAN — init (run once at startup)
    // -------------------------------------------------------
    async _initKamino() {
        logger.info('[Executor] Initializing Kamino flashloan templates...');
        const walletPk = this.wallet.publicKey;

        // WSOL ATA for this wallet
        const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
        const wsolAta = getAssociatedTokenAddressSync(SOL_MINT, walletPk);
        this._kaminoWsolAta = wsolAta;

        // Build borrow instruction data: discriminator(8) + liquidityAmount u64 LE(8)
        const borrowData = Buffer.alloc(16);
        KAMINO_FLASH_BORROW_DISC.copy(borrowData, 0);
        borrowData.writeBigUInt64LE(1000000000n, 8); // placeholder 1 SOL

        // Build repay instruction data: discriminator(8) + liquidityAmount u64 LE(8) + borrowInstructionIndex u8(1)
        const repayData = Buffer.alloc(17);
        KAMINO_FLASH_REPAY_DISC.copy(repayData, 0);
        repayData.writeBigUInt64LE(1000010000n, 8); // placeholder 1 SOL + fee
        repayData.writeUInt8(0, 16);                // borrowInstructionIndex — patched per trade

        const borrowAccounts = [
            { pubkey: walletPk,            isSigner: true,  isWritable: false }, // userTransferAuthority
            { pubkey: KAMINO_MARKET_AUTH,  isSigner: false, isWritable: false }, // lendingMarketAuthority
            { pubkey: KAMINO_MARKET,       isSigner: false, isWritable: false }, // lendingMarket
            { pubkey: KAMINO_SOL_RESERVE,  isSigner: false, isWritable: true  }, // reserve
            { pubkey: SOL_MINT,            isSigner: false, isWritable: false }, // reserveLiquidityMint
            { pubkey: KAMINO_SOL_VAULT,    isSigner: false, isWritable: true  }, // reserveSourceLiquidity
            { pubkey: wsolAta,             isSigner: false, isWritable: true  }, // userDestinationLiquidity
            { pubkey: KAMINO_FEE_RECEIVER, isSigner: false, isWritable: true  }, // reserveLiquidityFeeReceiver
            { pubkey: KAMINO_PROGRAM_ID, isSigner: false, isWritable: false }, // referrerTokenState (None)
            { pubkey: KAMINO_PROGRAM_ID, isSigner: false, isWritable: false }, // referrerAccount (None)
            { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false }, // sysvarInfo
            { pubkey: TOKEN_PROGRAM,       isSigner: false, isWritable: false }, // tokenProgram
        ];

        const repayAccounts = [
            { pubkey: walletPk,            isSigner: true,  isWritable: false }, // userTransferAuthority
            { pubkey: KAMINO_MARKET_AUTH,  isSigner: false, isWritable: false }, // lendingMarketAuthority
            { pubkey: KAMINO_MARKET,       isSigner: false, isWritable: false }, // lendingMarket
            { pubkey: KAMINO_SOL_RESERVE,  isSigner: false, isWritable: true  }, // reserve
            { pubkey: SOL_MINT,            isSigner: false, isWritable: false }, // reserveLiquidityMint
            { pubkey: KAMINO_SOL_VAULT,    isSigner: false, isWritable: true  }, // reserveDestinationLiquidity
            { pubkey: wsolAta,             isSigner: false, isWritable: true  }, // userSourceLiquidity
            { pubkey: KAMINO_FEE_RECEIVER, isSigner: false, isWritable: true  }, // reserveLiquidityFeeReceiver
            { pubkey: KAMINO_PROGRAM_ID, isSigner: false, isWritable: false }, // referrerTokenState (None)
            { pubkey: KAMINO_PROGRAM_ID, isSigner: false, isWritable: false }, // referrerAccount (None)
            { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false }, // sysvarInfo
            { pubkey: TOKEN_PROGRAM,       isSigner: false, isWritable: false }, // tokenProgram
        ];

        this._kaminoBorrowTemplate = [{ programId: KAMINO_PROGRAM_ID, keys: borrowAccounts, data: borrowData }];
        this._kaminoRepayTemplate  = [{ programId: KAMINO_PROGRAM_ID, keys: repayAccounts,  data: repayData  }];
        logger.info(`[Executor] Kamino flashloan templates cached ✅ (wsolAta: ${wsolAta.toBase58().slice(0,8)}...)`);
    }

    // -------------------------------------------------------
    //  KAMINO FLASHLOAN — build ixs per trade (pure CPU)
    // -------------------------------------------------------
    _buildKaminoIxs(amountLamports, borrowIxIndex) {
        const amt = BigInt(amountLamports);

        const borrowData = Buffer.from(this._kaminoBorrowTemplate[0].data);
        borrowData.writeBigUInt64LE(amt, 8);

        const repayData = Buffer.from(this._kaminoRepayTemplate[0].data);
        repayData.writeBigUInt64LE(amt, 8);
        repayData.writeUInt8(borrowIxIndex, 16); // index of borrow ix in the transaction

        return [
            { instructions: [new TransactionInstruction({ programId: KAMINO_PROGRAM_ID, keys: this._kaminoBorrowTemplate[0].keys, data: borrowData })] },
            { instructions: [new TransactionInstruction({ programId: KAMINO_PROGRAM_ID, keys: this._kaminoRepayTemplate[0].keys, data: repayData  })] },
        ];
    }

    _buildMfiIxs(amountLamports) {
        const amt = BigInt(amountLamports);

        const patchAndClone = (template) => template.map(ix => {
            const data = Buffer.from(ix.data); // always clone — never mutate cache

            if (data.length === 16 && data.subarray(0, 8).equals(BORROW_DISCRIMINATOR)) {
                data.writeBigUInt64LE(amt, 8);
            } else if (data.length === 18 && data.subarray(0, 8).equals(REPAY_DISCRIMINATOR)) {
                data.writeBigUInt64LE(amt, 8); // repayAll 0x0101 at [16] stays baked in
            } else if (data.length === 12 && data.readUInt32LE(0) === 2) {
                // SystemProgram.Transfer (wrap SOL before repay): amount + 10000 extra lamports
                data.writeBigUInt64LE(amt + 10000n, 4);
            }

            return new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data });
        });

        return [
            { instructions: patchAndClone(this._borrowIxTemplate) },
            { instructions: patchAndClone(this._repayIxTemplate) },
        ];
    }

    // -------------------------------------------------------
    //  LOAD OR CREATE MARGINFI ACCOUNT
    // -------------------------------------------------------
    async _loadOrCreateAccount() {
        const fileExists = fs.existsSync(MFI_ACCOUNT_FILE);

        if (fileExists) {
            // Account file exists — load it. If fetch fails, STOP. Never create a second account.
            const saved = JSON.parse(fs.readFileSync(MFI_ACCOUNT_FILE, 'utf8'));
            try {
                this.mfiAccount = await MarginfiAccountWrapper.fetch(
                    new PublicKey(saved.address),
                    this.mfiClient
                );
                logger.info(`[Executor] Loaded saved MarginFi account: ${saved.address}`);
                return;
            } catch (e) {
                const msg = `MarginFi account fetch failed for ${saved.address}: ${e.message}. ` +
                    `NOT creating a new account to protect SOL balance. Fix the RPC or account issue and restart.`;
                logger.error(`[Executor] ${msg}`);
                await discord.alertError(msg).catch(() => {});
                throw new Error(msg);
            }
        }

        // No file at all — first ever run, safe to create
        logger.info('[Executor] No saved MarginFi account — creating one for the first time...');
        this.mfiAccount = await this.mfiClient.createMarginfiAccount();

        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(MFI_ACCOUNT_FILE, JSON.stringify({
            address:   this.mfiAccount.address.toString(),
            createdAt: new Date().toISOString(),
        }));
        logger.info(`[Executor] Created MarginFi account: ${this.mfiAccount.address.toString()}`);
    }

    // -------------------------------------------------------
    //  PROFITABILITY CHECK
    //  grossProfit is in SOL lamports (scanner output).
    //  Deduct: dynamic Jito tip + tx fees + MarginFi flashloan fee.
    //  Tip = 50% of gross profit, floored at 50K and capped at 5M lamports.
    // -------------------------------------------------------
    async isProfitable(grossProfit, amountIn) {
        const minProfitUsd    = parseFloat(process.env.MIN_PROFIT_USD || this.config.MIN_PROFIT_USD || '1.5');
        const solPrice        = getSolPrice();
        const tipPct          = parseFloat(process.env.JITO_TIP_PCT || '0.50');
        const tipFloor        = BigInt(process.env.JITO_TIP_FLOOR || '50000');     // 50K min
        const tipCeiling      = BigInt(process.env.JITO_TIP_CEILING || '5000000'); // 5M max (~$0.70)
        const dynamicTip      = grossProfit * BigInt(Math.floor(tipPct * 100)) / 100n;
        const jitoTip         = dynamicTip < tipFloor ? tipFloor : dynamicTip > tipCeiling ? tipCeiling : dynamicTip;
        const txFee           = 10000n;                           // ~2 txs × 5000 lamports
        const flashloanFee    = (amountIn * FLASHLOAN_FEE_BPS) / 10000n;

        const minProfitLamports = BigInt(Math.ceil((minProfitUsd / solPrice) * 1e9));
        const totalCosts        = jitoTip + txFee + flashloanFee;

        return grossProfit > minProfitLamports + totalCosts;
    }

    // -------------------------------------------------------
    //  COMPUTE DYNAMIC JITO TIP
    //  50% of gross profit, floored at 50K, capped at 5M lamports.
    //  Called during tx building to get the actual tip amount.
    // -------------------------------------------------------
    _computeJitoTip(grossProfit) {
        const tipPct     = parseFloat(process.env.JITO_TIP_PCT || '0.50');
        const tipFloor   = BigInt(process.env.JITO_TIP_FLOOR || '50000');
        const tipCeiling = BigInt(process.env.JITO_TIP_CEILING || '5000000');
        const dynamicTip = grossProfit * BigInt(Math.floor(tipPct * 100)) / 100n;
        return dynamicTip < tipFloor ? tipFloor : dynamicTip > tipCeiling ? tipCeiling : dynamicTip;
    }

    // -------------------------------------------------------
    //  GET JUPITER SWAP INSTRUCTIONS  (not full tx)
    //  wrapAndUnwrapSol: false because wSOL comes from MarginFi borrow
    //  prioritizationFeeLamports omitted — Jito tip handles ordering,
    //  and including it adds a SetComputeUnitPrice ix that wastes tx bytes.
    // -------------------------------------------------------
    async _getSwapInstructions(quoteResponse, slippageOverride = null, useTokenLedger = false) {
        const slippageBps = slippageOverride !== null
            ? slippageOverride
            : parseInt(process.env.SLIPPAGE_BPS || this.config.SLIPPAGE_BPS || '50');

        const params = {
            quoteResponse,
            userPublicKey:           this.wallet.publicKey.toString(),
            wrapAndUnwrapSol:        false,
            dynamicComputeUnitLimit: true,
            slippageBps,
            ...(useTokenLedger ? { useTokenLedger: true } : {}),
        };
        
        const res = await axios.post(`${JUPITER_SWAP_API}/swap-instructions`, params, { timeout: 6000 });
        return res.data;
    }

    // -------------------------------------------------------
    //  MERGE COMPUTE BUDGET INSTRUCTIONS FROM BOTH SWAP LEGS
    //  Jupiter simulates each leg independently. We combine them
    //  into one SetComputeUnitLimit that covers the full tx.
    // -------------------------------------------------------
    _mergeComputeBudgetIxs(buyBudgetIxs, sellBudgetIxs) {
        const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
        const SET_CU_LIMIT_VARIANT   = 2; // instruction discriminator
        let maxCuLimit = 200_000; // safe default

        for (const ix of [...buyBudgetIxs, ...sellBudgetIxs]) {
            if (ix.programId.toString() !== COMPUTE_BUDGET_PROGRAM) continue;
            if (ix.data[0] !== SET_CU_LIMIT_VARIANT) continue;
            const limit = ix.data.readUInt32LE(1);
            maxCuLimit  = Math.max(maxCuLimit, limit);
        }

        // Double the higher of the two leg limits to cover both swaps in one tx,
        // capped at Solana's per-tx maximum (1.4M CUs).
        const combinedLimit = Math.min(maxCuLimit * 2, 1_400_000);
        const limitData     = Buffer.alloc(5);
        limitData.writeUInt8(SET_CU_LIMIT_VARIANT, 0);
        limitData.writeUInt32LE(combinedLimit, 1);

        return [new TransactionInstruction({
            programId: new PublicKey(COMPUTE_BUDGET_PROGRAM),
            keys:      [],
            data:      limitData,
        })];
    }

    // -------------------------------------------------------
    //  DESERIALIZE A JUPITER INSTRUCTION
    //  Jupiter returns instructions as JSON (not binary)
    // -------------------------------------------------------
    _deserializeIx(raw) {
        return new TransactionInstruction({
            programId: new PublicKey(raw.programId),
            keys: raw.accounts.map(k => ({
                pubkey:     new PublicKey(k.pubkey),
                isSigner:   k.isSigner,
                isWritable: k.isWritable,
            })),
            data: Buffer.from(raw.data, 'base64'),
        });
    }

    // -------------------------------------------------------
    //  LOAD ADDRESS LOOKUP TABLES
    // -------------------------------------------------------
    async _loadLookupTables(addresses) {
        if (!addresses || addresses.length === 0) return [];
        const key    = [...addresses].sort().join(',');
        const cached = this._lutCache.get(key);
        if (cached && Date.now() - cached.cachedAt < LUT_CACHE_TTL_MS) return cached.tables;

        const results = await Promise.all(
            addresses.map(addr =>
                this.connection
                    .getAddressLookupTable(new PublicKey(addr))
                    .then(r => r.value)
                    .catch(() => null)
            )
        );
        const tables = results.filter(Boolean);
        this._lutCache.set(key, { tables, cachedAt: Date.now() });
        return tables;
    }

    // -------------------------------------------------------
    //  SUBMIT VIA JITO BUNDLE
    //  Submits to mainnet (global) + Frankfurt + Amsterdam simultaneously.
    //  Logs EVERY response from EVERY endpoint — both HTTP errors and
    //  JSON-RPC errors (HTTP 200 with data.error) which were previously silent.
    // -------------------------------------------------------
    async _submitJitoBundle(serializedTxs) {
        const primary   = process.env.JITO_BLOCK_ENGINE_URL || 'https://frankfurt.mainnet.block-engine.jito.wtf';
        const endpoints = [...new Set([
            'https://mainnet.block-engine.jito.wtf',           // global — primary in all Jito docs
            primary,                                            // Frankfurt (closest to VPS)
            'https://amsterdam.mainnet.block-engine.jito.wtf', // Amsterdam backup
        ])].map(url => `${url}/api/v1/bundles`);

        const payload = { jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [serializedTxs] };
        const results  = await Promise.allSettled(
            endpoints.map(url => axios.post(url, payload, { timeout: 3000 }))
        );

        // Check for success first — any endpoint returning a bundleId wins
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === 'fulfilled' && r.value?.data?.result) {
                logger.info(`[Executor] ✅ Jito bundle accepted via ${endpoints[i]}: ${r.value.data.result}`);
                return r.value.data.result;
            }
        }

        // No success — log ALL errors from ALL endpoints for diagnosis
        for (let i = 0; i < results.length; i++) {
            const r   = results[i];
            const ep  = endpoints[i].replace('https://', '').replace('.mainnet.block-engine.jito.wtf/api/v1/bundles', '');

            if (r.status === 'fulfilled' && r.value?.data?.error) {
                // HTTP 200 but JSON-RPC error — these were previously SILENT
                const err    = r.value.data.error;
                const detail = err.message || JSON.stringify(err);
                logger.warn(`[Executor] Jito [${ep}] rejected (200): ${detail}`);
            } else if (r.status === 'fulfilled') {
                // HTTP 200 but no result and no error — unexpected
                logger.debug(`[Executor] Jito [${ep}] returned 200 with no result/error: ${JSON.stringify(r.value?.data)}`);
            } else if (r.status === 'rejected') {
                const e      = r.reason;
                const detail = e.response?.data?.error?.message
                    || e.response?.data?.message
                    || e.message;
                const status = e.response?.status || 'network';
                logger.warn(`[Executor] Jito [${ep}] failed (${status}): ${detail}`);
            }
        }
        return null;
    }

    // -------------------------------------------------------
    //  EXECUTE FLASHLOAN ARB
    //  Called by bot.js when an opportunity is found.
    // -------------------------------------------------------
    async execute(opportunity) {
        const { grossProfit, bestBuyQuote, reverseQuote, pair, amountIn } = opportunity;
        logger.info(`[Executor] Buy quote slippage: ${bestBuyQuote.slippageBps} | otherAmountThreshold: ${bestBuyQuote.otherAmountThreshold}`);
        logger.info(`[Executor] Sell quote slippage: ${reverseQuote.slippageBps} | otherAmountThreshold: ${reverseQuote.otherAmountThreshold}`);
        const buyRoute = (bestBuyQuote.routePlan || []).map(r => r.swapInfo?.label || 'unknown').join(' → ');
        const sellRoute = (reverseQuote.routePlan || []).map(r => r.swapInfo?.label || 'unknown').join(' → ');
        logger.info(`[Executor] Routes — Buy: ${buyRoute} | Sell: ${sellRoute}`);
        logger.info(`[Executor] Buy: ${bestBuyQuote.inAmount} → ${bestBuyQuote.outAmount} (${bestBuyQuote.inputMint.slice(0,8)}→${bestBuyQuote.outputMint.slice(0,8)}) | Sell: ${reverseQuote.inAmount} → ${reverseQuote.outAmount} (${reverseQuote.inputMint.slice(0,8)}→${reverseQuote.outputMint.slice(0,8)})`);

        if (!this._kaminoBorrowTemplate) {
            logger.error('[Executor] Kamino flashloan not initialized — call init() first');
            return false;
        }

        const solPrice   = getSolPrice();
        const grossSol   = (Number(grossProfit) / 1e9).toFixed(6);
        const grossUsd   = (Number(grossProfit) / 1e9 * solPrice).toFixed(2);
        const minProfUsd = parseFloat(process.env.MIN_PROFIT_USD || this.config.MIN_PROFIT_USD || '1.5');

        this.stats.oppsDetected++;

        if (!await this.isProfitable(grossProfit, amountIn)) {
            logger.info(`[Executor] Below min profit — gross: ${grossSol} SOL (~$${grossUsd}) | pair: ${pair.name}`);
            discord.alertBelowMinProfit(pair.name, grossSol, grossUsd, minProfUsd).catch(() => {});
            return false;
        }

        this.stats.oppsAttempted++;

        const profitUsd = grossUsd;
        logger.info(
            `🎯 EXECUTING — ${pair.name} | spread: ${opportunity.priceDiffPct}% | ` +
            `loan: ${opportunity.loanSizeSol?.toFixed(1)} SOL | profit: ~$${profitUsd}`
        );
        // Fire-and-forget — do not await Discord before building tx
        discord.alertExecuting(pair.name, opportunity.priceDiffPct, opportunity.loanSizeSol?.toFixed(1), profitUsd).catch(() => {});

        try {
            // ── Step 1: MFI ixs (CPU — cached templates, no RPC) ─────────
            const amountLamports = Math.round(Number(amountIn));
            const [borrowWrapper, repayWrapper] = this._buildKaminoIxs(amountLamports, 2); // borrowIxIndex=1: jitoTip is ix[0], borrow is ix[1]

            // ── Steps 2+blockhash [PARALLEL] ────────────────────────────
            //  Blockhash is served from in-memory cache (refreshed every 500ms)
            //  so both swap-ix calls run with no RPC dependency alongside them.
            const { blockhash, lastValidBlockHeight } =
                this._blockhashCache || await this.connection.getLatestBlockhash('processed');

            // Proportionally scale sell quote to match buy's guaranteed minimum output.
            // Patching only inAmount left outAmount/otherAmountThreshold inconsistent > 6001.
            {
                const origSellIn = BigInt(reverseQuote.inAmount);
                // Use 25bps buffer instead of full 100bps otherAmountThreshold
                const buyOut = BigInt(bestBuyQuote.outAmount);
                const buyThreshold = BigInt(bestBuyQuote.otherAmountThreshold);
                const adjSellIn = buyOut - (buyOut - buyThreshold) * 10n / 100n;
                if (origSellIn > 0n && adjSellIn < origSellIn) {
                    const scaledOut       = BigInt(reverseQuote.outAmount) * adjSellIn / origSellIn;
                    const scaledThreshold = BigInt(reverseQuote.otherAmountThreshold) * adjSellIn / origSellIn;
                    logger.info('[Executor] Sell quote scaling: inAmount ' + origSellIn + ' > ' + adjSellIn +
                        ' | outAmount ' + reverseQuote.outAmount + ' > ' + scaledOut +
                        ' | threshold ' + reverseQuote.otherAmountThreshold + ' > ' + scaledThreshold +
                        ' | ratio: ' + (Number(adjSellIn) * 100 / Number(origSellIn)).toFixed(2) + '%');
                    reverseQuote.inAmount = String(adjSellIn);
                    reverseQuote.outAmount = String(scaledOut);
                    reverseQuote.otherAmountThreshold = String(scaledThreshold);
                    // Scale routePlan swapInfo amounts — Jupiter builds instructions from these, not top-level fields
                    if (reverseQuote.routePlan) {
                        for (const step of reverseQuote.routePlan) {
                            if (step.swapInfo) {
                                const origIn = BigInt(step.swapInfo.inAmount);
                                const origOut = BigInt(step.swapInfo.outAmount);
                                step.swapInfo.inAmount = String(origIn * adjSellIn / origSellIn);
                                step.swapInfo.outAmount = String(origOut * adjSellIn / origSellIn);
                            }
                        }
                    }
                } else {
                    logger.info('[Executor] Sell quote scaling: no adjustment needed (adjIn >= origIn)');
                }
            }

            // Post-scaling profitability recheck: original grossProfit used unscaled quotes.
            // After scaling sell to buy's otherAmountThreshold, sell output drops.
            // Reject if trade is no longer profitable to avoid Custom:1 on repay.
            {
                const scaledSellOut = BigInt(reverseQuote.outAmount);
                const borrowAmt = BigInt(amountIn);
                const scaledGross = scaledSellOut - borrowAmt;
                if (scaledGross <= 0n) {
                    const scaledUsd = (Number(scaledGross) / 1e9 * getSolPrice()).toFixed(4);
                    logger.info('[Executor] Post-scaling: net negative (' + scaledUsd + ' USD) — aborting');
                    return false;
                }
                if (!await this.isProfitable(scaledGross, borrowAmt)) {
                    const scaledUsd = (Number(scaledGross) / 1e9 * getSolPrice()).toFixed(4);
                    logger.info('[Executor] Post-scaling: below min profit (' + scaledUsd + ' USD) — aborting');
                    return false;
                }
                logger.info('[Executor] Post-scaling profit OK: ' + (Number(scaledGross) / 1e9 * getSolPrice()).toFixed(4) + ' USD');
            }

            const [buyIxData, sellIxData] = await Promise.all([
                this._getSwapInstructions(bestBuyQuote),
                this._getSwapInstructions(reverseQuote, 150),
            ]);

            // Pre-flight vote check REMOVED — Jito-native DEXes need vote accounts as readonly inputs

            // ── Step 3: Collect address lookup tables ─────────────────
            const lutAddresses = [
                ...(buyIxData.addressLookupTableAddresses  || []),
                ...(sellIxData.addressLookupTableAddresses || []),
            ];
            const rawLookupTables = await this._loadLookupTables([...new Set(lutAddresses)]);
            // Filter ALL vote accounts from ALT address lists — Jito rejects ANY vote account
            const lookupTables = [];
            for (const alt of rawLookupTables) {
                const voteAddrs = [];
                const uncached = alt.state.addresses.filter(a => !_voteAccountCache.has(a.toString()));
                if (uncached.length > 0) {
                    try {
                        const infos = await this.connection.getMultipleAccountsInfo(uncached);
                        for (let i = 0; i < uncached.length; i++) {
                            const isVote = infos[i] && infos[i].owner.toString() === VOTE_PROGRAM_ID ? true : false;
                            _voteAccountCache.set(uncached[i].toString(), isVote);
                        }
                    } catch (e) { uncached.forEach(a => _voteAccountCache.set(a.toString(), false)); }
                }
                for (const addr of alt.state.addresses) {
                    if (_voteAccountCache.get(addr.toString())) voteAddrs.push(addr.toString());
                }
                if (voteAddrs.length > 0) {
                    logger.info('[Executor] Found ' + voteAddrs.length + ' vote account(s) in ALT: ' + alt.key.toString().slice(0,12) + ' — marking readonly in instructions');
                    // Mark vote accounts as readonly in all innerIxs
                    for (const ix of innerIxs) {
                        for (const key of ix.keys) {
                            if (voteAddrs.includes(key.pubkey.toString()) && key.isWritable) {
                                key.isWritable = false;
                                logger.debug('[Executor] Downgraded vote account to readonly: ' + key.pubkey.toString().slice(0,12));
                            }
                        }
                    }
                }
                lookupTables.push(alt);
            }

            // ── Step 4: Build ordered instruction list ─────────────────
            //  Layout inside flashloan wrapper:
            //    borrow → [compute budget] → [setup] → buy swap → sell swap → repay
            //
            //  Compute budget: merge both legs to use the higher CU limit × 2.
            //  This prevents ComputationalBudgetExceeded when the sell leg needs
            //  more CUs than the buy leg's standalone simulation returned.
            const buyCbRaw  = (buyIxData.computeBudgetInstructions  || []).map(ix => this._deserializeIx(ix));
            const sellCbRaw = (sellIxData.computeBudgetInstructions || []).map(ix => this._deserializeIx(ix));
            const computeBudgetIxs = this._mergeComputeBudgetIxs(buyCbRaw, sellCbRaw);

            // Deduplicate setup instructions across buy + sell:
            // Jupiter often emits createAssociatedTokenAccountIdempotent for the same
            // accounts in both swap responses. Keeping both makes the tx exceed 1232 bytes.
            // We key each instruction by programId + first-writable-account to detect dupes.
            const buySetupIxs  = (buyIxData.setupInstructions  || []).map(ix => this._deserializeIx(ix));
            const sellSetupRaw = (sellIxData.setupInstructions || []).map(ix => this._deserializeIx(ix));
            const seenSetup    = new Set(
                buySetupIxs.map(ix => {
                    const firstWritable = ix.keys.find(k => k.isWritable);
                    return `${ix.programId.toString()}:${firstWritable?.pubkey.toString() ?? ''}`;
                })
            );
            const sellSetupIxs = sellSetupRaw.filter(ix => {
                const firstWritable = ix.keys.find(k => k.isWritable);
                const key = `${ix.programId.toString()}:${firstWritable?.pubkey.toString() ?? ''}`;
                return !seenSetup.has(key);
            });

            // Jito tip instruction — dynamic: 50% of gross profit (floor 50K, cap 5M lamports)
            const jitoTipLamports = this._computeJitoTip(grossProfit);
            const solPrice2       = getSolPrice();
            const tipUsd          = (Number(jitoTipLamports) / 1e9 * solPrice2).toFixed(4);
            logger.info(`[Executor] Jito tip: ${jitoTipLamports} lamports (~$${tipUsd}) | ${((Number(jitoTipLamports) / Number(grossProfit)) * 100).toFixed(0)}% of gross`);
            const jitoTipAccount  = new PublicKey(
                JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
            );
            const jitoTipIx = SystemProgram.transfer({
                fromPubkey: this.wallet.publicKey,
                toPubkey:   jitoTipAccount,
                lamports:   jitoTipLamports,
            });

            // Create WSOL ATA idempotently before flash borrow
            const { createAssociatedTokenAccountIdempotentInstruction } = require('@solana/spl-token');
            const wsolAtaCreateIx = createAssociatedTokenAccountIdempotentInstruction(
                this.wallet.publicKey,  // payer
                this._kaminoWsolAta,    // ata
                this.wallet.publicKey,  // owner
                SOL_MINT                // mint
            );
            const innerIxs = [
                jitoTipIx,
                wsolAtaCreateIx,
                ...(borrowWrapper.instructions || []),
                ...computeBudgetIxs,
                ...buySetupIxs,
                // buy tokenLedger removed — buy uses fixed inAmount, only sell needs ledger
                this._deserializeIx(buyIxData.swapInstruction),
                ...(buyIxData.cleanupInstruction  ? [this._deserializeIx(buyIxData.cleanupInstruction)] : []),
                ...sellSetupIxs,
                // sellTokenLedger removed
                this._deserializeIx(sellIxData.swapInstruction),
                ...(sellIxData.cleanupInstruction ? [this._deserializeIx(sellIxData.cleanupInstruction)] : []),
                ...(repayWrapper.instructions || []),
                // Fix C: Unwrap WSOL -> native SOL after repay (profit sits in WSOL ATA)
                (() => {
                    const { createCloseAccountInstruction, NATIVE_MINT } = require('@solana/spl-token');
                    const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
                    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, this.wallet.publicKey);
                    return createCloseAccountInstruction(wsolAta, this.wallet.publicKey, this.wallet.publicKey);
                })(),
            ];

            // ── Dynamic borrowIxIndex: find actual borrow position in innerIxs ──
            // Hardcoded index=2 breaks when Jupiter setup ixs shift the borrow position.
            // Kamino repay validates borrowInstructionIndex via Sysvar Instructions —
            // if it doesn't point to the actual borrow ix, repay fails with Custom:1.
            {
                const KAMINO_PID = KAMINO_PROGRAM_ID.toBase58();
                const borrowDiscHex = KAMINO_FLASH_BORROW_DISC.toString('hex');
                let foundIdx = -1;
                for (let i = 0; i < innerIxs.length; i++) {
                    const ix = innerIxs[i];
                    if (ix.programId.toBase58() === KAMINO_PID && ix.data.subarray(0, 8).toString('hex') === borrowDiscHex) {
                        foundIdx = i;
                        break;
                    }
                }
                if (foundIdx === -1) throw new Error('Kamino borrow instruction not found in innerIxs');
                // Patch the repay instruction's borrowInstructionIndex byte
                const repayIx = innerIxs.find(ix => ix.programId.toBase58() === KAMINO_PID && ix.data.subarray(0, 8).toString('hex') === KAMINO_FLASH_REPAY_DISC.toString('hex'));
                if (!repayIx) throw new Error('Kamino repay instruction not found in innerIxs');
                repayIx.data.writeUInt8(foundIdx, 16);
                logger.info('[Executor] borrowIxIndex dynamically set to ' + foundIdx + ' (was hardcoded 2)');
            }

            // ── Step 5: Build flashloan tx (MarginFi adds begin/end) ──
            // blockhash already fetched in parallel with steps 1+2 above
            // Fetch fresh blockhash right before building tx — swap-ix calls take ~400ms
            // and the cached blockhash may be stale by the time we reach here.
            const freshBh = await this.connection.getLatestBlockhash('processed');
            const finalBlockhash = freshBh.blockhash;
            const finalLastValidBlockHeight = freshBh.lastValidBlockHeight;
            const { TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
            let flashTx = (() => {
                const msg = new TransactionMessage({
                    payerKey:           this.wallet.publicKey,
                    recentBlockhash:    finalBlockhash,
                    instructions:       innerIxs,
                }).compileToV0Message(lookupTables);
                return new VersionedTransaction(msg);
            })();

            // ── Step 5b: Vote account filter ──────────────────────────
            // Jito rejects bundles that lock ANY vote-program-owned account
            // as writable. Vote accounts sneak in via Jupiter's ALT writable
            // indexes — invisible to instruction key arrays.
            // Fix: detect vote accounts in compiled tx, patch innerIxs to mark
            // them readonly, rebuild tx. buildFlashLoanTx recompiles the message
            // from innerIxs, so patched isWritable flags propagate into ALT
            // writable/readonly index assignment.
            try {
                const msg = flashTx.message;
                const numSigners    = msg.header.numRequiredSignatures;
                const numReadonlyS  = msg.header.numReadonlySignedAccounts;
                const numReadonlyU  = msg.header.numReadonlyUnsignedAccounts;
                const staticKeys    = msg.staticAccountKeys.map(k => k.toString());
                const totalStatic   = staticKeys.length;
                const writableSignerCount    = numSigners - numReadonlyS;
                const readonlyUnsignedStart  = totalStatic - numReadonlyU;

                // Collect all writable keys (static + ALT writable indexes)
                const writableKeys = [];
                for (let i = 0; i < totalStatic; i++) {
                    const isReadonlySigner   = (i >= writableSignerCount && i < numSigners);
                    const isReadonlyUnsigned = (i >= readonlyUnsignedStart);
                    if (!isReadonlySigner && !isReadonlyUnsigned) {
                        writableKeys.push(staticKeys[i]);
                    }
                }
                if (msg.addressTableLookups) {
                    for (const lookup of msg.addressTableLookups) {
                        const table = lookupTables.find(t => t.key.equals(lookup.accountKey));
                        if (!table) continue;
                        for (const idx of (lookup.writableIndexes || [])) {
                            const addr = table.state.addresses[idx];
                            if (addr) writableKeys.push(addr.toString());
                        }
                    }
                }

                // Only look up keys not already in cache
                const uncachedKeys = writableKeys.filter(k => !_voteAccountCache.has(k));
                if (uncachedKeys.length > 0 && uncachedKeys.length <= 100) {
                    const infos = await this.connection.getMultipleAccountsInfo(
                        uncachedKeys.map(k => new PublicKey(k)),
                        { commitment: 'confirmed' }
                    );
                    for (let i = 0; i < infos.length; i++) {
                        _voteAccountCache.set(uncachedKeys[i], !!(infos[i] && infos[i].owner.toString() === VOTE_PROGRAM_ID));
                    }
                    logger.debug(`[Executor] Vote cache: +${uncachedKeys.length} lookups, ${_voteAccountCache.size} total`);
                } else if (uncachedKeys.length > 100) {
                    // Batch in groups of 100
                    for (let b = 0; b < uncachedKeys.length; b += 100) {
                        const batch = uncachedKeys.slice(b, b + 100);
                        const infos = await this.connection.getMultipleAccountsInfo(
                            batch.map(k => new PublicKey(k)),
                            { commitment: 'confirmed' }
                        );
                        for (let i = 0; i < infos.length; i++) {
                            _voteAccountCache.set(batch[i], !!(infos[i] && infos[i].owner.toString() === VOTE_PROGRAM_ID));
                        }
                    }
                    logger.debug(`[Executor] Vote cache: +${uncachedKeys.length} lookups (batched), ${_voteAccountCache.size} total`);
                }

                // Identify vote accounts among writable keys
                const voteSet = new Set();
                for (const k of writableKeys) {
                    if (_voteAccountCache.get(k) === true) voteSet.add(k);
                }

                if (voteSet.size > 0) {
                    logger.warn(`[Executor] ⚠️  Filtering ${voteSet.size} vote account(s) from writable set: ${[...voteSet].join(', ')}`);

                    // Patch innerIxs: mark vote accounts as readonly
                    let patchCount = 0;
                    for (const ix of innerIxs) {
                        for (const key of (ix.keys || [])) {
                            if (key.isWritable && voteSet.has(key.pubkey.toString())) {
                                key.isWritable = false;
                                patchCount++;
                            }
                        }
                    }

                    // Rebuild tx — buildFlashLoanTx recompiles the versioned message
                    // from innerIxs. Patched isWritable=false means the vote account
                    // lands in ALT readonlyIndexes instead of writableIndexes.
                    flashTx = (() => {
                        const msg = new TransactionMessage({
                            payerKey:           this.wallet.publicKey,
                            recentBlockhash:    finalBlockhash,
                            instructions:       innerIxs,
                        }).compileToV0Message(lookupTables);
                        return new VersionedTransaction(msg);
                    })();
                    logger.info(`[Executor] ✅ Tx rebuilt — ${voteSet.size} vote account(s) → readonly (${patchCount} ix keys patched)`);
                } else {
                    logger.debug(`[Executor] No vote accounts in ${writableKeys.length} writable keys (${uncachedKeys.length} new lookups)`);
                }
            } catch (voteFixErr) {
                logger.warn(`[Executor] Vote filter error (proceeding with original tx): ${voteFixErr.message}`);
            }

            // ── Diagnostic: check vote account status in final compiled message ──
            const JITO_VOTE_DIAG = 'J1to1yufRnoWn81KYg1XkTWzmKjnYSnmE2VY8DGUJ9Qv';
            // Check ALL accounts in compiled tx for vote program ownership
            const allTxAccounts = [];
            const fMsgCheck = flashTx.message;
            const fStaticAll = fMsgCheck.staticAccountKeys.map(k => k.toString());
            fStaticAll.forEach((k, i) => allTxAccounts.push({ addr: k, source: 'static', idx: i }));
            for (const lookup of (fMsgCheck.addressTableLookups || [])) {
                const altAddr = lookup.accountKey.toString();
                const altObj = lookupTables.find(t => t.key.toString() === altAddr);
                if (!altObj) continue;
                for (const wi of lookup.writableIndexes) {
                    const a = altObj.state.addresses[wi];
                    if (a) allTxAccounts.push({ addr: a.toString(), source: 'ALT-W', idx: wi, alt: altAddr.slice(0,12) });
                }
                for (const ri of lookup.readonlyIndexes) {
                    const a = altObj.state.addresses[ri];
                    if (a) allTxAccounts.push({ addr: a.toString(), source: 'ALT-R', idx: ri, alt: altAddr.slice(0,12) });
                }
            }
            const voteAccounts = allTxAccounts.filter(a => _voteAccountCache.get(a.addr));
            if (voteAccounts.length > 0) {
                for (const v of voteAccounts) {
                    logger.warn('[Executor] VOTE IN TX: ' + v.addr.slice(0,12) + ' source=' + v.source + (v.alt ? ' ALT=' + v.alt : '') + ' idx=' + v.idx);
                }
            } else {
                logger.info('[Executor] No vote accounts found in final compiled tx (' + allTxAccounts.length + ' accounts checked)');
            }
            const fMsg = flashTx.message;
            const fStatic = fMsg.staticAccountKeys.map(k => k.toString());
            const fNumSigners = fMsg.header.numRequiredSignatures;
            const fNumRoSigned = fMsg.header.numReadonlySignedAccounts;
            const fNumRoUnsigned = fMsg.header.numReadonlyUnsignedAccounts;
            const fWritableEnd = fStatic.length - fNumRoUnsigned;
            const fWritableStatic = fStatic.slice(0, fWritableEnd);
            const voteInStatic = fStatic.indexOf(JITO_VOTE_DIAG);
            if (voteInStatic >= 0) {
                const isW = voteInStatic < fWritableEnd;
                logger.info('[Executor] VOTE DIAG: ' + JITO_VOTE_DIAG.slice(0,12) + ' in STATIC keys, index=' + voteInStatic + ', writable=' + isW);
            }
            // Check ALT indexes
            for (const lookup of (fMsgCheck.addressTableLookups || [])) {
                const altKey = lookup.accountKey.toString().slice(0,12);
                const wIdx = lookup.writableIndexes || [];
                const rIdx = lookup.readonlyIndexes || [];
                logger.info('[Executor] ALT ' + altKey + ': writableIdx=[' + wIdx.join(',') + '] readonlyIdx=[' + rIdx.join(',') + ']');
            }
            // ── Step 5c: Patch vote accounts from writable to readonly in ALT lookups ──
            // Jito checks raw ALT indexes, not instruction flags. buildFlashLoanTx may place
            // vote accounts in writableIndexes even if we patched isWritable=false in innerIxs.
            // Patch ALL vote accounts in ALT writable indexes to readonly
            const msg2 = flashTx.message;
            let needsRebuild = false;
            for (const lookup of (msg2.addressTableLookups || [])) {
                const altAddr = lookup.accountKey.toString();
                const altObj = lookupTables.find(t => t.key.toString() === altAddr);
                if (!altObj) continue;
                const addrs = altObj.state.addresses.map(a => a.toString());
                const patchedWritable = [];
                const patchedReadonly = [...lookup.readonlyIndexes];
                for (const wIdx of lookup.writableIndexes) {
                    const addr = addrs[wIdx];
                    if (addr && _voteAccountCache.get(addr)) {
                        patchedReadonly.push(wIdx);
                        needsRebuild = true;
                        logger.info('[Executor] Moved vote account ' + addr.slice(0,12) + ' from writable to readonly in ALT ' + altAddr.slice(0,12) + ' idx=' + wIdx);
                    } else {
                        patchedWritable.push(wIdx);
                    }
                }
                lookup.writableIndexes = patchedWritable;
                lookup.readonlyIndexes = patchedReadonly;
            }
            if (needsRebuild) {
                const { TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
                const decompiled = TransactionMessage.decompile(msg2, { addressLookupTableAccounts: lookupTables });
                const recompiledMsg = decompiled.compileToV0Message(lookupTables);
                flashTx = new VersionedTransaction(recompiledMsg);
                logger.info('[Executor] Transaction rebuilt — all vote accounts moved to readonly');
            }
            
            // ── Step 6: Sign ──────────────────────────────────────────
            flashTx.sign([this.wallet]);

            // Guard: Solana versioned transactions are capped at 1232 bytes.
            // Serialize once after signing — used for both size check and Jito submission.
            // Note: serialize() throws "encoding overruns Uint8Array" when the tx is too
            // large for the buffer — catch that too.
            let serializedBuf;
            try {
                serializedBuf = Buffer.from(flashTx.serialize());
            } catch (e) {
                throw new Error(`Transaction too large to serialize (reduce JUPITER_MAX_ACCOUNTS). ${e.message}`);
            }
            if (serializedBuf.length > 1232) {
                throw new Error(`Transaction too large: ${serializedBuf.length} bytes (limit 1232). Reduce JUPITER_MAX_ACCOUNTS.`);
            }
            logger.debug(`[Executor] Tx size: ${serializedBuf.length} bytes`);
            // ── Step 6c: Simulation DISABLED — flashloan context causes false negatives

            // ── Step 7: Submit via Jito + direct RPC simultaneously ──────
            // Both fire with the same signed tx — on-chain it's idempotent (same sig).
            // Eliminates the old 3s Jito-wait before fallback. No re-sign needed.
            const serialized  = bs58.encode(serializedBuf);
            // Bundle submission replaced by sendTransaction above
            const bundleId = null;
            // Submit via Jito sendTransaction (MEV-protected, no vote account restriction)
            const jitoTxEndpoints = [
                'https://mainnet.block-engine.jito.wtf/api/v1/transactions',
                'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/transactions',
                'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/transactions',
            ];
            let directSig = null;
            try {
                directSig = await Promise.any(jitoTxEndpoints.map(endpoint =>
                    axios.post(endpoint, {
                        jsonrpc: '2.0', id: 1,
                        method: 'sendTransaction',
                        params: [serialized, { encoding: 'base58' }],
                    }, {
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 5000,
                    }).then(resp => {
                        if (!resp.data?.result) throw new Error('no result');
                        logger.info('[Executor] Jito sendTransaction accepted via ' + endpoint.split('/')[2].split('.')[0]);
                        return resp.data.result;
                    })
                ));
            } catch {
                directSig = bs58.encode(flashTx.signatures[0]);
                logger.warn('[Executor] All Jito TX endpoints failed — using signature from signed tx');
            }
            this.stats.txSent++;

            // Fire-and-forget confirmation — don't block the hot path
            if (directSig) {
                logger.info(`[Executor] Tx submitted: ${directSig} — confirming async`);
                this._confirmAsync(directSig, finalBlockhash, finalLastValidBlockHeight, pair, profitUsd, grossProfit, bundleId).catch(() => {});
                return true;
            }

            logger.warn(`[Executor] Both Jito and direct submission failed`);
            return false;

        } catch (e) {
            logger.error(`[Executor] Execution error: ${e.message}`);
            discord.alertError(`Flashloan failed: ${e.message}`).catch(() => {});
            return false;
        }
    }

    // -------------------------------------------------------
    //  LOCAL EXECUTION — Orca Whirlpool direct pool routing
    //  No Jupiter API calls. Builds swap instructions locally.
    //  Called when checkCrossPoolSpread() finds a profitable
    //  cross-DEX spread with known pool addresses.
    // -------------------------------------------------------
    async executeLocal(opportunity) {
        const { buyPool, sellPool, pair, amountIn, spreadPct } = opportunity;
        // buyPool/sellPool: { address, dexType, price, ... } from checkCrossPoolSpread
        // amountIn: bigint lamports (SOL)
 
        if (!this._kaminoBorrowTemplate) {
            logger.error('[Executor] Kamino flashloan not initialized — call init() first');
            return false;
        }
 
        const { buildOrcaSwapIx } = require('./orcaBuilder');
        const { buildRaydiumSwapIx } = require('./raydiumBuilder');
        const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, NATIVE_MINT } = require('@solana/spl-token');
        const localPools = require('./localPools');
 
        const solPrice = getSolPrice();
        const amountLamports = Number(amountIn);
        const amountBigInt = BigInt(amountIn);
 
        this.stats.oppsDetected++;
 
        // ── Step 1: Compute swap outputs with local math ──
        const buyPoolState = localPools.getPoolState(buyPool.address);
        const sellPoolState = localPools.getPoolState(sellPool.address);
        if (!buyPoolState || !sellPoolState) {
            logger.warn('[LocalExec] Pool state missing — buy:', !!buyPoolState, 'sell:', !!sellPoolState);
            return false;
        }
 
        // Buy: SOL → tokenB on the LOW-priced pool
        const buyResult = localPools.computeSwap(pair.tokenA, pair.tokenB, amountBigInt, buyPoolState);
        if (!buyResult || buyResult.amountOut <= 0n) {
            logger.warn('[LocalExec] Buy computeSwap failed');
            return false;
        }
 
        // Sell: tokenB → SOL on the HIGH-priced pool
        const sellResult = localPools.computeSwap(pair.tokenB, pair.tokenA, buyResult.amountOut, sellPoolState);
        if (!sellResult || sellResult.amountOut <= 0n) {
            logger.warn('[LocalExec] Sell computeSwap failed');
            return false;
        }
 
        const grossProfit = sellResult.amountOut - amountBigInt;
        const grossSol = (Number(grossProfit) / 1e9).toFixed(6);
        const grossUsd = (Number(grossProfit) / 1e9 * solPrice).toFixed(4);
 
        if (grossProfit <= 0n) {
            logger.info(`[LocalExec] Net negative after local math: ${grossUsd} USD — skipping`);
            return false;
        }
 
        if (!await this.isProfitable(grossProfit, amountBigInt)) {
            logger.info(`[LocalExec] Below min profit — gross: ${grossSol} SOL (~$${grossUsd}) | pair: ${pair.name}`);
            return false;
        }
 
        this.stats.oppsAttempted++;
 
        logger.info(
            `🎯 LOCAL EXEC — ${pair.name} | spread: ${(spreadPct * 100).toFixed(3)}% | ` +
            `loan: ${(amountLamports / 1e9).toFixed(1)} SOL | profit: ~$${grossUsd} | ` +
            `buy: ${buyPool.dexType}@${buyPool.address.slice(0,8)} → sell: ${sellPool.dexType}@${sellPool.address.slice(0,8)}`
        );
        discord.alertExecuting(pair.name, (spreadPct * 100).toFixed(3), (amountLamports / 1e9).toFixed(1), grossUsd).catch(() => {});
 
        try {
            // ── Step 2: Build Kamino flashloan ixs ──
            const [borrowWrapper, repayWrapper] = this._buildKaminoIxs(amountLamports, 2);
 
            // ── Step 3: Build local swap instructions ──
            // Apply conservative 3% buffer on otherAmountThreshold (local math is single-tick approximation)
            const buyThreshold = buyResult.amountOut * 97n / 100n;
            const sellThreshold = (amountBigInt * 100n / 100n); // Must get back at least the borrow amount
 
            // Buy swap: SOL → BONK on buyPool (picks builder by dexType)
            const buySwap = buyPoolState.dexType === "Raydium CLMM"
                ? buildRaydiumSwapIx({
                    poolAddress: buyPool.address,
                    poolState: buyPoolState,
                    walletPubkey: this.wallet.publicKey,
                    inputMint: pair.tokenA,
                    amount: amountBigInt,
                    otherAmountThreshold: buyThreshold,
                    isBaseInput: true,
                })
                : buildOrcaSwapIx({
                    whirlpoolAddress: buyPool.address,
                    poolState: buyPoolState,
                    walletPubkey: this.wallet.publicKey,
                    inputMint: pair.tokenA,
                    amount: amountBigInt,
                    otherAmountThreshold: buyThreshold,
                    amountSpecifiedIsInput: true,
                });
 
            // Sell swap: BONK → SOL on sellPool (picks builder by dexType)
            const sellSwap = sellPoolState.dexType === "Raydium CLMM"
                ? buildRaydiumSwapIx({
                    poolAddress: sellPool.address,
                    poolState: sellPoolState,
                    walletPubkey: this.wallet.publicKey,
                    inputMint: pair.tokenB,
                    amount: buyResult.amountOut,
                    otherAmountThreshold: sellThreshold,
                    isBaseInput: true,
                })
                : buildOrcaSwapIx({
                    whirlpoolAddress: sellPool.address,
                    poolState: sellPoolState,
                    walletPubkey: this.wallet.publicKey,
                    inputMint: pair.tokenB,
                    amount: buyResult.amountOut,
                    otherAmountThreshold: sellThreshold,
                    amountSpecifiedIsInput: true,
                });
 
            // ── Step 4: Compute budget ──
            // Two Orca swaps: ~200K CU each, generous buffer
            const computeBudgetProg = new PublicKey('ComputeBudget111111111111111111111111111111');
            const cuLimitData = Buffer.alloc(5);
            cuLimitData.writeUInt8(2, 0);
            cuLimitData.writeUInt32LE(600_000, 1);
            const cuLimitIx = new TransactionInstruction({
                programId: computeBudgetProg,
                keys: [],
                data: cuLimitData,
            });
 
            // Compute unit price (priority fee) — 1 microlamport
            const cuPriceData = Buffer.alloc(9);
            cuPriceData.writeUInt8(3, 0);
            cuPriceData.writeBigUInt64LE(1n, 1);
            const cuPriceIx = new TransactionInstruction({
                programId: computeBudgetProg,
                keys: [],
                data: cuPriceData,
            });
 
            // ── Step 5: Jito tip ──
            const jitoTipLamports = this._computeJitoTip(grossProfit);
            const tipUsd = (Number(jitoTipLamports) / 1e9 * solPrice).toFixed(4);
            logger.info(`[LocalExec] Jito tip: ${jitoTipLamports} lamports (~$${tipUsd})`);
            const jitoTipAccount = new PublicKey(
                JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
            );
            const jitoTipIx = SystemProgram.transfer({
                fromPubkey: this.wallet.publicKey,
                toPubkey: jitoTipAccount,
                lamports: jitoTipLamports,
            });
 
            // ── Step 6: WSOL ATA create ──
            const wsolAtaCreateIx = createAssociatedTokenAccountIdempotentInstruction(
                this.wallet.publicKey,
                this._kaminoWsolAta,
                this.wallet.publicKey,
                SOL_MINT
            );
 
            // ── Step 7: Assemble innerIxs ──
            // Order: tip → wsolATA → borrow → computeBudget → buyATA → buySwap → sellSwap → repay → closeWSOL
            const innerIxs = [
                jitoTipIx,
                wsolAtaCreateIx,
                ...(borrowWrapper.instructions || []),
                cuLimitIx,
                cuPriceIx,
            ];
 
            // ATA create for output token (buy outputs BONK, need BONK ATA)
            if (buySwap.ataIx) innerIxs.push(buySwap.ataIx);
 
            // Buy swap
            innerIxs.push(buySwap.swapIx);
 
            // Sell swap (no extra ATA needed — sells back to WSOL which already exists)
            innerIxs.push(sellSwap.swapIx);
 
            // Repay
            innerIxs.push(...(repayWrapper.instructions || []));
 
            // Close WSOL ATA → unwrap profit to native SOL
            const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, this.wallet.publicKey);
            innerIxs.push(createCloseAccountInstruction(wsolAta, this.wallet.publicKey, this.wallet.publicKey));
 
            // ── Step 8: Dynamic borrowIxIndex ──
            {
                const KAMINO_PID = KAMINO_PROGRAM_ID.toBase58();
                const borrowDiscHex = KAMINO_FLASH_BORROW_DISC.toString('hex');
                let foundIdx = -1;
                for (let i = 0; i < innerIxs.length; i++) {
                    const ix = innerIxs[i];
                    if (ix.programId.toBase58() === KAMINO_PID && ix.data.subarray(0, 8).toString('hex') === borrowDiscHex) {
                        foundIdx = i;
                        break;
                    }
                }
                if (foundIdx === -1) throw new Error('Kamino borrow instruction not found in innerIxs');
                const repayIx = innerIxs.find(ix => ix.programId.toBase58() === KAMINO_PID && ix.data.subarray(0, 8).toString('hex') === KAMINO_FLASH_REPAY_DISC.toString('hex'));
                if (!repayIx) throw new Error('Kamino repay instruction not found in innerIxs');
                repayIx.data.writeUInt8(foundIdx, 16);
                logger.info('[LocalExec] borrowIxIndex dynamically set to ' + foundIdx);
            }
 
            // ── Step 9: Build transaction (no ALTs needed — small account count) ──
            const freshBh = await this.connection.getLatestBlockhash('processed');
            const { TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
            let flashTx = (() => {
                const msg = new TransactionMessage({
                    payerKey: this.wallet.publicKey,
                    recentBlockhash: freshBh.blockhash,
                    instructions: innerIxs,
                }).compileToV0Message(); // No lookup tables
                return new VersionedTransaction(msg);
            })();
 
            // ── Step 10: Sign ──
            flashTx.sign([this.wallet]);
 
            let serializedBuf;
            try {
                serializedBuf = Buffer.from(flashTx.serialize());
            } catch (e) {
                throw new Error(`Transaction too large to serialize: ${e.message}`);
            }
            if (serializedBuf.length > 1232) {
                throw new Error(`Transaction too large: ${serializedBuf.length} bytes (limit 1232)`);
            }
            logger.info(`[LocalExec] Tx size: ${serializedBuf.length} bytes | ${innerIxs.length} instructions`);
 
            // ── Step 11: Submit via Jito ──
            const serialized = bs58.encode(serializedBuf);
            const jitoTxEndpoints = [
                'https://mainnet.block-engine.jito.wtf/api/v1/transactions',
                'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/transactions',
                'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/transactions',
            ];
            let directSig = null;
            try {
                directSig = await Promise.any(jitoTxEndpoints.map(endpoint =>
                    axios.post(endpoint, {
                        jsonrpc: '2.0', id: 1,
                        method: 'sendTransaction',
                        params: [serialized, { encoding: 'base58' }],
                    }, {
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 5000,
                    }).then(resp => {
                        if (!resp.data?.result) throw new Error('no result');
                        logger.info('[LocalExec] Jito accepted via ' + endpoint.split('/')[2].split('.')[0]);
                        return resp.data.result;
                    })
                ));
            } catch {
                directSig = bs58.encode(flashTx.signatures[0]);
                logger.warn('[LocalExec] All Jito TX endpoints failed — using signature from signed tx');
            }
            this.stats.txSent++;
 
            if (directSig) {
                logger.info(`[LocalExec] ✅ Tx submitted: ${directSig}`);
                this._confirmAsync(directSig, freshBh.blockhash, freshBh.lastValidBlockHeight, pair, grossUsd, grossProfit, null).catch(() => {});
                return true;
            }
 
            logger.warn('[LocalExec] Submission failed');
            return false;
 
        } catch (e) {
            logger.error(`[LocalExec] Error: ${e.message}`);
            return false;
        }
    }
    // -------------------------------------------------------
    async _confirmAsync(sig, blockhash, lastValidBlockHeight, pair, profitUsd, grossProfit, bundleId) {
        try {
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Confirmation timeout after 30s')), 30000)
            );
            const result = await Promise.race([
                this.connection.confirmTransaction(
                    { signature: sig, blockhash, lastValidBlockHeight },
                    { commitment: 'confirmed', disableRetryOnRateLimit: true }
                ),
                timeout,
            ]);
            if (result.value.err) {
                const reason = JSON.stringify(result.value.err);
                logger.error(`[Executor] Tx failed on-chain: ${reason}`);
                discord.alertTxFailed(pair.name, reason).catch(() => {});
                return;
            }
            this.stats.txSuccess++;
            this.stats.totalProfit += grossProfit;
            logger.info(`✅ FLASHLOAN confirmed | Profit: ~${profitUsd} | Sig: ${sig}${bundleId ? ` | Bundle: ${bundleId}` : ''}`);
            discord.alertTrade(profitUsd, pair.name, sig).catch(() => {});
        } catch (err) {
            logger.error(`[Executor] Tx confirmation failed: ${err.message}`);
            discord.alertTxFailed(pair.name, err.message).catch(() => {});
        }
    }

    // -------------------------------------------------------
    async printStats() {
        const solPrice  = getSolPrice();
        const profitUsd = (Number(this.stats.totalProfit) / 1e9 * solPrice).toFixed(2);
        logger.info(
            `📊 STATS | Slots: ${this.stats.slotsScanned} | ` +
            `Detected: ${this.stats.oppsDetected} | Attempted: ${this.stats.oppsAttempted} | ` +
            `Sent: ${this.stats.txSent} | Success: ${this.stats.txSuccess} | Profit: ~$${profitUsd}`
        );
    }
}

module.exports = { Executor };
