const logger = require('./logger');
let bot = null, chatId = null;

function init() {
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
        logger.info('Telegram alerts disabled');
        return;
    }
    try {
        const TelegramBot = require('node-telegram-bot-api');
        bot    = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
        chatId = process.env.TELEGRAM_CHAT_ID;
        logger.info('✅ Telegram alerts enabled');
    } catch (e) { logger.warn('Telegram init failed: ' + e.message); }
}

async function send(msg) {
    if (!bot) return;
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000));
    try { await Promise.race([bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' }), timeout]); }
    catch (e) { logger.warn('Telegram send failed: ' + e.message); }
}

async function alertTrade(profitUsd, pairName, bundleId) {
    await send(`🟢 *ARB EXECUTED*\n💰 Profit: *$${profitUsd} USD*\n📈 Pair: ${pairName}\n🔗 Bundle: \`${bundleId}\`\n⏱ ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
}

async function alertError(error) {
    await send(`⚠️ *BOT ERROR*\n\`${error}\``);
}

async function alertStartup(walletAddress) {
    await send(`🚀 *Solana Arb Bot Started*\nWallet: \`${walletAddress}\`\n⏱ ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
}

async function alertOffline() {
    await send(`🔴 *Solana Bot went offline*`);
}

module.exports = { init, send, alertTrade, alertError, alertStartup, alertOffline };
