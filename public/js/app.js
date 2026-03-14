// ===== INDODAX MULTI-COIN BOT DASHBOARD =====
let currentPage = 'dashboard';
let currentFilter = 'all';
let allPairs = [];
let favorites = [];
let activeBots = [];
let refreshInterval = null;

// ===== Helpers =====
function formatIDR(value) {
    if (value === null || value === undefined) return 'Rp 0';
    return new Intl.NumberFormat('id-ID', {
        style: 'currency', currency: 'IDR',
        minimumFractionDigits: 0, maximumFractionDigits: 0
    }).format(value);
}

function formatNumber(v, d = 8) {
    if (v === null || v === undefined) return '0';
    return parseFloat(v).toFixed(d);
}

function formatTime(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.toLocaleString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatTimeShort(dateStr) {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ===== API =====
async function api(endpoint, options = {}) {
    try {
        const res = await fetch(`/api${endpoint}`, {
            headers: { 'Content-Type': 'application/json' },
            ...options,
            body: options.body ? JSON.stringify(options.body) : undefined
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'API Error');
        return data.data;
    } catch (err) {
        console.error(`API Error (${endpoint}):`, err);
        throw err;
    }
}

// ===== Toast =====
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// ===== Navigation =====
function navigateTo(page) {
    currentPage = page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${page}`).classList.add('active');
    document.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.page === page));
    document.querySelectorAll('.mobile-nav-item').forEach(l => l.classList.toggle('active', l.dataset.page === page));

    if (page === 'dashboard') loadDashboard();
    else if (page === 'pairs') loadPairs();
    else if (page === 'history') loadTradeHistory();
}

function toggleMobileMenu() {
    const nav = document.getElementById('navbarNav');
    nav.style.display = nav.style.display === 'flex' ? 'none' : 'flex';
}

// ===== Dashboard =====
async function loadDashboard() {
    try {
        const [status, settings] = await Promise.all([
            api('/status'),
            api('/settings')
        ]);

        activeBots = status.bots || [];
        updateBotStatus(status.isRunning);
        document.getElementById('toggleBot').checked = status.isRunning;
        document.getElementById('toggleSimulation').checked = !!settings.simulation_mode;
        document.getElementById('settingInterval').value = settings.check_interval;

        // Overview stats
        document.getElementById('activeBotCount').textContent = `${status.activeBots} / ${status.totalBots}`;
        document.getElementById('totalTrades').textContent = status.totalTrades || 0;
        document.getElementById('winRateLabel').textContent = `📊 Win Rate: ${status.winRate || 0}%`;

        const totalPL = status.totalProfitLoss || 0;
        document.getElementById('totalPL').textContent = formatIDR(totalPL);
        const plEl = document.getElementById('totalPLChange');
        if (totalPL > 0) { plEl.textContent = '📈 Profit'; plEl.className = 'card-change positive'; }
        else if (totalPL < 0) { plEl.textContent = '📉 Loss'; plEl.className = 'card-change negative'; }
        else { plEl.textContent = '~ Belum ada trading'; plEl.className = 'card-change'; plEl.style.color = 'var(--text-muted)'; }

        loadBalances();
        renderBotList();
        refreshLogs();
        loadRecentTrades();
    } catch (err) {
        console.error('Load dashboard error:', err);
    }
}

async function loadBalances() {
    try {
        const data = await api('/balances');
        document.getElementById('idrBalance').textContent = formatIDR(parseFloat(data.balance?.idr || 0));
    } catch {
        document.getElementById('idrBalance').textContent = 'Error';
    }
}

// ===== Bot List Rendering =====
const COLORS = {
    btc: '#f7931a', eth: '#627eea', sol: '#9945ff', xrp: '#23292f',
    doge: '#c3a634', ada: '#0d1e30', dot: '#e6007a', link: '#2a5ada',
    bnb: '#f3ba2f', trx: '#ff0013', matic: '#8247e5', avax: '#e84142',
    usdt: '#26a17b', shib: '#ffa409', ltc: '#bfbbbb', uni: '#ff007a'
};

function renderBotList() {
    const container = document.getElementById('botListContainer');

    if (!activeBots || activeBots.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="icon">🤖</div>
                <p>Belum ada bot. Klik <strong>"+ Tambah Coin"</strong> untuk memulai.</p>
            </div>`;
        return;
    }

    container.innerHTML = activeBots.map(bot => {
        const coin = bot.pair.split('_')[0];
        const bg = COLORS[coin] || '#555';
        const pairLabel = bot.pair.replace('_', '/').toUpperCase();
        const hasPos = bot.position_amount > 0;

        return `
            <div class="bot-item" style="flex-wrap:wrap;cursor:pointer" onclick="openChartModal('${bot.pair}', '${coin.toUpperCase()}')">
                <div class="bot-item-left">
                    <div class="bot-item-logo" style="background:${bg}">${coin.substring(0, 2).toUpperCase()}</div>
                    <div class="bot-item-info">
                        <div class="bot-item-pair">
                            ${pairLabel}
                            ${hasPos ? '<span class="has-position">HOLDING</span>' : ''}
                            ${!bot.is_active ? '<span style="color:var(--text-muted);font-size:10px;margin-left:4px">(Paused)</span>' : ''}
                        </div>
                        <div class="bot-item-params">
                            Buy Dip: ${bot.buy_threshold}% | TP: ${bot.sell_profit}% | SL: ${bot.sell_loss}% | ${formatIDR(bot.trade_amount)}
                        </div>
                        ${hasPos ? `<div class="bot-item-params" style="color:var(--accent-green)">Holding: ${formatNumber(bot.position_amount)} ${coin.toUpperCase()} @ ${formatIDR(bot.buy_price)}</div>` : ''}
                    </div>
                </div>
                <div class="bot-item-actions">
                    ${!hasPos
                        ? `<button class="btn-icon" title="Buy Manual" style="background:var(--accent-green-dim);color:var(--accent-green)" onclick="event.stopPropagation();manualBuy('${bot.id}','${pairLabel}')">🛒</button>`
                        : `<button class="btn-icon" title="Sell Manual" style="background:var(--accent-red-dim);color:var(--accent-red)" onclick="event.stopPropagation();manualSell('${bot.id}','${pairLabel}')">💰</button>`
                    }
                    <button class="btn-icon" title="Edit" onclick="event.stopPropagation();openEditModal('${bot.id}')">✏️</button>
                    <button class="btn-icon" title="${bot.is_active ? 'Pause' : 'Resume'}" onclick="event.stopPropagation();toggleBotActive('${bot.id}', ${!bot.is_active})">
                        ${bot.is_active ? '⏸️' : '▶️'}
                    </button>
                    <button class="btn-icon danger" title="Hapus" onclick="event.stopPropagation();removeBot('${bot.id}', '${pairLabel}')">🗑️</button>
                </div>
            </div>
        `;
    }).join('');
}

async function toggleBotActive(id, active) {
    try {
        await api(`/bots/${id}`, { method: 'PUT', body: { is_active: active } });
        showToast(active ? 'Bot diaktifkan' : 'Bot dijeda', 'info');
        loadDashboard();
    } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
    }
}

async function removeBot(id, label) {
    if (!confirm(`Hapus bot ${label}?`)) return;
    try {
        await api(`/bots/${id}`, { method: 'DELETE' });
        showToast(`Bot ${label} dihapus`, 'info');
        loadDashboard();
    } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
    }
}

