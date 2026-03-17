const EventEmitter = require('events');
const indodax = require('../api/indodax');
const strategy = require('./strategy');
const db = require('../database/db');
const discord = require('../notifications/discord');

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

        // Send Discord embeds for bots that don't have one yet
        this.syncDiscordEmbeds();

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
            // Cooldown check: don't buy within 60s after last sell
            if (bot.last_sell_time) {
                const elapsed = Date.now() - bot.last_sell_time;
                if (elapsed < 60000) {
                    this.log('info', `⏳ ${pairLabel}: Cooldown ${Math.ceil((60000 - elapsed) / 1000)}s setelah sell`, bot.pair);
                    return;
                }
            }

            // Set fresh reference if needed (after sell reset)
            if (!bot.reference_price || bot.reference_price === 0) {
                db.updateBot(bot.id, { reference_price: currentPrice });
                this.log('info', `📌 ${pairLabel}: Referensi baru ${strategy.formatIDR(currentPrice)}`, bot.pair);
                return;
            }

            const changePct = strategy.calculateChangePercent(currentPrice, bot.reference_price);
            this.log('info', `💰 ${pairLabel}: ${strategy.formatIDR(currentPrice)} (Ref: ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`, bot.pair);

            // Update reference price if price goes HIGHER (trailing reference)
            if (currentPrice > bot.reference_price) {
                db.updateBot(bot.id, { reference_price: currentPrice });
            }

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
                // Check IDR balance first to avoid unnecessary API errors
                const info = await indodax.getInfo();
                const idrBalance = parseFloat(info.balance?.idr || 0);
                if (idrBalance < bot.trade_amount) {
                    this.log('info', `⚠️ [${pairLabel}] Saldo IDR tidak cukup: ${strategy.formatIDR(idrBalance)} < ${strategy.formatIDR(bot.trade_amount)}`, bot.pair);
                    return;
                }

                // Record coin balance BEFORE buy
                const coinBalanceBefore = parseFloat(info.balance?.[coin] || 0);

                // Market order: pass IDR amount for buy, gets filled instantly
                const result = await indodax.trade(bot.pair, 'buy', currentPrice, bot.trade_amount, 'market');
                orderId = result.order_id?.toString();

                // Log raw response for debugging
                this.log('info', `🔍 [${pairLabel}] Trade response: ${JSON.stringify(result).substring(0, 200)}`, bot.pair);

                // Check actual coin balance AFTER buy to get REAL received amount
                const infoAfter = await indodax.getInfo();
                const coinBalanceAfter = parseFloat(infoAfter.balance?.[coin] || 0);
                const idrBalanceAfter = parseFloat(infoAfter.balance?.idr || 0);

                // Calculate actual received coins and effective price
                const actualReceived = coinBalanceAfter - coinBalanceBefore;
                const actualSpent = idrBalance - idrBalanceAfter;

                if (actualReceived > 0) {
                    actualAmount = actualReceived;
                    actualPrice = Math.round(actualSpent / actualReceived); // Effective price including fees
                    this.log('buy', `✅ [${pairLabel}] Market BUY berhasil! Dapat ${actualAmount.toFixed(8)} ${coin.toUpperCase()} | Spent ${strategy.formatIDR(actualSpent)} | Effective: ${strategy.formatIDR(actualPrice)}/coin`, bot.pair);
                } else {
                    // Fallback: use response data or estimate with fee deduction
                    actualAmount = coinAmount * 0.997; // Deduct 0.3% fee estimate
                    actualPrice = Math.round(bot.trade_amount / actualAmount);
                    this.log('buy', `✅ [${pairLabel}] Market BUY berhasil! ~${actualAmount.toFixed(8)} ${coin.toUpperCase()} (estimated)`, bot.pair);
                }
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
                price_low: actualPrice,
                last_buy_time: new Date().toISOString()
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

        // Discord notification
        this.sendDiscordNotification(bot.id, 'buy', {
            buyPrice: actualPrice,
            buyTime: new Date()
        });

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
        this.log('sell', `${pl.absolute >= 0 ? '💰' : '💸'} [${pairLabel}] P/L Bersih: ${strategy.formatIDR(pl.absolute)} (${pl.percentage.toFixed(2)}%) | Fee: ${strategy.formatIDR(pl.totalFee)}`, bot.pair);

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
                reference_price: 0,  // Reset to 0 so next tick sets fresh reference
                price_high: 0,
                price_low: 0,
                last_sell_time: Date.now()  // Cooldown timer
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

        // Discord notification
        const stats = discord.getCoinStats(db.getTrades(), bot.pair);
        this.sendDiscordNotification(bot.id, 'sell', {
            sellPrice: currentPrice,
            sellTime: new Date(),
            buyPrice: bot.buy_price,
            buyTime: bot.last_buy_time || null,
            profitLoss: pl.absolute,
            profitPct: pl.percentage,
            totalPL: stats.totalPL,
            wins: stats.wins,
            losses: stats.losses,
            logMessage: `${reason === 'take_profit' ? 'TP' : reason === 'stop_loss' ? 'SL' : 'Manual'}: ${pl.percentage.toFixed(2)}% | ${strategy.formatIDR(pl.absolute)}`
        });

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

    async sendDiscordNotification(botId, action, extra = {}) {
        const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
        if (!webhookUrl) return;

        try {
            const bot = db.getBot(botId);
            if (!bot) return;

            extra.action = action;
            const embed = discord.buildCoinEmbed(bot, extra);

            if (bot.discord_message_id) {
                // Edit existing message
                await discord.editEmbed(webhookUrl, bot.discord_message_id, embed);
            } else {
                // Send new message and store ID
                const msgId = await discord.sendEmbed(webhookUrl, embed);
                if (msgId) {
                    db.updateBot(botId, { discord_message_id: msgId });
                }
            }
        } catch (err) {
            this.log('error', `Discord notification error: ${err.message}`);
        }
    }

    async syncDiscordEmbeds() {
        const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
        if (!webhookUrl) {
            this.log('info', '⚠️ DISCORD_WEBHOOK_URL tidak diset di .env');
            return;
        }
        this.log('info', `🔔 Discord webhook aktif: ...${webhookUrl.slice(-20)}`);

        const bots = db.getBots();
        let synced = 0;
        for (const bot of bots) {
            if (!bot.discord_message_id) {
                try {
                    const stats = discord.getCoinStats(db.getTrades(), bot.pair);
                    const extra = { action: 'added', totalPL: stats.totalPL, wins: stats.wins, losses: stats.losses };
                    if (bot.buy_price > 0) {
                        extra.buyPrice = bot.buy_price;
                        extra.buyTime = bot.last_buy_time || new Date();
                    }
                    const embed = discord.buildCoinEmbed(bot, extra);
                    this.log('info', `📨 Mengirim Discord embed untuk ${bot.pair.replace('_', '/').toUpperCase()}...`);
                    const msgId = await discord.sendEmbed(webhookUrl, embed);
                    if (msgId) {
                        db.updateBot(bot.id, { discord_message_id: msgId });
                        this.log('info', `✅ Discord embed berhasil: ${bot.pair.replace('_', '/').toUpperCase()} (ID: ${msgId})`);
                        synced++;
                    } else {
                        this.log('error', `❌ Discord embed gagal (null response) untuk ${bot.pair.replace('_', '/').toUpperCase()}`);
                    }
                    await new Promise(r => setTimeout(r, 1000));
                } catch (err) {
                    this.log('error', `❌ Discord sync error ${bot.pair}: ${err.message}`);
                }
            }
        }
        if (synced > 0) this.log('info', `📨 ${synced} Discord embed berhasil dibuat`);
    }
}

const botEngine = new BotEngine();
module.exports = botEngine;
