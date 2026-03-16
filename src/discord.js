const https  = require('https');
const logger = require('./logger');

let webhookUrl   = null;
let txWebhookUrl = null;   // optional separate channel for tx logs

function init() {
    if (!process.env.DISCORD_WEBHOOK_URL) {
        logger.info('Discord alerts disabled');
        return;
    }
    webhookUrl   = process.env.DISCORD_WEBHOOK_URL;
    txWebhookUrl = process.env.DISCORD_TX_WEBHOOK_URL || webhookUrl;
    logger.info('✅ Discord alerts enabled');
    if (process.env.DISCORD_TX_WEBHOOK_URL) {
        logger.info('✅ Discord tx-log channel enabled');
    }
}

async function _post(url, content) {
    if (!url) return;
    const body = JSON.stringify({ content });
    const parsed = new URL(url);
    const request = new Promise((resolve) => {
        const req = https.request({
            hostname: parsed.hostname,
            path:     parsed.pathname + parsed.search,
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => { res.resume(); resolve(); });
        req.on('error', (e) => { logger.warn('Discord send failed: ' + e.message); req.destroy(); resolve(); });
        req.write(body);
        req.end();
    });
    await Promise.race([request, new Promise(r => setTimeout(r, 2000))]);
}

// General alerts → main webhook
async function send(content)   { await _post(webhookUrl, content); }
// Tx-specific alerts → tx webhook (falls back to main if no separate one)
async function sendTx(content) { await _post(txWebhookUrl, content); }

const _istFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'medium' });
function _ist() { return _istFmt.format(new Date()) + ' IST'; }

// ── Existing alerts ──────────────────────────────────────────

async function alertTrade(profitUsd, pairName, ref) {
    await sendTx(
        `🟢 **ARB EXECUTED**\n` +
        `💰 Profit: **$${profitUsd} USD**\n` +
        `📈 Pair: ${pairName}\n` +
        `🔗 Ref: \`${ref}\`\n` +
        `⏱ ${_ist()}`
    );
}

async function alertError(error) {
    await send(`⚠️ **BOT ERROR**\n\`${error}\``);
}

async function alertStartup(walletAddress) {
    await send(`🚀 **Solana Arb Bot Started**\nWallet: \`${walletAddress}\`\n⏱ ${_ist()}`);
}

async function alertOffline() {
    await send(`🔴 **Solana Bot went offline**`);
}

// ── New tx-log alerts ────────────────────────────────────────

async function alertExecuting(pairName, spreadPct, loanSol, estimatedProfitUsd) {
    await sendTx(
        `🔵 **EXECUTING** — ${pairName}\n` +
        `📊 Spread: ${spreadPct}% | Loan: ${loanSol} SOL\n` +
        `💰 Est. Profit: ~$${estimatedProfitUsd}\n` +
        `⏱ ${_ist()}`
    );
}

async function alertBelowMinProfit(pairName, grossSol, grossUsd, minProfitUsd) {
    if (!process.env.DISCORD_VERBOSE) return;  // opt-in — can be noisy
    await sendTx(
        `⚪ **BELOW MIN PROFIT** — ${pairName}\n` +
        `💸 Gross: ${grossSol} SOL (~$${grossUsd}) | Min: $${minProfitUsd}\n` +
        `⏱ ${_ist()}`
    );
}

async function alertTxFailed(pairName, reason) {
    await sendTx(
        `🔴 **TX FAILED** — ${pairName}\n` +
        `❌ ${reason}\n` +
        `⏱ ${_ist()}`
    );
}

async function alertJitoFallback(pairName) {
    await sendTx(
        `🟡 **JITO REJECTED** — falling back to direct submit\n` +
        `📈 Pair: ${pairName}\n` +
        `⏱ ${_ist()}`
    );
}

module.exports = {
    init, send, sendTx,
    alertTrade, alertError, alertStartup, alertOffline,
    alertExecuting, alertBelowMinProfit, alertTxFailed, alertJitoFallback,
};
