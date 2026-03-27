// src/bot.js
// ============================================================
//  SOLANA FLASHLOAN ARB BOT — Updated
//  - Scans every 3rd slot (Jupiter free tier safe)
//  - Monthly auto pair update via pairUpdater.js
//  - Hot-swaps pair list without restart
// ============================================================
require('dotenv').config();

const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const https = require('https');
const http  = require('http');
const bs58       = require('bs58');
const { PriceScanner, computeTargetLam }  = require('./scanner');
const localPools = require('./localPools');
const { Executor }                        = require('./executor');
const { updatePairs, isUpdateDue, getUpdateStatus } = require('./pairUpdater');
const { findOptimalLoanSize }                       = require('./loanSizer');
const { PoolWatcher }                               = require('./poolWatcher');
const logger                              = require('./logger');
const discord                             = require('./discord');
const { initPriceStream, getSolPrice }     = require('./price');

// -------------------------------------------------------
//  VALIDATE CONFIG
// -------------------------------------------------------
function validateConfig() {
    const required = ['WALLET_PRIVATE_KEY', 'RPC_URL_PRIMARY'];
    const missing  = required.filter(k => !process.env[k]);
    if (missing.length > 0) {
        logger.error(`Missing required config: ${missing.join(', ')}`);
        logger.error('Please copy .env.example to .env and fill in all values');
        process.exit(1);
    }
}

// -------------------------------------------------------
//  CONNECT RPC
// -------------------------------------------------------
async function createConnection() {
    // keepAlive agents prevent TCP+TLS re-handshake between RPC calls,
    // eliminating the ~400ms cold spike after idle periods.
    const keepAliveAgent = {
        httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 10 }),
        httpAgent:  new http.Agent({ keepAlive: true, maxSockets: 10 }),
    };
    const primary = new Connection(process.env.RPC_URL_PRIMARY, {
        commitment: 'confirmed',
        wsEndpoint: process.env.RPC_URL_WEBSOCKET,
        confirmTransactionInitialTimeout: 60000,
        fetchMiddleware: (url, options, fetch) => fetch(url, { ...options, agent: url.startsWith('https') ? keepAliveAgent.httpsAgent : keepAliveAgent.httpAgent }),
    });

    try {
        await primary.getSlot();
        logger.info(`✅ Connected to primary RPC (${process.env.RPC_URL_PRIMARY?.split('/')[2] ?? 'primary'})`);
        return primary;
    } catch (e) {
        logger.warn(`Primary RPC failed: ${e.message} — trying secondary...`);
        if (!process.env.RPC_URL_SECONDARY) {
            logger.error('No secondary RPC configured — exiting');
            process.exit(1);
        }
        const secondary = new Connection(process.env.RPC_URL_SECONDARY, 'confirmed');
        await secondary.getSlot();
        logger.info('✅ Connected to secondary RPC');
        return secondary;
    }
}

// -------------------------------------------------------
//  LOAD WALLET
// -------------------------------------------------------
function loadWallet() {
    try {
        const secretKey = bs58.decode(process.env.WALLET_PRIVATE_KEY);
        return Keypair.fromSecretKey(secretKey);
    } catch (e) {
        logger.error(`Invalid WALLET_PRIVATE_KEY: ${e.message}`);
        logger.error('Export from Phantom: Settings → Security → Export Private Key');
        process.exit(1);
    }
}

// -------------------------------------------------------
//  MONTHLY UPDATE SCHEDULER
//  Checks every hour if update is due, runs if so
// -------------------------------------------------------
function startUpdateScheduler(scanner, flashloanLamports, poolWatcher, wsCallback) {
    const CHECK_INTERVAL_MS = 60 * 60 * 1000; // check every hour

    const runIfDue = async () => {
        if (!isUpdateDue()) {
            const status = getUpdateStatus();
            logger.debug(`[Scheduler] Pair update not due. ${status.message}`);
            return;
        }

        logger.info('[Scheduler] Monthly pair update is due — starting...');

        try {
            await updatePairs(flashloanLamports, null, discord.send.bind(discord));
            scanner.reloadPairs(); // hot-swap pair list without restart
            await poolWatcher.resubscribe(scanner.activePairs, wsCallback); // resync WS subscriptions
            logger.info('[Scheduler] Pairs updated, reloaded, and WS resubscribed ✅');
        } catch (e) {
            logger.error(`[Scheduler] Pair update failed: ${e.message}`);
            await discord.alertError(`Monthly pair update failed: ${e.message}`);
        }
    };

    // Run once on startup (in case update was missed while bot was offline)
    setTimeout(runIfDue, 10000); // 10 second delay after startup

    // Then check every hour
    setInterval(runIfDue, CHECK_INTERVAL_MS);

    logger.info('[Scheduler] Monthly pair updater scheduled ✅');
}