async function manualBuy(id, label) {
    try {
        showToast(`⏳ Membeli ${label}...`, 'info');
        const result = await api(`/bots/${id}/buy`, { method: 'POST' });
        showToast(`🟢 Manual BUY ${label} @ ${formatIDR(result.price)}`, 'success');
        loadDashboard();
    } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
    }
}

async function manualSell(id, label) {
    try {
        showToast(`⏳ Menjual ${label}...`, 'info');
        const result = await api(`/bots/${id}/sell`, { method: 'POST' });
        showToast(`🔴 Manual SELL ${label} @ ${formatIDR(result.price)}`, 'success');
        loadDashboard();
    } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
    }
}

// ===== Modal =====
function openAddModal(pair) {
    document.getElementById('modalTitle').textContent = `Tambah Bot - ${pair.replace('_', '/').toUpperCase()}`;
    document.getElementById('modalPair').value = pair;
    document.getElementById('modalBotId').value = '';
    document.getElementById('modalBuyDip').value = 3;
    document.getElementById('modalTakeProfit').value = 5;
    document.getElementById('modalStopLoss').value = 2;
    document.getElementById('modalAmount').value = 100000;
    document.getElementById('modalSaveBtn').textContent = '💾 Tambah Bot';
    document.getElementById('botConfigModal').style.display = 'flex';
}

