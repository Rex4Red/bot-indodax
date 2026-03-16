const https = require('https');

const BOT_VERSION = require('../../package.json').version;

/**
 * Send a Discord webhook message with embeds
 * @returns {string|null} message ID
 */
async function sendEmbed(webhookUrl, embed) {
    const body = JSON.stringify({ embeds: [embed] });
    const messageId = await request(webhookUrl + '?wait=true', 'POST', body);
    return messageId;
}

/**
 * Edit an existing Discord webhook message
 */
async function editEmbed(webhookUrl, messageId, embed) {
    if (!messageId) return null;
    const body = JSON.stringify({ embeds: [embed] });
    await request(`${webhookUrl}/messages/${messageId}`, 'PATCH', body);
    return messageId;
}

/**
 * Build embed for a coin bot
 */
function buildCoinEmbed(bot, extra = {}) {
    const pair = bot.pair.replace('_', '/').toUpperCase();
    const coin = bot.pair.split('_')[0].toUpperCase();
    const hasPos = bot.position_amount > 0;
    const isSim = bot.simulation_mode;

    // Colors
    const COLOR_HOLDING = 0x00ff88;  // green
    const COLOR_WAITING = 0x00d4ff;  // cyan
    const COLOR_SELL = 0xff9f43;     // orange
    const COLOR_NEW = 0x4285f4;      // blue

    let color = hasPos ? COLOR_HOLDING : COLOR_WAITING;
    if (extra.action === 'sell') color = COLOR_SELL;
    if (extra.action === 'added') color = COLOR_NEW;

    const mode = isSim ? '🔵 SIM' : '🟢 LIVE';
    const status = hasPos ? '📦 HOLDING' : '⏳ Menunggu sinyal';

    // Fields
    const fields = [];

    fields.push({
        name: '📊 Status',
        value: `${status}\n${mode}`,
        inline: true
    });

    fields.push({
        name: '⚙️ Setting',
        value: `Dip: ${bot.buy_threshold}% | TP: ${bot.sell_profit}%\nSL: ${bot.sell_loss}% | Amount: Rp ${formatNum(bot.trade_amount)}`,
        inline: true
    });

    if (hasPos) {
        fields.push({
            name: '💰 Holding',
            value: `${bot.position_amount.toFixed(8)} ${coin}\n@ Rp ${formatNum(bot.buy_price)}`,
            inline: false
        });
    }

    // Buy/Sell info
    if (extra.buyTime) {
        fields.push({
            name: '🛒 BUY',
            value: `Rp ${formatNum(extra.buyPrice)} | ${formatTime(extra.buyTime)}`,
            inline: true
        });
    }

    if (extra.sellTime) {
        fields.push({
            name: '💵 SELL',
            value: `Rp ${formatNum(extra.sellPrice)} | ${formatTime(extra.sellTime)}`,
            inline: true
        });
    }

    // Price analysis
    if (hasPos && bot.price_high > 0) {
        const highPct = ((bot.price_high - bot.buy_price) / bot.buy_price * 100).toFixed(2);
        const lowPct = ((bot.price_low - bot.buy_price) / bot.buy_price * 100).toFixed(2);
        fields.push({
            name: '📈 High / 📉 Low',
            value: `Rp ${formatNum(bot.price_high)} (${highPct >= 0 ? '+' : ''}${highPct}%) / Rp ${formatNum(bot.price_low)} (${lowPct >= 0 ? '+' : ''}${lowPct}%)`,
            inline: false
        });
    }

    // P/L from trade
    if (extra.profitLoss !== undefined) {
        const plSign = extra.profitLoss >= 0 ? '+' : '';
        const plEmoji = extra.profitLoss >= 0 ? '💰' : '💸';
        fields.push({
            name: `${plEmoji} P/L Trade Ini`,
            value: `${plSign}Rp ${formatNum(extra.profitLoss)} (${plSign}${extra.profitPct?.toFixed(2) || '0.00'}%)`,
            inline: true
        });
    }

    // Cumulative stats
    if (extra.totalPL !== undefined) {
        const tplSign = extra.totalPL >= 0 ? '+' : '';
        fields.push({
            name: '💹 Total P/L Coin Ini',
            value: `${tplSign}Rp ${formatNum(extra.totalPL)} | ✅ ${extra.wins || 0}W ❌ ${extra.losses || 0}L`,
            inline: true
        });
    }

    // Transaction log
    if (extra.logMessage) {
        fields.push({
            name: '📋 Log',
            value: extra.logMessage.substring(0, 200),
            inline: false
        });
    }

    const embed = {
        title: `${coin} — ${pair}`,
        color,
        fields,
        footer: {
            text: `Indodax Bot v${BOT_VERSION} • ${formatTime(new Date())}`
        }
    };

    return embed;
}

/**
 * Get coin P/L stats from trade history
 */
function getCoinStats(trades, pair) {
    const coinTrades = trades.filter(t => t.pair === pair && t.type === 'sell' && t.status !== 'failed');
    let totalPL = 0, wins = 0, losses = 0;
    for (const t of coinTrades) {
        totalPL += t.profit_loss || 0;
        if ((t.profit_loss || 0) >= 0) wins++;
        else losses++;
    }
    return { totalPL, wins, losses };
}

// ===== Helpers =====

function formatNum(n) {
    if (n === undefined || n === null) return '0';
    return Math.round(n).toLocaleString('id-ID');
}

function formatTime(date) {
    const d = new Date(date);
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) + ' ' +
           d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function request(url, method, body) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed.id || null);
                    } catch {
                        reject(new Error(`Discord parse error: ${data.substring(0, 100)}`));
                    }
                } else {
                    reject(new Error(`Discord HTTP ${res.statusCode}: ${data.substring(0, 150)}`));
                }
            });
        });

        req.on('error', (err) => {
            reject(new Error(`Discord network error: ${err.message}`));
        });
        req.write(body);
        req.end();
    });
}

module.exports = { sendEmbed, editEmbed, buildCoinEmbed, getCoinStats };