// -------------------------------------------------------
//  MAIN BOT
// -------------------------------------------------------
async function startBot() {
    validateConfig();

    logger.info('═'.repeat(60));
    logger.info('  🤖 SOLANA FLASHLOAN ARB BOT — STARTING');
    logger.info('═'.repeat(60));

    discord.init();
    initPriceStream();

    const connection = await createConnection();
    const wallet     = loadWallet();
    const config     = {
        MARGINFI_GROUP:       process.env.MARGINFI_GROUP,
        MIN_PROFIT_USD:       parseFloat(process.env.MIN_PROFIT_USD || '1.5'),
        FLASHLOAN_AMOUNT_SOL: parseFloat(process.env.FLASHLOAN_AMOUNT_SOL || '100'),
        SLIPPAGE_BPS:         parseInt(process.env.SLIPPAGE_BPS || '50'),
    };

    // Check balance
    const balance    = await connection.getBalance(wallet.publicKey);
    const balSOL     = balance / LAMPORTS_PER_SOL;
    const minFlashloanLamports = Math.floor(parseFloat(process.env.MIN_FLASHLOAN_AMOUNT_SOL || '10') * LAMPORTS_PER_SOL);
    const flashloanLamports    = Math.floor(config.FLASHLOAN_AMOUNT_SOL * LAMPORTS_PER_SOL);

    logger.info(`Wallet:          ${wallet.publicKey.toString()}`);
    logger.info(`SOL Balance:     ${balSOL.toFixed(4)} SOL`);

    if (balSOL < 0.05) {
        logger.warn('⚠️  Low SOL balance! Need at least 0.05 SOL for gas.');
    }

    // Init scanner + executor
    const scanner  = new PriceScanner(connection);
    const executor = new Executor(connection, wallet, config);
    await executor.init(); // Connect to MarginFi, load/create flashloan account

    // Log active pairs
    logger.info('');
    logger.info(`Active pairs (${scanner.activePairs.length}):`);
    scanner.activePairs.forEach((p, i) => {
        const tag = p.isAnchor ? ' [anchor]' : '';
        logger.info(`  ${i + 1}. ${p.name}${tag}`);
    });

    // Log pair update status
    const updateStatus = getUpdateStatus();
    logger.info('');
    logger.info(`[Scheduler] ${updateStatus.message}`);
    logger.info('');

    // Scan rate info
    const scanEvery = parseInt(process.env.SCAN_EVERY_N_SLOTS || '3');
    logger.info(`Trigger:         WebSocket pool subscriptions (~50-100ms) + slot fallback every ${scanEvery + 2} slots`);
    logger.info(`Flashloan size:  ${parseFloat(process.env.MIN_FLASHLOAN_AMOUNT_SOL || '10')}–${config.FLASHLOAN_AMOUNT_SOL} SOL (dynamic)`);
    logger.info(`Min profit:      $${config.MIN_PROFIT_USD}`);
    logger.info('');

    await discord.alertStartup(wallet.publicKey.toString());

    let lastSlot     = 0;
    let lastSlotTime = Date.now();
    let isExecuting  = false;
    let isScanning   = false;   // prevents overlapping fallback full-scans (scan takes ~3.7s)
    const lastWsScan = new Map(); // pair.name → timestamp, prevents WS burst
    const WS_DEBOUNCE_MS = parseInt(process.env.WS_DEBOUNCE_MS || '200');  // min gap between WS scans of same pair

    // Shared execute helper — used by both WS trigger and slot fallback
    async function tryExecute(opportunities, label, triggerTime) {
        if (opportunities.length === 0) return;
        const best = opportunities[0];
        if (best.spreadPct < 0.00005 && best.loanSizeSol <= 1) return;
        if (isExecuting) {
            if (best.spreadPct >= 0.00005) logger.info(`[${label}] Blocked(locked): ${best.pair.name} spread=${best.priceDiffPct}%`);
            return;
        }
        isExecuting = true;
        try {
            let finalOpp = opportunities[0];
            executor.stats.oppsDetected++;
            logger.info(`[${label}] Detected: ${opportunities[0].pair.name} | spread: ${opportunities[0].priceDiffPct}% | loan: ${opportunities[0].loanSizeSol?.toFixed(1)} SOL`);

            // Re-quote at target loan size only when expected gross exceeds MIN_PROFIT_USD.
            // Skips the 2 extra API calls (~200ms) for sub-threshold spreads that the
            // executor will reject anyway, keeping detection latency at ~220ms.
            const targetLam = computeTargetLam(finalOpp.spreadPct, minFlashloanLamports, flashloanLamports);
            if (targetLam > Number(finalOpp.amountIn) * 1.5 && finalOpp.spreadPct > 0.0001) {
                const resized = await scanner.reSizeScan(finalOpp.pair, targetLam);
                if (resized) {
                    finalOpp = resized;
                } else {
                    logger.info(`[${label}] Skip(null): ${finalOpp.pair.name} spread=${(finalOpp.spreadPct*100).toFixed(4)}% target=${(targetLam/1e9).toFixed(1)}SOL`);
                    return;
                }
            }
            const scanMs = triggerTime ? Date.now() - triggerTime : null;
            logger.info(`[${label}] Opportunity: ${finalOpp.pair.name} | spread: ${finalOpp.priceDiffPct}% | loan: ${finalOpp.loanSizeSol?.toFixed(1)} SOL${scanMs !== null ? ` | scan: ${scanMs}ms` : ''}`);
            const execStart = Date.now();
            await executor.execute(finalOpp);
            const execMs = Date.now() - execStart;
            const totalMs = triggerTime ? Date.now() - triggerTime : null;
            logger.info(`[${label}] Latency — scan: ${scanMs ?? '?'}ms | exec: ${execMs}ms${totalMs !== null ? ` | total: ${totalMs}ms` : ''}`);
        } catch (e) {
            logger.error(`[${label}] Execution error: ${e.message}`);
        } finally {
            isExecuting = false;
        }
    }

    // -------------------------------------------------------
    //  PRIMARY: WebSocket pool account subscriptions (~50-100ms)
    //  Fires immediately when a pool swap changes reserves.
    // -------------------------------------------------------
    const lastJupiterCall = new Map();
    const JUPITER_COOLDOWN_MS = parseInt(process.env.JUPITER_COOLDOWN_MS || '3000');

    const wsCallback = async (pair, accountInfo, dex, poolAddress) => {
        const now = Date.now();
        if (now - (lastWsScan.get(pair.name) || 0) < WS_DEBOUNCE_MS) return;
        lastWsScan.set(pair.name, now);
        executor.stats.slotsScanned++;

        // ── LOCAL POOL MATH PRE-FILTER ──────────────────────────
        // For supported dexes: decode pool state locally, compute spread
        // vs Binance price. Skip Jupiter entirely if spread is too thin.
        const hasLocalMath = (dex === 'Orca' || dex === 'Raydium CLMM' || dex === 'Meteora') && (pair.name.endsWith('/USDC') || pair.name.endsWith('/USDT'))
            && accountInfo && accountInfo.data && poolAddress;

        if (hasLocalMath) {
            const state = localPools.updatePoolState(poolAddress, accountInfo.data, dex);
            if (state) {
                const refPrice = getSolPrice();
                if (refPrice > 0) {
                    const poolPrice = localPools.getPoolPrice(state);
                    if (poolPrice <= 0) return; // empty pool or decode error
                    const spreadPct = Math.abs(poolPrice - refPrice) / refPrice;

                    if (spreadPct < 0.0007) {
                        logger.debug(`[WS-Local] ${pair.name} spread=${(spreadPct*100).toFixed(4)}% < 0.07% — skip`);
                        return;
                    }
                    logger.info(`[WS-Local] ${pair.name} spread=${(spreadPct*100).toFixed(4)}% pool=$${poolPrice.toFixed(2)} ref=$${refPrice.toFixed(2)} dex=${dex}`);
                }
            }
            // If local math decode failed (no state), fall through to Jupiter as safety net
        }

        // ── JUPITER COOLDOWN — applies to ALL events reaching this point ──
        if (now - (lastJupiterCall.get(pair.name) || 0) < JUPITER_COOLDOWN_MS) return;
        lastJupiterCall.set(pair.name, now);

        // ── JUPITER SCAN ──
        try {
            logger.info(`[WS] ${pair.name} → Jupiter scan (dex=${dex})`);
            const opps = await scanner.findOpportunitiesForPair(pair, minFlashloanLamports, flashloanLamports);
            await tryExecute(opps, 'WS', now);
        } catch (e) {
            logger.debug(`[WS] Error: ${e.message}`);
        }
    };

    const poolWatcher = new PoolWatcher(connection);
    await poolWatcher.subscribe(scanner.activePairs, wsCallback);

    // Register Orca Whirlpool pools for local math pre-filtering
    let localCount = 0;
    for (const sub of poolWatcher.subscriptions) {
        if (sub.dex === 'Orca' || sub.dex === 'Raydium CLMM' || sub.dex === 'Meteora') {
            localPools.registerPool(sub.address, sub.pair, sub.dex);
            localCount++;
        }
    }
    logger.info('[LocalPools] Registered ' + localCount + ' pools (Orca + Raydium CLMM) for local math');

    // -------------------------------------------------------
    //  FALLBACK: Slot polling — catches pairs without WS subs
    //  Reduced to every 5 slots (~2s) since WS handles most.
    // -------------------------------------------------------
    const FALLBACK_EVERY_N = parseInt(process.env.SCAN_EVERY_N_SLOTS || '3') + 2;
    let fallbackCounter = 0;
    let subscriptionId  = null;

    function subscribeSlots() {
        if (subscriptionId !== null) {
            try { connection.removeSlotChangeListener(subscriptionId); } catch (_) {}
        }
        subscriptionId = connection.onSlotChange(async (slotInfo) => {
            const slot = slotInfo.slot;
            if (slot <= lastSlot) return;
            lastSlot     = slot;
            lastSlotTime = Date.now();

            fallbackCounter++;
            if (fallbackCounter % FALLBACK_EVERY_N !== 0) return;
            if (isExecuting || isScanning) return;

            if (fallbackCounter % (FALLBACK_EVERY_N * 100) === 0) executor.printStats().catch(() => {});

            isScanning = true;
            const fallbackStart = Date.now();
            try {
                logger.debug(`[Fallback] Slot ${slot} — full scan ${scanner.activePairs.length} pairs`);
                const opps = await scanner.findOpportunities(minFlashloanLamports, flashloanLamports);
                await tryExecute(opps, 'Fallback', fallbackStart);
            } catch (e) {
                logger.error(`[Fallback] Slot ${slot} error: ${e.message}`);
            } finally {
                isScanning = false;
            }
        });
    }

    subscribeSlots();

    // -------------------------------------------------------
    //  WATCHDOG: Reconnects slot subscription if WS drops
    //  Helius free-tier WS connections drop after ~5-10 mins.
    // -------------------------------------------------------
    const WATCHDOG_STALE_MS = 45_000; // no slot for 45s = dead connection
    setInterval(async () => {
        if (Date.now() - lastSlotTime < WATCHDOG_STALE_MS) return;
        logger.warn('[Watchdog] No slot received in 45s — reconnecting...');
        lastSlotTime = Date.now(); // reset before resubscribing to avoid double-trigger
        subscribeSlots();
        await poolWatcher.resubscribe(scanner.activePairs, wsCallback);
        logger.info('[Watchdog] Slot + pool WS resubscribed ✅');
        await discord.send('⚠️ **Watchdog**: WS dropped — auto-reconnected').catch(() => {});
    }, 30_000);

    // Start monthly pair update scheduler (now also resubscribes poolWatcher)
    startUpdateScheduler(scanner, flashloanLamports, poolWatcher, wsCallback);

    // Liveness heartbeat every 2 minutes — confirms bot is scanning even when market is flat
    let _lastHeartbeatSlots = 0;
    setInterval(() => {
        const slotDelta = executor.stats.slotsScanned - _lastHeartbeatSlots;
        _lastHeartbeatSlots = executor.stats.slotsScanned;
        logger.info(
            `💓 alive | slots +${slotDelta} | detected: ${executor.stats.oppsDetected} | attempted: ${executor.stats.oppsAttempted} | sent: ${executor.stats.txSent}`
        );
    }, 2 * 60 * 1000);

    // Stats + Discord heartbeat every 30 mins
    setInterval(async () => {
        executor.printStats().catch(() => {});
        const solPrice  = getSolPrice();
        const profitUsd = (Number(executor.stats.totalProfit) / 1e9 * solPrice).toFixed(2);
        await discord.send(
            `📊 **Stats (30-min)**\n` +
            `Slots: ${executor.stats.slotsScanned} | Detected: ${executor.stats.oppsDetected} | Attempted: ${executor.stats.oppsAttempted}\n` +
            `Sent: ${executor.stats.txSent} | Success: ${executor.stats.txSuccess} | Profit: ~$${profitUsd}`
        ).catch(() => {});
    }, 30 * 60 * 1000);

    // -------------------------------------------------------
    //  GRACEFUL SHUTDOWN
    // -------------------------------------------------------
    async function shutdown(signal) {
        logger.info(`\n${signal} received — shutting down...`);
        executor.printStats().catch(() => {});
        await poolWatcher.unsubscribeAll();
        if (subscriptionId !== null) {
            try { connection.removeSlotChangeListener(subscriptionId); } catch (_) {}
        }
        await discord.alertOffline();
        process.exit(0);
    }

    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    // Await alerts before exit so Telegram/Discord receive the message
    process.on('uncaughtException', async (e) => {
        logger.error(`Uncaught: ${e.message}`);
        await discord.alertError(e.message);
        process.exit(1);
    });
    process.on('unhandledRejection', (r) => { logger.error(`Unhandled rejection: ${r}`); });

    logger.info('✅ Bot is live. Press Ctrl+C to stop.\n');
}

startBot().catch(async (e) => {
    logger.error(`Fatal error: ${e.message}`);
    process.exit(1);
});
