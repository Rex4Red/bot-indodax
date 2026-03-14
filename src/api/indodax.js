const crypto = require('crypto');
const https = require('https');
const http = require('http');

const BASE_URL = 'indodax.com';
const TAPI_PATH = '/tapi';
const PUBLIC_BASE = 'https://indodax.com';

let nonceCounter = Math.floor(Date.now() / 1000);

function createSignature(params, secretKey) {
    const queryString = Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
    return crypto
        .createHmac('sha512', secretKey)
        .update(queryString)
        .digest('hex');
}

function privateRequest(method, extraParams = {}) {
    const apiKey = process.env.INDODAX_API_KEY;
    const secretKey = process.env.INDODAX_SECRET_KEY;

    if (!apiKey || !secretKey) {
        throw new Error('API Key atau Secret Key belum dikonfigurasi di .env');
    }

    nonceCounter++;
    const params = {
        method,
        nonce: nonceCounter,
        ...extraParams
    };

    const body = Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join('&');

    const sign = crypto
        .createHmac('sha512', secretKey)
        .update(body)
        .digest('hex');

    return new Promise((resolve, reject) => {
        const options = {
            hostname: BASE_URL,
            path: TAPI_PATH,
            method: 'POST',
            headers: {
                'Key': apiKey,
                'Sign': sign,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.success === 1) {
                        resolve(parsed.return);
                    } else {
                        reject(new Error(parsed.error || 'Unknown API error'));
                    }
                } catch (e) {
                    reject(new Error('Failed to parse API response'));
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function publicRequest(path) {
    return new Promise((resolve, reject) => {
        https.get(`${PUBLIC_BASE}${path}`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Failed to parse public API response'));
                }
            });
        }).on('error', reject);
    });
}

// ====== Private API Methods ======

async function getInfo() {
    return privateRequest('getInfo');
}

async function trade(pair, type, price, amount, orderType = 'limit') {
    const coin = pair.split('_')[0]; // e.g., 'btc' from 'btc_idr'
    const params = { pair, type, price };

    if (orderType === 'market') {
        params.order_type = 'market';
        if (type === 'buy') {
            params.idr = amount;
        } else {
            params[coin] = amount;
        }
    } else {
        params.order_type = 'limit';
        if (type === 'buy') {
            params[coin] = amount;
        } else {
            params[coin] = amount;
        }
    }

    return privateRequest('trade', params);
}

async function openOrders(pair) {
    const params = pair ? { pair } : {};
    return privateRequest('openOrders', params);
}

async function cancelOrder(pair, orderId, type) {
    return privateRequest('cancelOrder', { pair, order_id: orderId, type });
}

async function tradeHistory(pair, count = 100) {
    return privateRequest('tradeHistory', { pair, count });
}

async function orderHistory(pair, count = 100) {
    return privateRequest('orderHistory', { pair, count });
}

async function getOrder(pair, orderId) {
    return privateRequest('getOrder', { pair, order_id: orderId });
}

// ====== Public API Methods ======

async function getTicker(pairId) {
    // pairId should be like 'btcidr' (no underscore)
    return publicRequest(`/api/ticker/${pairId}`);
}

async function getTickerAll() {
    return publicRequest('/api/ticker_all');
}

async function getPairs() {
    return publicRequest('/api/pairs');
}

async function getSummaries() {
    return publicRequest('/api/summaries');
}

async function getDepth(pairId) {
    return publicRequest(`/api/depth/${pairId}`);
}

async function getServerTime() {
    return publicRequest('/api/server_time');
}

async function getPriceIncrements() {
    return publicRequest('/api/price_increments');
}

// Helper: Convert pair format 'btc_idr' -> 'btcidr'
function pairToId(pair) {
    return pair.replace('_', '');
}

// Helper: Get current price for a pair
async function getCurrentPrice(pair) {
    const pairId = pairToId(pair);
    const data = await getTicker(pairId);
    if (data && data.ticker) {
        return {
            last: parseFloat(data.ticker.last),
            buy: parseFloat(data.ticker.buy),
            sell: parseFloat(data.ticker.sell),
            high: parseFloat(data.ticker.high),
            low: parseFloat(data.ticker.low),
            volume: data.ticker[`vol_${pair.split('_')[0]}`]
        };
    }
    throw new Error('Failed to get ticker data');
}

module.exports = {
    getInfo,
    trade,
    openOrders,
    cancelOrder,
    tradeHistory,
    orderHistory,
    getOrder,
    getTicker,
    getTickerAll,
    getPairs,
    getSummaries,
    getDepth,
    getServerTime,
    getPriceIncrements,
    getCurrentPrice,
    pairToId
};
