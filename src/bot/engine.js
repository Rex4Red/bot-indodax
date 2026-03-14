const EventEmitter = require('events');
const indodax = require('../api/indodax');
const strategy = require('./strategy');
const db = require('../database/db');

class BotEngine extends EventEmitter {
    constructor() {
        super();
        this.interval = null;
        this.isRunning = false;
        this.logs = [];
        this.maxLogs = 300;
    }

    log(level, message, pair = '') {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            pair
        };
        this.logs.unshift(entry);
        if (this.logs.length > this.maxLogs) this.logs.pop();
        this.emit('log', entry);
    }

    async start() {
        if (this.isRunning) {
            this.log('warning', 'Bot sudah berjalan');
            return;
        }

        const globalSettings = db.getGlobalSettings();
        const bots = db.getBots().filter(b => b.is_active);

        if (bots.length === 0) {
            this.log('warning', 'Tidak ada bot aktif. Tambahkan coin terlebih dahulu.');
            return;
        }

        this.isRunning = true;
        this.log('info', `🤖 Bot dimulai! Mode: ${globalSettings.simulation_mode ? 'SIMULASI' : 'LIVE'}`);
        this.log('info', `📊 Monitoring ${bots.length} coin: ${bots.map(b => b.pair.replace('_', '/').toUpperCase()).join(', ')}`);

        // Set reference prices for bots that don't have one
        for (const bot of bots) {
            if (!bot.reference_price || bot.reference_price === 0) {
                try {
                    const price = await indodax.getCurrentPrice(bot.pair);
                    db.updateBot(bot.id, { reference_price: price.last });
                    this.log('info', `Harga referensi ${bot.pair.replace('_', '/').toUpperCase()}: ${strategy.formatIDR(price.last)}`, bot.pair);
                } catch (err) {
                    this.log('error', `Gagal mendapatkan harga ${bot.pair}: ${err.message}`, bot.pair);
                }
            }
        }

        for (const bot of bots) {
            this.log('info', `📊 ${bot.pair.replace('_', '/').toUpperCase()} → Buy Dip ${bot.buy_threshold}%, TP ${bot.sell_profit}%, SL ${bot.sell_loss}%, Amount ${strategy.formatIDR(bot.trade_amount)}`, bot.pair);
        }

        // Start monitoring loop
        const intervalMs = (globalSettings.check_interval || 10) * 1000;
        this.interval = setInterval(() => this.tick(), intervalMs);
        this.tick();
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        this.isRunning = false;
        this.log('info', '🛑 Bot dihentikan');
        this.emit('stopped');
    }

    async tick() {
        if (!this.isRunning) return;

        const globalSettings = db.getGlobalSettings();
        const bots = db.getBots().filter(b => b.is_active);

        // Process each bot with a small delay between them to avoid rate limiting
        for (let i = 0; i < bots.length; i++) {
            if (!this.isRunning) break;
            try {
                await this.processSingleBot(bots[i], globalSettings);
            } catch (err) {
                this.log('error', `❌ Error ${bots[i].pair}: ${err.message}`, bots[i].pair);
            }
            // Small delay between API calls to avoid rate limiting
            if (i < bots.length - 1) {
                await new Promise(r => setTimeout(r, 200));
            }
        }
    }

    async processSingleBot(bot, globalSettings) {
        const price = await indodax.getCurrentPrice(bot.pair);
        const currentPrice = price.last;
        const pairLabel = bot.pair.replace('_', '/').toUpperCase();

        // Check if we have an open position
        if (bot.position_amount > 0 && bot.buy_price > 0) {
            const changePct = strategy.calculateChangePercent(currentPrice, bot.buy_price);
            this.log('info', `💰 ${pairLabel}: ${strategy.formatIDR(currentPrice)} (P: ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`, bot.pair);

            if (strategy.shouldSellProfit(currentPrice, bot.buy_price, bot.sell_profit)) {
                await this.executeSell(bot, globalSettings, currentPrice, 'take_profit');
            } else if (strategy.shouldSellLoss(currentPrice, bot.buy_price, bot.sell_loss)) {
                await this.executeSell(bot, globalSettings, currentPrice, 'stop_loss');
            }
        } else {
            const changePct = strategy.calculateChangePercent(currentPrice, bot.reference_price);
            this.log('info', `💰 ${pairLabel}: ${strategy.formatIDR(currentPrice)} (Ref: ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`, bot.pair);

            if (strategy.shouldBuy(currentPrice, bot.reference_price, bot.buy_threshold)) {
                await this.executeBuy(bot, globalSettings, currentPrice);
            }
        }
    }

    async executeBuy(bot, globalSettings, currentPrice) {
        const coin = bot.pair.split('_')[0];
        const coinAmount = strategy.calculateCoinAmount(bot.trade_amount, currentPrice);
        const pairLabel = bot.pair.replace('_', '/').toUpperCase();

        this.log('buy', `🟢 [${pairLabel}] SINYAL BUY! Harga turun ${bot.buy_threshold}% dari referensi`, bot.pair);
        this.log('buy', `💵 [${pairLabel}] Membeli ${coinAmount.toFixed(8)} ${coin.toUpperCase()} @ ${strategy.formatIDR(currentPrice)}`, bot.pair);

        let orderId = null;
        let status = 'executed';

        if (!globalSettings.simulation_mode) {
            try {
                const result = await indodax.trade(bot.pair, 'buy', currentPrice, coinAmount, 'limit');
                orderId = result.order_id?.toString();
                this.log('buy', `✅ [${pairLabel}] Order BUY berhasil! ID: ${orderId}`, bot.pair);
            } catch (err) {
                this.log('error', `❌ [${pairLabel}] Gagal membeli: ${err.message}`, bot.pair);
                status = 'failed';
            }
        } else {
            this.log('buy', `🔵 [${pairLabel}] [SIMULASI] Order BUY dicatat`, bot.pair);
        }

        db.updateBot(bot.id, {
            buy_price: currentPrice,
            position_amount: coinAmount,
            position_coin: coin
        });

        db.addTradeLog({
            pair: bot.pair,
            type: 'buy',
            price: currentPrice,
            amount: coinAmount,
            total: bot.trade_amount,
            status,
            order_id: orderId,
            is_simulation: globalSettings.simulation_mode,
            bot_id: bot.id,
            notes: `Buy dip at ${strategy.calculateChangePercent(currentPrice, bot.reference_price).toFixed(2)}%`
        });

        this.emit('trade', { type: 'buy', pair: bot.pair, price: currentPrice, amount: coinAmount });
    }

    async executeSell(bot, globalSettings, currentPrice, reason) {
        const coin = bot.pair.split('_')[0];
        const pl = strategy.calculateProfitLoss(currentPrice, bot.buy_price, bot.position_amount);
        const pairLabel = bot.pair.replace('_', '/').toUpperCase();
        const reasonLabel = reason === 'take_profit' ? 'TAKE PROFIT 📈' : 'STOP LOSS 📉';

        this.log('sell', `🔴 [${pairLabel}] ${reasonLabel}`, bot.pair);
        this.log('sell', `💵 [${pairLabel}] Menjual ${bot.position_amount.toFixed(8)} ${coin.toUpperCase()} @ ${strategy.formatIDR(currentPrice)}`, bot.pair);
        this.log('sell', `${pl.absolute >= 0 ? '💰' : '💸'} [${pairLabel}] P/L: ${strategy.formatIDR(pl.absolute)} (${pl.percentage.toFixed(2)}%)`, bot.pair);

        let orderId = null;
        let status = 'executed';

        if (!globalSettings.simulation_mode) {
            try {
                const result = await indodax.trade(bot.pair, 'sell', currentPrice, bot.position_amount, 'limit');
                orderId = result.order_id?.toString();
                this.log('sell', `✅ [${pairLabel}] Order SELL berhasil! ID: ${orderId}`, bot.pair);
            } catch (err) {
                this.log('error', `❌ [${pairLabel}] Gagal menjual: ${err.message}`, bot.pair);
                status = 'failed';
            }
        } else {
            this.log('sell', `🔵 [${pairLabel}] [SIMULASI] Order SELL dicatat`, bot.pair);
        }

        db.updateBot(bot.id, {
            buy_price: 0,
            position_amount: 0,
            position_coin: '',
            reference_price: currentPrice
        });

        db.addTradeLog({
            pair: bot.pair,
            type: 'sell',
            price: currentPrice,
            amount: bot.position_amount,
            total: currentPrice * bot.position_amount,
            profit_loss: pl.absolute,
            profit_loss_pct: pl.percentage,
            status,
            order_id: orderId,
            is_simulation: globalSettings.simulation_mode,
            bot_id: bot.id,
            notes: `${reason}: ${pl.percentage.toFixed(2)}%`
        });

        this.emit('trade', { type: 'sell', pair: bot.pair, price: currentPrice, amount: bot.position_amount, pnl: pl });
    }

    async manualBuy(botId) {
        const bot = db.getBot(botId);
        if (!bot) throw new Error('Bot tidak ditemukan');

        const pairLabel = bot.pair.replace('_', '/').toUpperCase();

        if (bot.position_amount > 0) {
            throw new Error(`${pairLabel} sudah punya posisi. Jual dulu sebelum beli lagi.`);
        }

        const globalSettings = db.getGlobalSettings();
        const price = await indodax.getCurrentPrice(bot.pair);
        const currentPrice = price.last;

        this.log('buy', `🖐️ [${pairLabel}] MANUAL BUY oleh user`, bot.pair);
        await this.executeBuy(bot, globalSettings, currentPrice);

        return { pair: bot.pair, price: currentPrice };
    }

    async manualSell(botId) {
        const bot = db.getBot(botId);
        if (!bot) throw new Error('Bot tidak ditemukan');

        const pairLabel = bot.pair.replace('_', '/').toUpperCase();

        if (!bot.position_amount || bot.position_amount <= 0) {
            throw new Error(`${pairLabel} tidak punya posisi untuk dijual.`);
        }

        const globalSettings = db.getGlobalSettings();
        const price = await indodax.getCurrentPrice(bot.pair);
        const currentPrice = price.last;

        this.log('sell', `🖐️ [${pairLabel}] MANUAL SELL oleh user`, bot.pair);
        await this.executeSell(bot, globalSettings, currentPrice, 'manual_sell');

        return { pair: bot.pair, price: currentPrice };
    }

    getStatus() {
        const globalSettings = db.getGlobalSettings();
        const bots = db.getBots();
        const stats = db.getTradeStats();
        return {
            isRunning: this.isRunning,
            simulation: !!globalSettings.simulation_mode,
            checkInterval: globalSettings.check_interval,
            activeBots: bots.filter(b => b.is_active).length,
            totalBots: bots.length,
            bots,
            ...stats
        };
    }

    getLogs(limit = 50, pair = null) {
        let logs = this.logs;
        if (pair) logs = logs.filter(l => l.pair === pair || l.pair === '');
        return logs.slice(0, limit);
    }
}

const botEngine = new BotEngine();
module.exports = botEngine;