function openEditModal(botId) {
    const bot = activeBots.find(b => b.id === botId);
    if (!bot) return;
    document.getElementById('modalTitle').textContent = `Edit Bot - ${bot.pair.replace('_', '/').toUpperCase()}`;
    document.getElementById('modalPair').value = bot.pair;
    document.getElementById('modalBotId').value = bot.id;
    document.getElementById('modalBuyDip').value = bot.buy_threshold;
    document.getElementById('modalTakeProfit').value = bot.sell_profit;
    document.getElementById('modalStopLoss').value = bot.sell_loss;
    document.getElementById('modalAmount').value = bot.trade_amount;
    document.getElementById('modalSaveBtn').textContent = '💾 Simpan Perubahan';
    document.getElementById('botConfigModal').style.display = 'flex';
}

function closeModal() {
    document.getElementById('botConfigModal').style.display = 'none';
}

async function saveBotConfig() {
    const botId = document.getElementById('modalBotId').value;
    const pair = document.getElementById('modalPair').value;
    const config = {
        buy_threshold: parseFloat(document.getElementById('modalBuyDip').value),
        sell_profit: parseFloat(document.getElementById('modalTakeProfit').value),
        sell_loss: parseFloat(document.getElementById('modalStopLoss').value),
        trade_amount: parseFloat(document.getElementById('modalAmount').value)
    };

    try {
        if (botId) {
            await api(`/bots/${botId}`, { method: 'PUT', body: config });
            showToast('Bot berhasil diupdate!', 'success');
        } else {
            config.pair = pair;
            await api('/bots', { method: 'POST', body: config });
            showToast(`Bot ${pair.replace('_', '/').toUpperCase()} ditambahkan! 🎉`, 'success');
        }
        closeModal();
        loadDashboard();
    } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
    }
}

// ===== Bot Control =====
function updateBotStatus(isRunning) {
    const badge = document.getElementById('botStatusBadge');
    const text = document.getElementById('botStatusText');
    const desc = document.getElementById('botRunningDesc');
    if (isRunning) {
        badge.className = 'navbar-status running'; text.textContent = 'RUNNING'; desc.textContent = 'Semua bot aktif berjalan...';
    } else {
        badge.className = 'navbar-status stopped'; text.textContent = 'STOPPED'; desc.textContent = 'Bot tidak aktif';
    }
}

async function toggleBot() {
    const isChecked = document.getElementById('toggleBot').checked;
    try {
        if (isChecked) {
            await api('/bot/start', { method: 'POST' });
            showToast('Semua bot dimulai!', 'success');
        } else {
            await api('/bot/stop', { method: 'POST' });
            showToast('Semua bot dihentikan', 'info');
        }
        updateBotStatus(isChecked);
    } catch (err) {
        document.getElementById('toggleBot').checked = !isChecked;
        showToast(`Error: ${err.message}`, 'error');
    }
}

