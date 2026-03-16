// src/benchmark.js
// ============================================================
//  TIMING BENCHMARK — measures every stage of the critical path
//  No transactions are submitted.
//  Run: node src/benchmark.js
// ============================================================
require('dotenv').config();

const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
        TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
const { MarginfiClient, MarginfiAccountWrapper, getConfig } = require('@mrgnlabs/marginfi-client-v2');
const { NodeWallet } = require('@mrgnlabs/mrgn-common');
const axios  = require('axios');
const bs58   = require('bs58');
const fs     = require('fs');
const path   = require('path');

const SOL_MINT    = 'So11111111111111111111111111111111111111112';
const SOL_BANK_PK = new PublicKey('CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh');
const JUPITER_QUOTE_API = process.env.JUPITER_API_KEY
    ? 'https://api.jup.ag/swap/v1/quote'
    : 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_API = 'https://lite-api.jup.ag/swap/v1';
const JITO_BUNDLE_URL  = `${process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.labs.io'}/api/v1/bundles`;

// ── Helpers ──────────────────────────────────────────────────
function t(label, ms) {
    const bar   = '█'.repeat(Math.min(Math.floor(ms / 10), 60));
    const grade = ms < 50 ? '🟢' : ms < 150 ? '🟡' : ms < 400 ? '🟠' : '🔴';
    console.log(`  ${grade} ${label.padEnd(42)} ${String(ms).padStart(5)}ms  ${bar}`);
}

async function time(fn) {
    const s = Date.now();
    const v = await fn();
    return { ms: Date.now() - s, value: v };
}

