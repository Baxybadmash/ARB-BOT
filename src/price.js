// src/price.js
// ============================================================
//  LIVE SOL/USD PRICE via Binance WebSocket aggTrade stream
//  Updates on every trade (~50ms delay, multiple times/sec).
//  Falls back to HTTP (Birdeye → CoinGecko) if WS is down.
// ============================================================
const axios  = require('axios');
const WebSocket = require('ws');
const logger = require('./logger');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BINANCE_WS = 'wss://stream.binance.com:9443/ws/solusdt@aggTrade';
const HTTP_FALLBACK_INTERVAL_MS = 30 * 1000; // poll every 30s when WS is down

let _price     = parseFloat(process.env.SOL_PRICE_USD || '90');
let _wsActive  = false;
let _ws        = null;
let _fallbackTimer = null;

// -------------------------------------------------------
//  HTTP FALLBACK  (Birdeye → CoinGecko)
// -------------------------------------------------------
async function _fetchHttp() {
    // Try Birdeye first
    if (process.env.BIRDEYE_API_KEY && process.env.BIRDEYE_API_KEY !== 'public') {
        try {
            const res = await axios.get(
                `https://public-api.birdeye.so/defi/price?address=${SOL_MINT}`,
                {
                    headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY, 'x-chain': 'solana' },
                    timeout: 4000
                }
            );
            const price = res.data?.data?.value;
            if (price > 0) return parseFloat(price);
        } catch { /* fall through */ }
    }

    // CoinGecko
    const res = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
        { timeout: 4000 }
    );
    const price = res.data?.solana?.usd;
    if (price > 0) return parseFloat(price);
    return null;
}

// -------------------------------------------------------
//  WEBSOCKET STREAM
// -------------------------------------------------------
let _reconnectDelay = 5000; // starts at 5s, doubles on each failure, caps at 60s

function _startWebSocket() {
    if (_ws) {
        try { _ws.terminate(); } catch { /* ignore */ }
    }

    _ws = new WebSocket(BINANCE_WS);

    _ws.on('open', () => {
        _wsActive = true;
        _reconnectDelay = 5000; // reset backoff on successful connect
        logger.info('[Price] ✅ Binance WS connected — SOL/USD updating in real-time');
        if (_fallbackTimer) { clearInterval(_fallbackTimer); _fallbackTimer = null; }
    });

    _ws.on('message', (data) => {
        try {
            const trade = JSON.parse(data);
            const p = parseFloat(trade.p);
            if (p > 0) _price = p;
        } catch { /* ignore malformed */ }
    });

    _ws.on('close', () => {
        _wsActive = false;
        logger.warn(`[Price] Binance WS closed — reconnecting in ${_reconnectDelay / 1000}s`);
        _startFallbackPolling();
        setTimeout(_startWebSocket, _reconnectDelay);
        _reconnectDelay = Math.min(_reconnectDelay * 2, 60000); // exponential backoff, cap 60s
    });

    _ws.on('error', (e) => {
        _wsActive = false;
        logger.warn(`[Price] Binance WS error: ${e.message}`);
        // close event fires after error and handles reconnect
    });
}

function _startFallbackPolling() {
    if (_fallbackTimer) return; // already polling
    _fallbackTimer = setInterval(async () => {
        if (_wsActive) { clearInterval(_fallbackTimer); _fallbackTimer = null; return; }
        try {
            const price = await _fetchHttp();
            if (price) {
                _price = price;
                logger.debug(`[Price] HTTP fallback: SOL/USD = $${_price.toFixed(2)}`);
            }
        } catch (e) {
            logger.debug(`[Price] HTTP fallback failed: ${e.message}`);
        }
    }, HTTP_FALLBACK_INTERVAL_MS);
}

// -------------------------------------------------------
//  PUBLIC API
// -------------------------------------------------------

// Call once on bot startup — starts the WS stream
function initPriceStream() {
    // Seed with a live HTTP fetch immediately so price is accurate before first WS message
    _fetchHttp().then(p => {
        if (p) { _price = p; logger.info(`[Price] Seeded SOL/USD = $${_price.toFixed(2)}`); }
    }).catch(() => {});

    _startWebSocket();
}

// Returns the current cached price (always near real-time when WS is active)
function getSolPrice() {
    return _price;
}

module.exports = { getSolPrice, initPriceStream };