async function toggleSimulation() {
    const isChecked = document.getElementById('toggleSimulation').checked;
    try {
        await api('/settings', { method: 'POST', body: { simulation_mode: isChecked ? 1 : 0 } });
        showToast(isChecked ? 'Mode simulasi diaktifkan' : 'Mode LIVE diaktifkan ⚠️', isChecked ? 'info' : 'error');
    } catch (err) { showToast(`Error: ${err.message}`, 'error'); }
}

async function saveGlobalSettings() {
    try {
        await api('/settings', { method: 'POST', body: { check_interval: parseInt(document.getElementById('settingInterval').value) } });
        showToast('Interval disimpan', 'success');
    } catch (err) { showToast(`Error: ${err.message}`, 'error'); }
}

// ===== Activity Log =====
async function refreshLogs() {
    try {
        const logs = await api('/logs');
        const container = document.getElementById('activityLog');
        if (!logs || logs.length === 0) {
            container.innerHTML = '<div class="empty-state"><div class="icon">📝</div><p>Belum ada aktivitas. Mulai bot untuk melihat log.</p></div>';
            return;
        }
        container.innerHTML = logs.map(log => `
            <div class="log-entry">
                <span class="log-time">${formatTimeShort(log.timestamp)}</span>
                <span class="log-badge ${log.level}">${log.level}</span>
                <span class="log-message">${log.message}</span>
            </div>
        `).join('');
    } catch (err) { console.error('Refresh logs error:', err); }
}

async function loadRecentTrades() {
    try {
        const data = await api('/trades?limit=10');
        const tbody = document.getElementById('recentTradesBody');
        if (!data?.trades || data.trades.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:30px">Belum ada trading</td></tr>';
            return;
        }
        tbody.innerHTML = data.trades.map(t => `
            <tr>
                <td>${formatTime(t.timestamp)}</td>
                <td>${t.pair.replace('_', '/').toUpperCase()}</td>
                <td><span class="badge-${t.type}">● ${t.type.toUpperCase()}</span></td>
                <td>${formatIDR(t.price)}</td>
                <td>${formatNumber(t.amount)}</td>
                <td>${formatIDR(t.total)}</td>
                <td style="color:${t.profit_loss >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">${t.profit_loss !== 0 ? formatIDR(t.profit_loss) : '-'}</td>
                <td>${t.is_simulation ? '🔵 Sim' : '🟢 Live'}</td>
            </tr>
        `).join('');
    } catch (err) { console.error('Load trades error:', err); }
}

// ===== Pairs Page =====
async function loadPairs() {
    try {
        const [pairs, tickerAll, favData, botsData] = await Promise.all([
            api('/pairs'), api('/ticker-all'), api('/favorites'), api('/bots')
        ]);

        const existingPairs = (botsData || []).map(b => b.pair);

        allPairs = pairs.filter(p => p.ticker_id).map(p => {
            const tickerId = p.ticker_id;
            const ticker = tickerAll?.tickers?.[tickerId] || {};
            return {
                ...p,
                last: parseFloat(ticker.last || 0),
                high: parseFloat(ticker.high || 0),
                low: parseFloat(ticker.low || 0),
                volume: ticker[`vol_${p.traded_currency}`] || '0',
                name: ticker.name || p.traded_currency_unit || p.traded_currency.toUpperCase(),
                hasBot: existingPairs.includes(p.ticker_id)
            };
        });

        favorites = favData || [];
        renderPairs();
    } catch (err) {
        console.error('Load pairs error:', err);
        document.getElementById('pairsGrid').innerHTML = `<div class="empty-state" style="grid-column:span 2"><div class="icon">❌</div><p>Gagal memuat: ${err.message}</p></div>`;
    }
}

