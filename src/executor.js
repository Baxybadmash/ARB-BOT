// src/executor.js
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
const JITO_BUNDLE_URL   = `${process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.labs.io'}/api/v1/bundles`;

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
const MFI_ACCOUNT_FILE  = path.join(DATA_DIR, 'marginfi_account.json');

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
            'confirmed'
        );
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
        this._borrowIxTemplate = borrowTemplate.instructions.map(ix => ({
            programId: ix.programId, keys: ix.keys, data: Buffer.from(ix.data),
        }));
        this._repayIxTemplate = repayTemplate.instructions.map(ix => ({
            programId: ix.programId, keys: ix.keys, data: Buffer.from(ix.data),
        }));
        logger.info('[Executor] MFI instruction templates cached ✅');
    }

    // -------------------------------------------------------
    //  BUILD MFI BORROW/REPAY INSTRUCTIONS  (CPU only — no RPC)
    //  Clones the startup-cached templates and patches only the
    //  amount bytes.  Discriminator offsets verified empirically:
    //    lendingAccountBorrow data: [discriminator(8) | amount u64 LE(8)]
    //    lendingAccountRepay  data: [discriminator(8) | amount u64 LE(8) | repayAll(2)]
    //    SystemProgram.transfer   data: [type u32 LE(4) | amount+10000 u64 LE(8)]
    // -------------------------------------------------------
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
    //  Deduct: Jito tip + tx fees + MarginFi flashloan fee.
    // -------------------------------------------------------
    async isProfitable(grossProfit, amountIn) {
        const minProfitUsd    = parseFloat(process.env.MIN_PROFIT_USD || this.config.MIN_PROFIT_USD || '1.5');
        const solPrice        = getSolPrice();
        const jitoTip         = BigInt(process.env.JITO_TIP_LAMPORTS  || '50000');
        const txFee           = 10000n;                           // ~2 txs × 5000 lamports
        const flashloanFee    = (amountIn * FLASHLOAN_FEE_BPS) / 10000n; // 0.09% of loan

        const minProfitLamports = BigInt(Math.ceil((minProfitUsd / solPrice) * 1e9));
        const totalCosts        = jitoTip + txFee + flashloanFee;

        // Guard: spread must exceed slippage tolerance on both legs, otherwise Jupiter
        // will revert with SlippageToleranceExceeded (0x1788) if price ticks even slightly.
        // Require spread > 2× slippage so the net profit survives worst-case slippage.
        const slippageBps      = parseInt(process.env.SLIPPAGE_BPS || this.config.SLIPPAGE_BPS || '50');
        const minSpreadLamports = BigInt(Math.ceil(Number(amountIn) * (slippageBps * 2) / 10000));
        if (grossProfit <= minSpreadLamports) return false;

        return grossProfit > minProfitLamports + totalCosts;
    }

    // -------------------------------------------------------
    //  GET JUPITER SWAP INSTRUCTIONS  (not full tx)
    //  wrapAndUnwrapSol: false because wSOL comes from MarginFi borrow
    //  prioritizationFeeLamports omitted — Jito tip handles ordering,
    //  and including it adds a SetComputeUnitPrice ix that wastes tx bytes.
    // -------------------------------------------------------
    async _getSwapInstructions(quoteResponse) {
        const slippageBps = parseInt(process.env.SLIPPAGE_BPS || this.config.SLIPPAGE_BPS || '50');
        const params = {
            quoteResponse,
            userPublicKey:           this.wallet.publicKey.toString(),
            wrapAndUnwrapSol:        false,   // wSOL is managed by MarginFi borrow/repay
            dynamicComputeUnitLimit: true,
            slippageBps,
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
        const results = await Promise.all(
            addresses.map(addr =>
                this.connection
                    .getAddressLookupTable(new PublicKey(addr))
                    .then(r => r.value)
                    .catch(() => null)
            )
        );
        return results.filter(Boolean);
    }

    // -------------------------------------------------------
    //  SUBMIT VIA JITO BUNDLE
    // -------------------------------------------------------
    async _submitJitoBundle(serializedTxs) {
        try {
            const res = await axios.post(JITO_BUNDLE_URL, {
                jsonrpc: '2.0',
                id:      1,
                method:  'sendBundle',
                params:  [serializedTxs],
            }, { timeout: 3000 });
            return res.data.result;
        } catch (e) {
            const detail = e.response?.data?.error?.message || e.response?.data?.message || e.message;
            logger.warn(`[Executor] Jito bundle failed: ${detail}`);
            return null;
        }
    }

    // -------------------------------------------------------
    //  EXECUTE FLASHLOAN ARB
    //  Called by bot.js when an opportunity is found.
    // -------------------------------------------------------
    async execute(opportunity) {
        const { grossProfit, bestBuyQuote, reverseQuote, pair, amountIn } = opportunity;

        if (!this.mfiAccount) {
            logger.error('[Executor] MarginFi account not initialized — call init() first');
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
            const [borrowWrapper, repayWrapper] = this._buildMfiIxs(amountLamports);

            // ── Steps 2+blockhash [PARALLEL] ────────────────────────────
            //  Jupiter swap ixs and blockhash have no mutual dependencies.
            const [
                [buyIxData, sellIxData],
                { blockhash, lastValidBlockHeight: _lvbh },
            ] = await Promise.all([
                Promise.all([
                    this._getSwapInstructions(bestBuyQuote),
                    this._getSwapInstructions(reverseQuote),
                ]),
                this.connection.getLatestBlockhash('confirmed'),
            ]);

            // ── Step 3: Collect address lookup tables ─────────────────
            const lutAddresses = [
                ...(buyIxData.addressLookupTableAddresses  || []),
                ...(sellIxData.addressLookupTableAddresses || []),
            ];
            const lookupTables = await this._loadLookupTables([...new Set(lutAddresses)]);

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

            // Jito tip instruction — required for bundle acceptance
            const jitoTipLamports = BigInt(process.env.JITO_TIP_LAMPORTS || '50000');
            const jitoTipAccount  = new PublicKey(
                JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
            );
            const jitoTipIx = SystemProgram.transfer({
                fromPubkey: this.wallet.publicKey,
                toPubkey:   jitoTipAccount,
                lamports:   jitoTipLamports,
            });

            const innerIxs = [
                jitoTipIx,
                ...(borrowWrapper.instructions || []),
                ...computeBudgetIxs,
                ...buySetupIxs,
                ...(buyIxData.tokenLedgerInstruction ? [this._deserializeIx(buyIxData.tokenLedgerInstruction)] : []),
                this._deserializeIx(buyIxData.swapInstruction),
                ...(buyIxData.cleanupInstruction  ? [this._deserializeIx(buyIxData.cleanupInstruction)] : []),
                ...sellSetupIxs,
                ...(sellIxData.tokenLedgerInstruction ? [this._deserializeIx(sellIxData.tokenLedgerInstruction)] : []),
                this._deserializeIx(sellIxData.swapInstruction),
                ...(sellIxData.cleanupInstruction ? [this._deserializeIx(sellIxData.cleanupInstruction)] : []),
                ...(repayWrapper.instructions || []),
            ];

            // ── Step 5: Build flashloan tx (MarginFi adds begin/end) ──
            // blockhash already fetched in parallel with steps 1+2 above
            const flashTx = await this.mfiAccount.buildFlashLoanTx({
                ixs:                        innerIxs,
                addressLookupTableAccounts: lookupTables,
                blockhash,
            });

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

            // ── Step 7: Submit via Jito ───────────────────────────────
            const serialized = serializedBuf.toString('base64');
            const bundleId   = await this._submitJitoBundle([serialized]);

            if (bundleId) {
                this.stats.txSent++;
                // Bundle accepted by Jito — treat as success (bundle ID = commitment)
                this.stats.txSuccess++;
                this.stats.totalProfit += grossProfit;
                logger.info(`✅ FLASHLOAN SENT | Profit: ~$${profitUsd} | Bundle: ${bundleId}`);
                discord.alertTrade(profitUsd, pair.name, bundleId).catch(() => {});
                return true;
            }

            // Fallback: direct submission if Jito unavailable
            // Re-fetch blockhash + re-sign — the Jito attempt consumed up to 3s so the
            // original blockhash may be aged and the quote is closer to expiry.
            discord.alertJitoFallback(pair.name).catch(() => {});
            const { blockhash: freshBlockhash, lastValidBlockHeight } =
                await this.connection.getLatestBlockhash('confirmed');
            flashTx.message.recentBlockhash = freshBlockhash;
            flashTx.sign([this.wallet]);

            const sig = await this.connection.sendRawTransaction(flashTx.serialize(), {
                skipPreflight: true,  // skip RPC simulation — saves ~80ms, tx validated on-chain
                maxRetries:    parseInt(process.env.MAX_RETRIES || '3'),
            });
            this.stats.txSent++;
            logger.info(`[Executor] Direct tx sent: ${sig} — awaiting confirmation...`);

            try {
                const result = await this.connection.confirmTransaction(
                    { signature: sig, blockhash: freshBlockhash, lastValidBlockHeight },
                    'confirmed'
                );
                if (result.value.err) {
                    const reason = JSON.stringify(result.value.err);
                    logger.error(`[Executor] Direct tx failed on-chain: ${reason}`);
                    discord.alertTxFailed(pair.name, reason).catch(() => {});
                    return false;
                }
                this.stats.txSuccess++;
                this.stats.totalProfit += grossProfit;
                logger.info(`✅ FLASHLOAN TX confirmed (direct): ${sig} | Profit: ~$${profitUsd}`);
                discord.alertTrade(profitUsd, pair.name, sig).catch(() => {});
                return true;
            } catch (confirmErr) {
                logger.error(`[Executor] Direct tx confirmation failed: ${confirmErr.message}`);
                discord.alertTxFailed(pair.name, confirmErr.message).catch(() => {});
                return false;
            }

        } catch (e) {
            logger.error(`[Executor] Execution error: ${e.message}`);
            discord.alertError(`Flashloan failed: ${e.message}`).catch(() => {});
            return false;
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