async function timeN(fn, n = 5) {
    const samples = [];
    for (let i = 0; i < n; i++) {
        const { ms, value } = await time(fn);
        samples.push(ms);
        if (i === 0 && !value) { console.log(`    (returned null — API/network issue)`); break; }
        await new Promise(r => setTimeout(r, 120)); // small gap between samples
    }
    return { avg: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length), min: Math.min(...samples), max: Math.max(...samples), samples };
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
    console.log('\n' + '═'.repeat(64));
    console.log('  SOLANA ARB BOT — CRITICAL PATH TIMING BENCHMARK');
    console.log('  No transactions will be submitted.');
    console.log('═'.repeat(64) + '\n');

    // ── Load wallet ──────────────────────────────────────────
    const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    console.log(`Wallet: ${wallet.publicKey.toString()}\n`);

    // ── 1. RPC Latency ───────────────────────────────────────
    console.log('━━ 1. RPC Latency (5 samples) ─────────────────────────────');
    const conn = new Connection(process.env.RPC_URL_PRIMARY, 'confirmed');

    const rpcSlot = await timeN(() => conn.getSlot());
    t('getSlot (avg)', rpcSlot.avg);
    console.log(`     min: ${rpcSlot.min}ms  max: ${rpcSlot.max}ms  samples: [${rpcSlot.samples.join(', ')}]ms\n`);

    const rpcBh = await timeN(() => conn.getLatestBlockhash('confirmed'));
    t('getLatestBlockhash (avg)', rpcBh.avg);
    console.log(`     min: ${rpcBh.min}ms  max: ${rpcBh.max}ms\n`);

    // ── 2. Jupiter Quote API ─────────────────────────────────
    console.log('━━ 2. Jupiter Quote API (5 samples — SOL→USDT 1 SOL) ──────');
    const quoteParams = {
        inputMint:  SOL_MINT,
        outputMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        amount:     1_000_000_000, // 1 SOL
        slippageBps: 50,
        maxAccounts: parseInt(process.env.JUPITER_MAX_ACCOUNTS || '14'),
    };
    const headers = process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {};

    let buyQuote = null;
    const jupQuote = await timeN(async () => {
        const r = await axios.get(JUPITER_QUOTE_API, { params: quoteParams, headers, timeout: 5000 });
        buyQuote = r.data;
        return r.data;
    });
    t('single quote call (avg)', jupQuote.avg);
    console.log(`     min: ${jupQuote.min}ms  max: ${jupQuote.max}ms\n`);

    // 2 calls in sequence (Phase 1 buy probe + Phase 2 sell probe = 1 scanPair)
    let sellQuote = null;
    const scanPairMs = await time(async () => {
        const r1 = await axios.get(JUPITER_QUOTE_API, { params: quoteParams, headers, timeout: 5000 });
        buyQuote = r1.data;
        const r2 = await axios.get(JUPITER_QUOTE_API, {
            params: { inputMint: quoteParams.outputMint, outputMint: SOL_MINT,
                      amount: r1.data.outAmount, slippageBps: 50, maxAccounts: quoteParams.maxAccounts },
            headers, timeout: 5000,
        });
        sellQuote = r2.data;
        return sellQuote;
    });
    t('2 sequential quotes (1 pair scan)', scanPairMs.ms);
    console.log(`     (×5 pairs = ~${scanPairMs.ms * 5}ms fallback scan estimate)\n`);

    // ── 3. Jupiter Swap Instructions API ────────────────────
    console.log('━━ 3. Jupiter Swap Instructions API ───────────────────────');
    if (!buyQuote || !sellQuote) {
        console.log('  Skipped — quote failed above\n');
    } else {
        const swapParams = (quote) => ({
            quoteResponse:           quote,
            userPublicKey:           wallet.publicKey.toString(),
            wrapAndUnwrapSol:        false,
            dynamicComputeUnitLimit: true,
            slippageBps:             50,
        });

        let buyIxData = null, sellIxData = null;

        const buyIx = await time(async () => {
            const r = await axios.post(`${JUPITER_SWAP_API}/swap-instructions`, swapParams(buyQuote), { timeout: 6000 });
            buyIxData = r.data;
            return r.data;
        });
        t('swap-instructions buy leg', buyIx.ms);

        const sellIx = await time(async () => {
            const r = await axios.post(`${JUPITER_SWAP_API}/swap-instructions`, swapParams(sellQuote), { timeout: 6000 });
            sellIxData = r.data;
            return r.data;
        });
        t('swap-instructions sell leg', sellIx.ms);

        const bothIx = await time(async () => {
            const [b, s] = await Promise.all([
                axios.post(`${JUPITER_SWAP_API}/swap-instructions`, swapParams(buyQuote), { timeout: 6000 }),
                axios.post(`${JUPITER_SWAP_API}/swap-instructions`, swapParams(sellQuote), { timeout: 6000 }),
            ]);
            buyIxData  = b.data;
            sellIxData = s.data;
        });
        t('swap-instructions both legs (parallel)', bothIx.ms);
        console.log(`     (saved ~${buyIx.ms + sellIx.ms - bothIx.ms}ms vs sequential)\n`);

        // ── 4. MarginFi Init ─────────────────────────────────
        console.log('━━ 4. MarginFi Client Init ─────────────────────────────');
        const mfiConn = new Connection(process.env.RPC_URL_SECONDARY || process.env.RPC_URL_PRIMARY, 'confirmed');
        const nodeWallet = new NodeWallet(wallet);
        const mfiConfig  = getConfig('production');

        let mfiClient = null;
        const mfiInit = await time(async () => {
            mfiClient = await MarginfiClient.fetch(mfiConfig, nodeWallet, mfiConn, {
                preloadedBankAddresses: [SOL_BANK_PK],
            });
        });
        t('MarginFi client fetch (startup only)', mfiInit.ms);

        // ── 5. MarginFi Account Load ─────────────────────────
        console.log('\n━━ 5. MarginFi Account Load ────────────────────────────');
        const MFI_ACCOUNT_FILE = path.join(__dirname, '..', 'data', 'marginfi_account.json');
        let mfiAccount = null;

        if (!fs.existsSync(MFI_ACCOUNT_FILE)) {
            console.log('  No saved account — skipping MFI account timing (run bot once first)\n');
        } else {
            const saved = JSON.parse(fs.readFileSync(MFI_ACCOUNT_FILE, 'utf8'));
            const mfiLoad = await time(async () => {
                mfiAccount = await MarginfiAccountWrapper.fetch(new PublicKey(saved.address), mfiClient);
            });
            t('MarginFi account fetch (startup only)', mfiLoad.ms);
            console.log(`     account: ${saved.address}\n`);

            // ── 6. MFI Borrow/Repay Instructions ────────────────
            console.log('━━ 6. MarginFi makeBorrowIx + makeRepayIx ──────────────');
            const loanSol = 10;

            // Without override (Anchor resolves accounts via RPC — slow path)
            const borrowIx = await time(() => mfiAccount.makeBorrowIx(loanSol, SOL_BANK_PK));
            t('makeBorrowIx  (no override — Anchor resolves)', borrowIx.ms);

            const repayIx = await time(() => mfiAccount.makeRepayIx(loanSol, SOL_BANK_PK, true));
            t('makeRepayIx   (no override — Anchor resolves)', repayIx.ms);

            // With override (fully CPU — no RPC)
            const solBankObj = mfiClient.banks.get(SOL_BANK_PK.toBase58());
            const mfiOpts = { overrideInferAccounts: {
                authority:      wallet.publicKey,
                group:          mfiClient.config.groupPk,
                liquidityVault: solBankObj?.liquidityVault,
            }};

            const borrowIxFast = await time(() => mfiAccount.makeBorrowIx(loanSol, SOL_BANK_PK, mfiOpts));
            t('makeBorrowIx  (with override — CPU only)', borrowIxFast.ms);

            const repayIxFast = await time(() => mfiAccount.makeRepayIx(loanSol, SOL_BANK_PK, true, mfiOpts));
            t('makeRepayIx   (with override — CPU only)', repayIxFast.ms);

            const bothMfi = await time(() => Promise.all([
                mfiAccount.makeBorrowIx(loanSol, SOL_BANK_PK, mfiOpts),
                mfiAccount.makeRepayIx(loanSol, SOL_BANK_PK, true, mfiOpts),
            ]));
            t('borrow + repay (parallel, with override)', bothMfi.ms);
            console.log(`     saved vs old sequential: ~${borrowIx.ms + repayIx.ms - bothMfi.ms}ms\n`);

            // ── 7. Instruction cache (new approach) + new parallel block ─
            console.log('━━ 7. MFI Instruction Cache + New Parallel Block ──────────');

            // Build templates once (startup cost)
            const { TransactionInstruction: TxIx } = require('@solana/web3.js');
            const BORROW_DISC = Buffer.from([0x04, 0x7e, 0x74, 0x35, 0x30, 0x05, 0xd4, 0x1f]);
            const REPAY_DISC  = Buffer.from([0x4f, 0xd1, 0xac, 0xb1, 0xde, 0x33, 0xad, 0x97]);

            const [bt, rt] = await Promise.all([
                mfiAccount.makeBorrowIx(loanSol, SOL_BANK_PK, mfiOpts),
                mfiAccount.makeRepayIx(loanSol, SOL_BANK_PK, true, mfiOpts),
            ]);
            const borrowTmpl = bt.instructions.map(ix => ({ programId: ix.programId, keys: ix.keys, data: Buffer.from(ix.data) }));
            const repayTmpl  = rt.instructions.map(ix => ({ programId: ix.programId, keys: ix.keys, data: Buffer.from(ix.data) }));

            function buildMfiIxs(amountLamports) {
                const amt = BigInt(amountLamports);
                const patch = (tmpl) => tmpl.map(ix => {
                    const d = Buffer.from(ix.data);
                    if (d.length === 16 && d.subarray(0,8).equals(BORROW_DISC)) d.writeBigUInt64LE(amt, 8);
                    else if (d.length === 18 && d.subarray(0,8).equals(REPAY_DISC))  d.writeBigUInt64LE(amt, 8);
                    else if (d.length === 12 && d.readUInt32LE(0) === 2)              d.writeBigUInt64LE(amt + 10000n, 4);
                    return new TxIx({ programId: ix.programId, keys: ix.keys, data: d });
                });
                return [{ instructions: patch(borrowTmpl) }, { instructions: patch(repayTmpl) }];
            }

            // Per-trade MFI ix build (cached — CPU only)
            const mfiCached = await time(() => { buildMfiIxs(10_000_000_000); });
            t('_buildMfiIxs per trade (cached — CPU only)', mfiCached.ms);

            // New parallel block: only swap ixs + blockhash (MFI is now instant)
            const newParallel = await time(async () => {
                await Promise.all([
                    Promise.all([
                        axios.post(`${JUPITER_SWAP_API}/swap-instructions`, swapParams(buyQuote), { timeout: 6000 }),
                        axios.post(`${JUPITER_SWAP_API}/swap-instructions`, swapParams(sellQuote), { timeout: 6000 }),
                    ]),
                    conn.getLatestBlockhash('confirmed'),
                ]);
            });
            t('New parallel block: swap ixs + blockhash', newParallel.ms);

            const oldParallelAll = await time(async () => {
                await Promise.all([
                    Promise.all([
                        mfiAccount.makeBorrowIx(loanSol, SOL_BANK_PK, mfiOpts),
                        mfiAccount.makeRepayIx(loanSol, SOL_BANK_PK, true, mfiOpts),
                    ]),
                    Promise.all([
                        axios.post(`${JUPITER_SWAP_API}/swap-instructions`, swapParams(buyQuote), { timeout: 6000 }),
                        axios.post(`${JUPITER_SWAP_API}/swap-instructions`, swapParams(sellQuote), { timeout: 6000 }),
                    ]),
                    conn.getLatestBlockhash('confirmed'),
                ]);
            });
            t('Old parallel block (all 3, for comparison)', oldParallelAll.ms);
            console.log(`     saved ~${oldParallelAll.ms - newParallel.ms}ms by removing MFI from parallel block\n`);

            // ── 8. Address Lookup Tables ─────────────────────────
            console.log('━━ 8. Address Lookup Table Loading ─────────────────────');
            const lutAddrs = [
                ...(buyIxData?.addressLookupTableAddresses  || []),
                ...(sellIxData?.addressLookupTableAddresses || []),
            ];
            const uniqueLuts = [...new Set(lutAddrs)];

            if (uniqueLuts.length === 0) {
                console.log('  No LUT addresses in this quote — skipping\n');
            } else {
                const lutLoad = await time(async () => {
                    await Promise.all(uniqueLuts.map(addr =>
                        conn.getAddressLookupTable(new PublicKey(addr)).catch(() => null)
                    ));
                });
                t(`LUT load (${uniqueLuts.length} tables, parallel)`, lutLoad.ms);
                console.log();
            }

            // ── 9. Tx Build + Sign + Serialize ──────────────────
            console.log('━━ 9. Transaction Build + Sign + Serialize ─────────────');
            const { blockhash } = await conn.getLatestBlockhash('confirmed');
            const [borrowWrapper, repayWrapper] = await Promise.all([
                mfiAccount.makeBorrowIx(loanSol, SOL_BANK_PK, mfiOpts),
                mfiAccount.makeRepayIx(loanSol, SOL_BANK_PK, true, mfiOpts),
            ]);
            const luts = await Promise.all(uniqueLuts.map(addr =>
                conn.getAddressLookupTable(new PublicKey(addr)).then(r => r.value).catch(() => null)
            )).then(r => r.filter(Boolean));

            const deserializeIx = (raw) => {
                const { TransactionInstruction } = require('@solana/web3.js');
                return new TransactionInstruction({
                    programId: new PublicKey(raw.programId),
                    keys: raw.accounts.map(k => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
                    data: Buffer.from(raw.data, 'base64'),
                });
            };

            const innerIxs = [
                SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'), lamports: 150000n }),
                ...(borrowWrapper.instructions || []),
                ...(buyIxData?.computeBudgetInstructions  || []).map(deserializeIx),
                ...(buyIxData?.setupInstructions          || []).map(deserializeIx),
                deserializeIx(buyIxData.swapInstruction),
                ...(sellIxData?.setupInstructions         || []).map(deserializeIx),
                deserializeIx(sellIxData.swapInstruction),
                ...(repayWrapper.instructions             || []),
            ];

            let flashTx = null;
            const txBuild = await time(async () => {
                flashTx = await mfiAccount.buildFlashLoanTx({
                    ixs: innerIxs,
                    addressLookupTableAccounts: luts,
                    blockhash,
                });
            });
            t('buildFlashLoanTx', txBuild.ms);

            const txSign = await time(() => { flashTx.sign([wallet]); });
            t('sign', txSign.ms);

            let serializedBuf;
            const txSerialize = await time(() => { serializedBuf = Buffer.from(flashTx.serialize()); });
            t('serialize', txSerialize.ms);
            console.log(`     Tx size: ${serializedBuf?.length ?? '?'} bytes (limit 1232)\n`);
        }
    }

    // ── 10. Jito Bundle HTTP (no payload — just connection timing) ──
    console.log('━━ 10. Jito Bundle Submission (HTTP timing only) ───────────');
    const jitoReachability = await time(async () => {
        try {
            // Send an intentionally malformed bundle — we just want HTTP connection time
            await axios.post(JITO_BUNDLE_URL, { jsonrpc:'2.0', id:1, method:'sendBundle', params:[[]] },
                { timeout: 4000 });
        } catch (e) {
            // Expected to fail — we only care about the HTTP round-trip time
            return e.response?.status || 'timeout';
        }
    });
    t('Jito HTTP round-trip (Frankfurt)', jitoReachability.ms);
    console.log();

    // ── 11. Critical Path Summary ────────────────────────────
    console.log('━━ 11. CRITICAL PATH ESTIMATE (WS trigger → tx sent) ──────');
    const rpc  = rpcBh.avg;
    const jq   = jupQuote.avg;
    const si   = Math.round((jupQuote.avg * 2) * 0.6); // parallel pair, ~60% of sequential
    const jito = jitoReachability.ms;

    const pathRows = [
        ['WS callback fires (pool swap event)',       '~0ms',      '(already waiting)'],
        ['WS debounce check',                         '<1ms',      '(in-memory)'],
        ['Jupiter: 2 quote calls (sequential)',       `~${jq * 2}ms`, `(${jq}ms each)`],
        ['_buildMfiIxs (cached template patch)',      '~0ms',      '(CPU only — no RPC)'],
        ['Parallel: swap ixs + blockhash',            `~${Math.max(rpc, si)}ms`, '(longest branch wins)'],
        ['LUT load',                                  `~${rpc}ms`, '(parallel RPC calls)'],
        ['buildFlashLoanTx + sign + serialize',       '~5ms',      '(CPU only)'],
        ['Jito bundle HTTP',                          `~${jito}ms`, '(network to Frankfurt)'],
        ['─────────────────────────────────────────────', '───────', '──────────────────'],
        ['TOTAL (WS trigger → Jito accepted)',        `~${jq * 2 + Math.max(rpc, si) + rpc + 5 + jito}ms`, ''],
    ];

    for (const [label, val, note] of pathRows) {
        console.log(`  ${label.padEnd(46)} ${val.padStart(8)}  ${note}`);
    }

    console.log('\n  For fallback (slot polling) add:');
    console.log(`    Slot polling interval (~${parseInt(process.env.SCAN_EVERY_N_SLOTS || '15') + 2} slots × 400ms) = ~${(parseInt(process.env.SCAN_EVERY_N_SLOTS || '15') + 2) * 400}ms`);
    console.log(`    Full scan time (5 pairs × ~${jq * 2}ms + queue delay)  = ~${jq * 2 * 5}ms`);
    console.log();
    console.log('━━ Done ─────────────────────────────────────────────────────\n');
}

main().catch(e => {
    console.error('\n❌ Benchmark error:', e.message);
    if (e.response?.data) console.error('API response:', JSON.stringify(e.response.data).slice(0, 300));
    process.exit(1);
});