function renderPairs() {
    const search = (document.getElementById('pairSearch')?.value || '').toLowerCase();
    let filtered = allPairs.filter(p => p.last > 0);

    if (search) filtered = filtered.filter(p => p.traded_currency.toLowerCase().includes(search) || p.description?.toLowerCase().includes(search) || (p.name && p.name.toLowerCase().includes(search)));
    if (currentFilter === 'idr') filtered = filtered.filter(p => p.base_currency === 'idr');
    else if (currentFilter === 'usdt') filtered = filtered.filter(p => p.base_currency === 'usdt');
    else if (currentFilter === 'favorites') filtered = filtered.filter(p => favorites.includes(p.ticker_id));

    filtered.sort((a, b) => b.last - a.last);
    const grid = document.getElementById('pairsGrid');

    if (filtered.length === 0) {
        grid.innerHTML = '<div class="empty-state" style="grid-column:span 2"><div class="icon">🔍</div><p>Tidak ada coin ditemukan</p></div>';
        return;
    }

    grid.innerHTML = filtered.slice(0, 50).map(p => {
        const coin = p.traded_currency;
        const isFav = favorites.includes(p.ticker_id);
        const bgColor = COLORS[coin] || '#555';
        const mid = (p.high + p.low) / 2;
        const changePct = mid > 0 ? ((p.last - mid) / mid * 100).toFixed(2) : '0.00';
        const isPositive = changePct >= 0;

        return `
            <div class="pair-card" onclick="openChartModal('${p.ticker_id}', '${(p.name || coin.toUpperCase()).replace(/'/g, "\\'")}')">
                <div class="pair-card-top">
                    <div class="pair-info">
                        ${p.url_logo_png
                            ? `<img src="${p.url_logo_png}" class="coin-logo" style="background:transparent" width="36" height="36" onerror="this.style.background='${bgColor}';this.src=''">`
                            : `<div class="coin-logo" style="background:${bgColor}">${coin.substring(0, 2).toUpperCase()}</div>`
                        }
                        <div>
                            <div class="pair-name">${p.description || p.ticker_id.replace('_', '/').toUpperCase()}</div>
                            <div class="pair-symbol">${p.name || coin.toUpperCase()}</div>
                        </div>
                    </div>
                    <button class="favorite-btn ${isFav ? 'active' : ''}" onclick="event.stopPropagation();toggleFavorite('${p.ticker_id}')">
                        ${isFav ? '★' : '☆'}
                    </button>
                </div>
                <div class="pair-price">${formatIDR(p.last)}</div>
                <div class="pair-change ${isPositive ? 'positive' : 'negative'}">
                    ${isPositive ? '📈' : '📉'} ${isPositive ? '+' : ''}${changePct}%
                </div>
                <div class="pair-volume">Vol: ${parseFloat(p.volume).toLocaleString('id-ID')}</div>
                <div class="pair-card-bottom">
                    ${p.hasBot
                        ? '<span style="color:var(--accent-green);font-size:12px;font-weight:600">✅ Bot Aktif</span>'
                        : `<button class="btn-select" onclick="event.stopPropagation();openAddModal('${p.ticker_id}')">+ Tambah Bot</button>`
                    }
                </div>
            </div>
        `;
    }).join('');
}

function filterPairs() { renderPairs(); }
function setFilter(filter, btn) {
    currentFilter = filter;
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    renderPairs();
}

async function toggleFavorite(pairId) {
    try {
        if (favorites.includes(pairId)) {
            await api(`/favorites/${pairId}`, { method: 'DELETE' });
            favorites = favorites.filter(f => f !== pairId);
            showToast('Dihapus dari favorit', 'info');
        } else {
            await api('/favorites', { method: 'POST', body: { pair: pairId } });
            favorites.push(pairId);
            showToast('Ditambahkan ke favorit ⭐', 'success');
        }
        renderPairs();
    } catch (err) { showToast(`Error: ${err.message}`, 'error'); }
}

