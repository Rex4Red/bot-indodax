const EventEmitter = require('events');
const indodax = require('../api/indodax');
const strategy = require('./strategy');
const db = require('../database/db');

class BotEngine extends EventEmitter {
    constructor() {
        super();
        this.interval = null;
        this.isRunning = false;
        this.tickInProgress = false;
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
        this.log('info', `🤖 Bot dimulai!`);
        this.log('info', `📊 Monitoring ${bots.length} coin: ${bots.map(b => {
            const mode = b.simulation_mode ? 'SIM' : 'LIVE';
            return b.pair.replace('_', '/').toUpperCase() + ' [' + mode + ']';
        }).join(', ')}`);


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
        if (this.tickInProgress) return; // Prevent overlapping ticks
        this.tickInProgress = true;

        try {
            const globalSettings = db.getGlobalSettings();
            const bots = db.getBots().filter(b => b.is_active);

            for (let i = 0; i < bots.length; i++) {
                if (!this.isRunning) break;
                try {
                    await this.processSingleBot(bots[i], globalSettings);
                } catch (err) {
                    this.log('error', `❌ Error ${bots[i].pair}: ${err.message}`, bots[i].pair);
                }
                if (i < bots.length - 1) {
                    await new Promise(r => setTimeout(r, 200));
                }
            }
        } finally {
            this.tickInProgress = false;
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

            // Track price high/low since buy
            const updates = {};
            if (currentPrice > (bot.price_high || 0)) updates.price_high = currentPrice;
            if (bot.price_low === 0 || currentPrice < bot.price_low) updates.price_low = currentPrice;
            if (Object.keys(updates).length > 0) db.updateBot(bot.id, updates);

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
        // Re-read fresh bot data to prevent duplicate buys
        const freshBot = db.getBot(bot.id);
        if (freshBot && freshBot.position_amount > 0) {
            this.log('info', `⚠️ [${bot.pair.replace('_', '/').toUpperCase()}] Sudah HOLDING, skip buy`, bot.pair);
            return;
        }

        const coin = bot.pair.split('_')[0];
        const coinAmount = strategy.calculateCoinAmount(bot.trade_amount, currentPrice);
        const pairLabel = bot.pair.replace('_', '/').toUpperCase();

        this.log('buy', `🟢 [${pairLabel}] SINYAL BUY! Harga turun ${bot.buy_threshold}% dari referensi`, bot.pair);
        this.log('buy', `💵 [${pairLabel}] Membeli ~${coinAmount.toFixed(8)} ${coin.toUpperCase()} @ ${strategy.formatIDR(currentPrice)}`, bot.pair);

        let orderId = null;
        let status = 'executed';
        let actualAmount = coinAmount;
        let actualPrice = currentPrice;

        if (!bot.simulation_mode) {
            try {
                // Market order: pass IDR amount for buy, gets filled instantly
                const result = await indodax.trade(bot.pair, 'buy', currentPrice, bot.trade_amount, 'market');
                orderId = result.order_id?.toString();
                // Get actual filled amount from response
                if (result.receive_coin) {
                    actualAmount = parseFloat(result.receive_coin[coin] || actualAmount);
                }
                if (result.spend_rp) {
                    actualPrice = Math.round(parseFloat(result.spend_rp) / actualAmount);
                }
                this.log('buy', `✅ [${pairLabel}] Market BUY berhasil! Dapat ${actualAmount.toFixed(8)} ${coin.toUpperCase()}`, bot.pair);
            } catch (err) {
                this.log('error', `❌ [${pairLabel}] Gagal membeli: ${err.message}`, bot.pair);
                status = 'failed';
            }
        } else {
            this.log('buy', `🔵 [${pairLabel}] [SIMULASI] Order BUY dicatat`, bot.pair);
        }

        // Only update bot position if trade succeeded or in simulation
        if (status !== 'failed') {
            db.updateBot(bot.id, {
                buy_price: actualPrice,
                position_amount: actualAmount,
                position_coin: coin,
                price_high: actualPrice,
                price_low: actualPrice
            });
        }

        db.addTradeLog({
            pair: bot.pair,
            type: 'buy',
            price: currentPrice,
            amount: coinAmount,
            total: bot.trade_amount,
            status,
            order_id: orderId,
            is_simulation: bot.simulation_mode ? 1 : 0,
            bot_id: bot.id,
            notes: status === 'failed' ? `FAILED: Buy attempt at ${strategy.formatIDR(currentPrice)}` : `Buy dip at ${strategy.calculateChangePercent(currentPrice, bot.reference_price).toFixed(2)}%`
        });

        if (status === 'failed') {
            throw new Error('Trade gagal dieksekusi di Indodax');
        }

        this.emit('trade', { type: 'buy', pair: bot.pair, price: currentPrice, amount: coinAmount });
    }

    async executeSell(bot, globalSettings, currentPrice, reason) {
        const coin = bot.pair.split('_')[0];
        const pairLabel = bot.pair.replace('_', '/').toUpperCase();
        const reasonLabel = reason === 'take_profit' ? 'TAKE PROFIT 📈' : reason === 'stop_loss' ? 'STOP LOSS 📉' : 'MANUAL SELL 🖐️';

        let sellAmount = bot.position_amount;

        // In LIVE mode, check actual balance to avoid "Insufficient balance" error
        if (!bot.simulation_mode) {
            try {
                const info = await indodax.getInfo();
                const actualBalance = parseFloat(info.balance?.[coin] || 0);
                if (actualBalance <= 0) {
                    this.log('error', `❌ [${pairLabel}] Tidak ada saldo ${coin.toUpperCase()} di Indodax`, bot.pair);
                    // Reset stuck position
                    db.updateBot(bot.id, { buy_price: 0, position_amount: 0, position_coin: '', price_high: 0, price_low: 0 });
                    throw new Error(`Tidak ada saldo ${coin.toUpperCase()} untuk dijual`);
                }
                // Use actual balance (may differ from recorded due to fees)
                if (actualBalance < sellAmount) {
                    this.log('info', `⚠️ [${pairLabel}] Saldo aktual ${actualBalance.toFixed(8)} < recorded ${sellAmount.toFixed(8)} (fee)`, bot.pair);
                    sellAmount = actualBalance;
                }
            } catch (err) {
                if (err.message.includes('Tidak ada saldo')) throw err;
                this.log('error', `⚠️ [${pairLabel}] Gagal cek saldo: ${err.message}`, bot.pair);
            }
        }

        const pl = strategy.calculateProfitLoss(currentPrice, bot.buy_price, sellAmount);

        this.log('sell', `🔴 [${pairLabel}] ${reasonLabel}`, bot.pair);
        this.log('sell', `💵 [${pairLabel}] Menjual ${sellAmount.toFixed(8)} ${coin.toUpperCase()} @ ${strategy.formatIDR(currentPrice)}`, bot.pair);
        this.log('sell', `${pl.absolute >= 0 ? '💰' : '💸'} [${pairLabel}] P/L: ${strategy.formatIDR(pl.absolute)} (${pl.percentage.toFixed(2)}%)`, bot.pair);

        let orderId = null;
        let status = 'executed';

        if (!bot.simulation_mode) {
            try {
                // Market order with actual balance amount
                const result = await indodax.trade(bot.pair, 'sell', currentPrice, sellAmount, 'market');
                orderId = result.order_id?.toString();
                this.log('sell', `✅ [${pairLabel}] Market SELL berhasil! ID: ${orderId}`, bot.pair);
            } catch (err) {
                this.log('error', `❌ [${pairLabel}] Gagal menjual: ${err.message}`, bot.pair);
                status = 'failed';
            }
        } else {
            this.log('sell', `🔵 [${pairLabel}] [SIMULASI] Order SELL dicatat`, bot.pair);
        }

        // Only update bot position if trade succeeded or in simulation
        if (status !== 'failed') {
            db.updateBot(bot.id, {
                buy_price: 0,
                position_amount: 0,
                position_coin: '',
                reference_price: currentPrice,
                price_high: 0,
                price_low: 0
            });
        }

        db.addTradeLog({
            pair: bot.pair,
            type: 'sell',
            price: currentPrice,
            amount: sellAmount,
            total: currentPrice * sellAmount,
            profit_loss: status !== 'failed' ? pl.absolute : 0,
            profit_loss_pct: status !== 'failed' ? pl.percentage : 0,
            status,
            order_id: orderId,
            is_simulation: bot.simulation_mode ? 1 : 0,
            bot_id: bot.id,
            notes: status === 'failed' ? `FAILED: Sell attempt at ${strategy.formatIDR(currentPrice)}` : `${reason}: ${pl.percentage.toFixed(2)}%`
        });

        if (status === 'failed') {
            throw new Error('Trade gagal dieksekusi di Indodax');
        }

        this.emit('trade', { type: 'sell', pair: bot.pair, price: currentPrice, amount: sellAmount, pnl: pl });
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
