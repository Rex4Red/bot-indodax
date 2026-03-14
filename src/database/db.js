const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'data.json');

const DEFAULT_DATA = {
    global_settings: {
        check_interval: 10
    },
    bots: [],  // Array of bot configs with per-coin simulation_mode and price tracking
    trades: [],
    favorites: []
};

let data = null;

function load() {
    try {
        if (fs.existsSync(DB_PATH)) {
            data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
            // Migrate from old format
            if (data.settings && !data.global_settings) {
                data.global_settings = {
                    check_interval: data.settings.check_interval || 10,
                    simulation_mode: data.settings.simulation_mode ?? 1
                };
                // Migrate old single-pair config to bots array
                if (data.settings.pair && !data.bots) {
                    data.bots = [{
                        id: generateId(),
                        pair: data.settings.pair,
                        buy_threshold: data.settings.buy_threshold || 3,
                        sell_profit: data.settings.sell_profit || 5,
                        sell_loss: data.settings.sell_loss || 2,
                        trade_amount: data.settings.trade_amount || 100000,
                        is_active: true,
                        reference_price: data.state?.reference_price || 0,
                        buy_price: data.state?.buy_price || 0,
                        position_amount: data.state?.position_amount || 0,
                        position_coin: data.state?.position_coin || ''
                    }];
                }
                delete data.settings;
                delete data.state;
            }
            if (!data.bots) data.bots = [];
            if (!data.trades) data.trades = [];
            if (!data.favorites) data.favorites = [];
            if (!data.global_settings) data.global_settings = { ...DEFAULT_DATA.global_settings };
            // Migrate: move global simulation_mode to per-bot
            if (data.global_settings.simulation_mode !== undefined) {
                const simMode = data.global_settings.simulation_mode;
                for (const bot of data.bots) {
                    if (bot.simulation_mode === undefined) bot.simulation_mode = simMode;
                }
                delete data.global_settings.simulation_mode;
            }
            // Migrate: add price tracking fields to existing bots
            for (const bot of data.bots) {
                if (bot.simulation_mode === undefined) bot.simulation_mode = 1;
                if (bot.price_high === undefined) bot.price_high = 0;
                if (bot.price_low === undefined) bot.price_low = 0;
            }
        } else {
            data = JSON.parse(JSON.stringify(DEFAULT_DATA));
        }
    } catch {
        data = JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
}

function save() {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function init() {
    load();
    save();
    return data;
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// === Global Settings ===
function getGlobalSettings() {
    return { ...data.global_settings };
}

function updateGlobalSettings(settings) {
    for (const key of Object.keys(settings)) {
        if (settings[key] !== null && settings[key] !== undefined && key in data.global_settings) {
            data.global_settings[key] = settings[key];
        }
    }
    save();
    return getGlobalSettings();
}

// === Bot Configs (multi-coin) ===
function getBots() {
    return data.bots.map(b => ({ ...b }));
}

function getBot(id) {
    const bot = data.bots.find(b => b.id === id);
    return bot ? { ...bot } : null;
}

function addBot(config) {
    // Check if pair already exists
    const exists = data.bots.find(b => b.pair === config.pair);
    if (exists) {
        throw new Error(`Bot untuk pair ${config.pair} sudah ada`);
    }

    const bot = {
        id: generateId(),
        pair: config.pair,
        buy_threshold: config.buy_threshold || 3,
        sell_profit: config.sell_profit || 5,
        sell_loss: config.sell_loss || 2,
        trade_amount: config.trade_amount || 100000,
        is_active: config.is_active !== undefined ? config.is_active : true,
        simulation_mode: config.simulation_mode !== undefined ? config.simulation_mode : 1,
        reference_price: 0,
        buy_price: 0,
        position_amount: 0,
        position_coin: config.pair.split('_')[0],
        price_high: 0,
        price_low: 0
    };
    data.bots.push(bot);
    save();
    return bot;
}

function updateBot(id, updates) {
    const idx = data.bots.findIndex(b => b.id === id);
    if (idx === -1) throw new Error('Bot tidak ditemukan');

    const allowed = ['buy_threshold', 'sell_profit', 'sell_loss', 'trade_amount', 'is_active',
                     'simulation_mode', 'reference_price', 'buy_price', 'position_amount', 'position_coin',
                     'price_high', 'price_low'];
    for (const key of allowed) {
        if (updates[key] !== undefined && updates[key] !== null) {
            data.bots[idx][key] = updates[key];
        }
    }
    save();
    return { ...data.bots[idx] };
}

function removeBot(id) {
    data.bots = data.bots.filter(b => b.id !== id);
    save();
    return true;
}

// === Trade Log ===
function addTradeLog(trade) {
    const entry = {
        id: data.trades.length + 1,
        timestamp: new Date().toISOString(),
        pair: trade.pair,
        type: trade.type,
        price: trade.price,
        amount: trade.amount,
        total: trade.total,
        fee: trade.fee || 0,
        profit_loss: trade.profit_loss || 0,
        profit_loss_pct: trade.profit_loss_pct || 0,
        status: trade.status || 'executed',
        order_id: trade.order_id || null,
        is_simulation: trade.is_simulation ? 1 : 0,
        bot_id: trade.bot_id || null,
        notes: trade.notes || null
    };
    data.trades.unshift(entry);
    if (data.trades.length > 1000) data.trades = data.trades.slice(0, 1000);
    save();
    return entry;
}

function getTradeLogs(limit = 50, offset = 0, pair = null) {
    let trades = data.trades;
    if (pair) trades = trades.filter(t => t.pair === pair);
    return trades.slice(offset, offset + limit);
}

function getTradeStats(pair = null) {
    let trades = data.trades;
    if (pair) trades = trades.filter(t => t.pair === pair);

    const totalPL = trades.reduce((sum, t) => sum + (t.profit_loss || 0), 0);
    const buys = trades.filter(t => t.type === 'buy').length;
    const sells = trades.filter(t => t.type === 'sell').length;
    const wins = trades.filter(t => t.profit_loss > 0).length;
    const losses = trades.filter(t => t.profit_loss < 0).length;

    return {
        totalTrades: trades.length,
        totalProfitLoss: totalPL,
        buyCount: buys,
        sellCount: sells,
        winCount: wins,
        lossCount: losses,
        winRate: trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : 0
    };
}

// === Favorites ===
function getFavorites() {
    return [...data.favorites];
}

function addFavorite(pair) {
    if (!data.favorites.includes(pair)) {
        data.favorites.push(pair);
        save();
    }
    return true;
}

function removeFavorite(pair) {
    data.favorites = data.favorites.filter(f => f !== pair);
    save();
    return true;
}

module.exports = {
    init,
    getGlobalSettings,
    updateGlobalSettings,
    getBots,
    getBot,
    addBot,
    updateBot,
    removeBot,
    addTradeLog,
    getTradeLogs,
    getTradeStats,
    getFavorites,
    addFavorite,
    removeFavorite
};