// ===== History Page =====
async function loadTradeHistory() {
    try {
        const data = await api('/trades?limit=200');
        if (data.stats) {
            document.getElementById('statTotalTrades').textContent = data.stats.totalTrades || 0;
            document.getElementById('statTotalPL').textContent = formatIDR(data.stats.totalProfitLoss || 0);
            document.getElementById('statTotalPL').style.color = (data.stats.totalProfitLoss || 0) >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
            document.getElementById('statWinRate').textContent = `${data.stats.winRate || 0}%`;
            document.getElementById('statWinLoss').textContent = `${data.stats.winCount || 0} / ${data.stats.lossCount || 0}`;
        }
        const tbody = document.getElementById('historyTradesBody');
        if (!data?.trades || data.trades.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:30px">Belum ada riwayat trading</td></tr>';
            return;
        }
        tbody.innerHTML = data.trades.map(t => `
            <tr>
                <td>${formatTime(t.timestamp)}</td>
                <td>${t.pair.replace('_', '/').toUpperCase()}</td>
                <td><span class="badge-${t.type}">● ${t.type.toUpperCase()}</span></td>
                <td>${formatIDR(t.price)}</td>
                <td>${formatNumber(t.amount)}</td>
                <td>${formatIDR(t.total)}</td>
                <td style="color:${t.profit_loss >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">
                    ${t.profit_loss !== 0 ? formatIDR(t.profit_loss) : '-'}
                </td>
                <td style="color:${t.profit_loss_pct >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">
                    ${t.profit_loss_pct !== 0 ? `${t.profit_loss_pct.toFixed(2)}%` : '-'}
                </td>
                <td>${t.is_simulation ? '🔵 Sim' : '🟢 Live'}</td>
            </tr>
        `).join('');
    } catch (err) { console.error('Load history error:', err); }
}

// ===== Auto Refresh =====
function startAutoRefresh() {
    refreshInterval = setInterval(() => {
        if (currentPage === 'dashboard') {
            refreshLogs();
            loadRecentTrades();
            api('/status').then(status => {
                activeBots = status.bots || [];
                renderBotList();
            }).catch(() => {});
        }
    }, 5000);
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
    loadDashboard();
    startAutoRefresh();
});

// ===== Chart Modal =====
let chartInstance = null;
let chartCandleSeries = null;
let chartCurrentPair = null;
let chartCurrentInterval = 1;
let chartRefreshTimer = null;

async function openChartModal(pair, name) {
    chartCurrentPair = pair;
    chartCurrentInterval = 1;

    // Reset timeframe buttons
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.tf-btn[data-tf="1"]').classList.add('active');

    // Set header info
    const coin = pair.split('_')[0];
    const bgColor = COLORS[coin] || '#555';
    document.getElementById('chartCoinLogo').style.background = bgColor;
    document.getElementById('chartCoinLogo').textContent = coin.substring(0, 2).toUpperCase();
    document.getElementById('chartCoinName').textContent = pair.replace('_', '/').toUpperCase();
    document.getElementById('chartCoinSub').textContent = name || coin.toUpperCase();

    // Show modal
    document.getElementById('chartModal').style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Clear old chart
    const container = document.getElementById('chartContainer');
    container.innerHTML = '<div class="empty-state"><div class="spinner"></div><p style="margin-top:12px">Memuat chart...</p></div>';

    // Small delay to ensure modal is visible before creating chart
    await new Promise(r => setTimeout(r, 100));

    // Create chart
    createChart(container);

    // Load data
    await loadChartData();

    // Start auto-refresh
    chartRefreshTimer = setInterval(() => loadChartData(), 10000);
}

