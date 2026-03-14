const express = require('express');
const router = express.Router();
const indodax = require('../api/indodax');
const db = require('../database/db');
const botEngine = require('../bot/engine');

// === Bot Status ===
router.get('/status', (req, res) => {
    try {
        const status = botEngine.getStatus();
        res.json({ success: true, data: status });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// === Account Balances ===
router.get('/balances', async (req, res) => {
    try {
        const info = await indodax.getInfo();
        res.json({
            success: true,
            data: {
                balance: info.balance,
                balance_hold: info.balance_hold,
                name: info.name,
                email: info.email
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// === Global Settings ===
router.get('/settings', (req, res) => {
    try {
        const settings = db.getGlobalSettings();
        res.json({ success: true, data: settings });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/settings', (req, res) => {
    try {
        const updated = db.updateGlobalSettings(req.body);
        res.json({ success: true, data: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// === Bot Configs (Multi-coin) ===
router.get('/bots', (req, res) => {
    try {
        const bots = db.getBots();
        res.json({ success: true, data: bots });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/bots', (req, res) => {
    try {
        const bot = db.addBot(req.body);
        res.json({ success: true, data: bot });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

router.put('/bots/:id', (req, res) => {
    try {
        const bot = db.updateBot(req.params.id, req.body);
        res.json({ success: true, data: bot });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

router.delete('/bots/:id', (req, res) => {
    try {
        db.removeBot(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// === Bot Control ===
router.post('/bot/start', async (req, res) => {
    try {
        await botEngine.start();
        res.json({ success: true, message: 'Bot dimulai' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/bot/stop', (req, res) => {
    try {
        botEngine.stop();
        res.json({ success: true, message: 'Bot dihentikan' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// === Manual Buy/Sell ===
router.post('/bots/:id/buy', async (req, res) => {
    try {
        const result = await botEngine.manualBuy(req.params.id);
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

router.post('/bots/:id/sell', async (req, res) => {
    try {
        const result = await botEngine.manualSell(req.params.id);
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// === Trade History ===
router.get('/trades', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const pair = req.query.pair || null;
        const trades = db.getTradeLogs(limit, offset, pair);
        const stats = db.getTradeStats(pair);
        res.json({ success: true, data: { trades, stats } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// === Pairs (from Indodax) ===
router.get('/pairs', async (req, res) => {
    try {
        const pairs = await indodax.getPairs();
        res.json({ success: true, data: pairs });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// === Ticker ===
router.get('/ticker/:pair', async (req, res) => {
    try {
        const pair = req.params.pair;
        const pairId = indodax.pairToId(pair);
        const ticker = await indodax.getTicker(pairId);
        res.json({ success: true, data: ticker });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/ticker-all', async (req, res) => {
    try {
        const data = await indodax.getTickerAll();
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// === Bot Logs ===
router.get('/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const pair = req.query.pair || null;
    res.json({ success: true, data: botEngine.getLogs(limit, pair) });
});

// === Favorites ===
router.get('/favorites', (req, res) => {
    try {
        const favorites = db.getFavorites();
        res.json({ success: true, data: favorites });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/favorites', (req, res) => {
    try {
        const { pair } = req.body;
        db.addFavorite(pair);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/favorites/:pair', (req, res) => {
    try {
        db.removeFavorite(req.params.pair);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// === Reset Bot State ===
router.post('/bot/reset', (req, res) => {
    try {
        botEngine.stop();
        const bots = db.getBots();
        for (const bot of bots) {
            db.updateBot(bot.id, {
                reference_price: 0,
                buy_price: 0,
                position_amount: 0,
                position_coin: ''
            });
        }
        res.json({ success: true, message: 'Semua bot state direset' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// === Chart Data (OHLC from public trades) ===
router.get('/chart/:pair', async (req, res) => {
    try {
        const pair = req.params.pair; // e.g. 'btc_idr'
        const interval = parseInt(req.query.interval) || 1; // minutes
        const pairId = indodax.pairToId(pair);

        // Fetch trades and ticker in parallel
        const [trades, tickerData, depthData] = await Promise.all([
            indodax.getTrades(pairId),
            indodax.getTicker(pairId),
            indodax.getDepth(pairId)
        ]);

        // Aggregate trades into OHLC candles
        const candles = [];
        if (Array.isArray(trades) && trades.length > 0) {
            const intervalMs = interval * 60 * 1000;
            const sortedTrades = trades.sort((a, b) => parseInt(a.date) - parseInt(b.date));

            let currentBucket = Math.floor(parseInt(sortedTrades[0].date) * 1000 / intervalMs) * intervalMs;
            let open = parseFloat(sortedTrades[0].price);
            let high = open, low = open, close = open;

            for (const trade of sortedTrades) {
                const tradeTime = parseInt(trade.date) * 1000;
                const tradeBucket = Math.floor(tradeTime / intervalMs) * intervalMs;
                const price = parseFloat(trade.price);

                if (tradeBucket !== currentBucket) {
                    candles.push({
                        time: Math.floor(currentBucket / 1000),
                        open, high, low, close
                    });
                    currentBucket = tradeBucket;
                    open = price;
                    high = price;
                    low = price;
                    close = price;
                } else {
                    high = Math.max(high, price);
                    low = Math.min(low, price);
                    close = price;
                }
            }
            // Push last candle
            candles.push({
                time: Math.floor(currentBucket / 1000),
                open, high, low, close
            });
        }

        // Ticker info
        const ticker = tickerData?.ticker || {};

        // Depth summary (top 5 bids/asks)
        const depth = {
            bids: (depthData?.buy || []).slice(0, 5),
            asks: (depthData?.sell || []).slice(0, 5)
        };

        res.json({
            success: true,
            data: {
                candles,
                ticker: {
                    last: parseFloat(ticker.last || 0),
                    high: parseFloat(ticker.high || 0),
                    low: parseFloat(ticker.low || 0),
                    buy: parseFloat(ticker.buy || 0),
                    sell: parseFloat(ticker.sell || 0),
                    vol: ticker[`vol_${pair.split('_')[0]}`] || '0'
                },
                depth
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
