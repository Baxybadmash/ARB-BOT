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
        this._borrowIxTemplate = borrowTemplate.instructions.map(ix => ({
            programId: ix.programId, keys: ix.keys, data: Buffer.from(ix.data),
        }));
        this._repayIxTemplate = repayTemplate.instructions.map(ix => ({
            programId: ix.programId, keys: ix.keys, data: Buffer.from(ix.data),
        }));
        logger.info('[Executor] MFI instruction templates cached ✅');

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
                data.writeBigUInt64LE(100000n, 4);
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
    async _getSwapInstructions(quoteResponse, slippageOverride = null) {
        const slippageBps = slippageOverride !== null
            ? slippageOverride
            : parseInt(process.env.SLIPPAGE_BPS || this.config.SLIPPAGE_BPS || '50');

        const params = {
            quoteResponse,
            userPublicKey:           this.wallet.publicKey.toString(),
            wrapAndUnwrapSol:        false,
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
            //  Blockhash is served from in-memory cache (refreshed every 500ms)
            //  so both swap-ix calls run with no RPC dependency alongside them.
            const { blockhash, lastValidBlockHeight } =
                this._blockhashCache || await this.connection.getLatestBlockhash('processed');

            const [buyIxData, sellIxData] = await Promise.all([
                this._getSwapInstructions(bestBuyQuote),
                this._getSwapInstructions(reverseQuote, 0),
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
            // Fetch fresh blockhash right before building tx — swap-ix calls take ~400ms
            // and the cached blockhash may be stale by the time we reach here.
            const freshBh = await this.connection.getLatestBlockhash('processed');
            const finalBlockhash = freshBh.blockhash;
            const finalLastValidBlockHeight = freshBh.lastValidBlockHeight;
            const flashTx = await this.mfiAccount.buildFlashLoanTx({
                ixs:                        innerIxs,
                addressLookupTableAccounts: lookupTables,
                blockhash:           finalBlockhash,
            });

            // ── Step 6: Sign ──────────────────────────────────────────
            flashTx.sign([this.wallet]);

            // ── Step 6b: Vote account diagnostic ──────────────────────
            // Jito rejects bundles that reference ANY vote account — even
            // read-only ALT entries. Check ALL accounts in the tx.
            try {
                const msg = flashTx.message;
                const numSigners    = msg.header.numRequiredSignatures;
                const numReadonlyS  = msg.header.numReadonlySignedAccounts;
                const numReadonlyU  = msg.header.numReadonlyUnsignedAccounts;
                const staticKeys    = msg.staticAccountKeys.map(k => k.toString());
                const totalStatic   = staticKeys.length;
                const writableSignerCount    = numSigners - numReadonlyS;
                const readonlyUnsignedStart  = totalStatic - numReadonlyU;

                const writableKeys = [];
                const readonlyKeys = [];
                for (let i = 0; i < totalStatic; i++) {
                    const isReadonlySigner   = (i >= writableSignerCount && i < numSigners);
                    const isReadonlyUnsigned = (i >= readonlyUnsignedStart);
                    if (!isReadonlySigner && !isReadonlyUnsigned) {
                        writableKeys.push(staticKeys[i]);
                    } else {
                        readonlyKeys.push(staticKeys[i]);
                    }
                }

                // Collect ALL accounts from ALT lookups (writable + readonly)
                const altWritableKeys = [];
                const altReadonlyKeys = [];
                if (msg.addressTableLookups) {
                    for (const lookup of msg.addressTableLookups) {
                        const table = lookupTables.find(t => t.key.equals(lookup.accountKey));
                        if (!table) continue;
                        const altAddr = lookup.accountKey.toString();
                        for (const idx of (lookup.writableIndexes || [])) {
                            const addr = table.state.addresses[idx];
                            if (addr) {
                                writableKeys.push(addr.toString());
                                altWritableKeys.push({ addr: addr.toString(), alt: altAddr.slice(0, 12), idx });
                            }
                        }
                        for (const idx of (lookup.readonlyIndexes || [])) {
                            const addr = table.state.addresses[idx];
                            if (addr) {
                                readonlyKeys.push(addr.toString());
                                altReadonlyKeys.push({ addr: addr.toString(), alt: altAddr.slice(0, 12), idx });
                            }
                        }
                    }
                }

                const allKeys = [...new Set([...writableKeys, ...readonlyKeys])];
                const altAddrs = (msg.addressTableLookups || []).map(l => l.accountKey.toString());
                logger.info(`[Executor] Tx accounts: ${writableKeys.length} writable + ${readonlyKeys.length} readonly = ${allKeys.length} unique | ${altAddrs.length} ALTs`);
                if (altAddrs.length > 0) {
                    logger.debug(`[Executor] ALT addresses: ${altAddrs.join(', ')}`);
                }

                // On-chain check: fetch owners of ALL accounts to find vote accounts
                if (allKeys.length > 0 && allKeys.length <= 200) {
                    try {
                        // Batch in groups of 100
                        const voteAccounts = [];
                        for (let b = 0; b < allKeys.length; b += 100) {
                            const batch = allKeys.slice(b, b + 100);
                            const infos = await this.connection.getMultipleAccountsInfo(
                                batch.map(k => new PublicKey(k)),
                                { commitment: 'confirmed' }
                            );
                            for (let i = 0; i < infos.length; i++) {
                                if (infos[i] && infos[i].owner.toString() === VOTE_PROGRAM_ID) {
                                    const key = batch[i];
                                    const isWritable = writableKeys.includes(key);
                                    const altEntry = [...altWritableKeys, ...altReadonlyKeys].find(e => e.addr === key);
                                    const source = altEntry
                                        ? `ALT ${altEntry.alt}... idx=${altEntry.idx} (${isWritable ? 'WRITABLE' : 'READONLY'})`
                                        : `static (${isWritable ? 'WRITABLE' : 'READONLY'})`;
                                    voteAccounts.push({ key, source });
                                }
                            }
                        }
                        if (voteAccounts.length > 0) {
                            for (const va of voteAccounts) {
                                logger.warn(`[Executor] ⚠️  VOTE ACCOUNT: ${va.key} | Source: ${va.source}`);
                            }
                            logger.warn(`[Executor] ${voteAccounts.length} vote account(s) found — Jito will reject. Pair: ${pair.name}`);
                        } else {
                            logger.info(`[Executor] ✅ No vote accounts in tx (${allKeys.length} checked)`);
                        }
                    } catch (voteCheckErr) {
                        logger.debug(`[Executor] Vote account on-chain check failed: ${voteCheckErr.message}`);
                    }
                } else {
                    logger.debug(`[Executor] Skipping vote check — ${allKeys.length} accounts (outside 1-200 range)`);
                }
            } catch (diagErr) {
                logger.debug(`[Executor] Vote diagnostic error: ${diagErr.message}`);
            }

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
            // ── Step 6c: Simulate before submission (~50ms) ─────────────
            // Catches bad trades instantly instead of wasting 30s on confirmation timeout.
            try {
                const simResult = await this.connection.simulateTransaction(flashTx, {
                    replaceRecentBlockhash: false,
                    sigVerify: false,
                });
                if (simResult.value.err) {
                    const errStr = JSON.stringify(simResult.value.err);
                    logger.warn(`[Executor] Simulation FAILED — skipping submission: ${errStr}`);
                    const logs = (simResult.value.logs || []).slice(-5).join(' | ');
                    logger.debug(`[Executor] Sim logs (last 5): ${logs}`);
                    this.stats.txFailed++;
                    return { success: false, reason: `sim-failed: ${errStr}` };
                }
                logger.debug(`[Executor] Simulation OK — CU used: ${simResult.value.unitsConsumed}`);
            } catch (simErr) {
                // RPC sim call itself failed (network issue) — proceed with submission anyway
                logger.warn(`[Executor] Simulation RPC error (proceeding): ${simErr.message}`);
            }

            // ── Step 7: Submit via Jito + direct RPC simultaneously ──────
            // Both fire with the same signed tx — on-chain it's idempotent (same sig).
            // Eliminates the old 3s Jito-wait before fallback. No re-sign needed.
            const serialized  = bs58.encode(serializedBuf);
            const jitoP       = this._submitJitoBundle([serialized]);
            const directP     = this.connection.sendRawTransaction(serializedBuf, {
                skipPreflight: true,
                maxRetries:    parseInt(process.env.MAX_RETRIES || '3'),
            }).catch(e => { logger.debug(`[Executor] Direct send error: ${e.message}`); return null; });

            const [bundleId, directSig] = await Promise.all([jitoP, directP]);
            this.stats.txSent++;

            // Always confirm on-chain via directSig — a Jito bundleId only means the bundle
            // was accepted by the block engine, NOT that it landed on-chain. The same signed
            // tx is sent via both paths so directSig confirms whichever path landed it.
            if (directSig) {
                if (!bundleId) {
                    discord.alertJitoFallback(pair.name).catch(() => {});
                }
                logger.info(`[Executor] Confirming tx on-chain: ${directSig}${bundleId ? ` (Jito bundle: ${bundleId})` : ''}`);
                try {
                    const confirmTimeout = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Confirmation timeout after 30s')), 30000)
                    );
                    const result = await Promise.race([
                        this.connection.confirmTransaction(
                            { signature: directSig, blockhash: finalBlockhash, lastValidBlockHeight: finalLastValidBlockHeight },
                            { commitment: 'confirmed', disableRetryOnRateLimit: true }
                        ),
                        confirmTimeout,
                    ]);
                    if (result.value.err) {
                        const reason = JSON.stringify(result.value.err);
                        logger.error(`[Executor] Tx failed on-chain: ${reason}`);
                        discord.alertTxFailed(pair.name, reason).catch(() => {});
                        return false;
                    }
                    this.stats.txSuccess++;
                    this.stats.totalProfit += grossProfit;
                    logger.info(`✅ FLASHLOAN confirmed | Profit: ~$${profitUsd} | Sig: ${directSig}${bundleId ? ` | Bundle: ${bundleId}` : ''}`);
                    discord.alertTrade(profitUsd, pair.name, directSig).catch(() => {});
                    return true;
                } catch (confirmErr) {
                    logger.error(`[Executor] Tx confirmation failed: ${confirmErr.message}`);
                    discord.alertTxFailed(pair.name, confirmErr.message).catch(() => {});
                    return false;
                }
            }

            // directSig unavailable (direct RPC rejected) but Jito may have accepted —
            // cannot confirm on-chain without a signature, so do not count as success.
            if (bundleId) {
                logger.warn(`[Executor] Jito bundle accepted (${bundleId}) but direct RPC rejected — cannot confirm on-chain`);
                return false;
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