function createChart(container) {
    container.innerHTML = '';

    chartInstance = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: container.clientHeight,
        layout: {
            background: { type: 'solid', color: '#0a0a0a' },
            textColor: '#a0a0a0',
            fontFamily: 'Inter, sans-serif',
            fontSize: 12,
        },
        grid: {
            vertLines: { color: 'rgba(255,255,255,0.04)' },
            horzLines: { color: 'rgba(255,255,255,0.04)' },
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
            vertLine: { color: 'rgba(0,212,255,0.3)', width: 1, style: 2 },
            horzLine: { color: 'rgba(0,212,255,0.3)', width: 1, style: 2 },
        },
        rightPriceScale: {
            borderColor: 'rgba(255,255,255,0.08)',
            scaleMargins: { top: 0.1, bottom: 0.1 },
        },
        timeScale: {
            borderColor: 'rgba(255,255,255,0.08)',
            timeVisible: true,
            secondsVisible: false,
        },
        handleScroll: { mouseWheel: true, pressedMouseMove: true },
        handleScale: { mouseWheel: true, pinch: true },
    });

    chartCandleSeries = chartInstance.addCandlestickSeries({
        upColor: '#00ff88',
        downColor: '#ff4444',
        borderUpColor: '#00ff88',
        borderDownColor: '#ff4444',
        wickUpColor: '#00ff88',
        wickDownColor: '#ff4444',
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
        if (chartInstance) {
            chartInstance.applyOptions({
                width: container.clientWidth,
                height: container.clientHeight
            });
        }
    });
    resizeObserver.observe(container);
    container._resizeObserver = resizeObserver;
}

async function loadChartData() {
    if (!chartCurrentPair) return;

    try {
        const data = await api(`/chart/${chartCurrentPair}?interval=${chartCurrentInterval}`);

        // Update candles
        if (data.candles && data.candles.length > 0) {
            chartCandleSeries.setData(data.candles);
            chartInstance.timeScale().fitContent();
        }

        // Update ticker info
        if (data.ticker) {
            document.getElementById('chartPrice').textContent = formatIDR(data.ticker.last);
            document.getElementById('chartHigh').textContent = `H: ${formatIDR(data.ticker.high)}`;
            document.getElementById('chartLow').textContent = `L: ${formatIDR(data.ticker.low)}`;
            document.getElementById('chartVol').textContent = `Vol: ${parseFloat(data.ticker.vol).toLocaleString('id-ID')}`;
        }

        // Update depth
        if (data.depth) {
            renderDepth(data.depth);
        }
    } catch (err) {
        console.error('Chart data error:', err);
    }
}

function renderDepth(depth) {
    const container = document.getElementById('chartDepth');
    const bidRows = (depth.bids || []).map(b => `
        <div class="depth-row">
            <span class="price-bid">${formatIDR(parseFloat(b[0]))}</span>
            <span>${parseFloat(b[1]).toFixed(4)}</span>
        </div>
    `).join('');

    const askRows = (depth.asks || []).map(a => `
        <div class="depth-row">
            <span class="price-ask">${formatIDR(parseFloat(a[0]))}</span>
            <span>${parseFloat(a[1]).toFixed(4)}</span>
        </div>
    `).join('');

    container.innerHTML = `
        <div class="depth-side">
            <div class="depth-title bids">📗 Bids (Buy)</div>
            ${bidRows || '<div class="depth-row" style="color:var(--text-muted)">No data</div>'}
        </div>
        <div class="depth-side">
            <div class="depth-title asks">📕 Asks (Sell)</div>
            ${askRows || '<div class="depth-row" style="color:var(--text-muted)">No data</div>'}
        </div>
    `;
}

function changeTimeframe(tf, btn) {
    chartCurrentInterval = tf;
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadChartData();
}

function closeChartModal() {
    document.getElementById('chartModal').style.display = 'none';
    document.body.style.overflow = '';

    if (chartRefreshTimer) {
        clearInterval(chartRefreshTimer);
        chartRefreshTimer = null;
    }

    const container = document.getElementById('chartContainer');
    if (container._resizeObserver) {
        container._resizeObserver.disconnect();
        container._resizeObserver = null;
    }

    if (chartInstance) {
        chartInstance.remove();
        chartInstance = null;
        chartCandleSeries = null;
    }

    chartCurrentPair = null;
}

// Close chart modal on overlay click
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('chart-modal-overlay')) {
        closeChartModal();
    }
});
