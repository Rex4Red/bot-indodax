/**
 * Strategy helper - calculates buy/sell signals based on percentage thresholds
 */

function calculateChangePercent(currentPrice, referencePrice) {
    if (!referencePrice || referencePrice === 0) return 0;
    return ((currentPrice - referencePrice) / referencePrice) * 100;
}

function shouldBuy(currentPrice, referencePrice, buyThreshold) {
    if (!referencePrice || referencePrice === 0) return false;
    const change = calculateChangePercent(currentPrice, referencePrice);
    // Buy when price drops by buyThreshold% from reference
    return change <= -buyThreshold;
}

function shouldSellProfit(currentPrice, buyPrice, sellProfitThreshold) {
    if (!buyPrice || buyPrice === 0) return false;
    const change = calculateChangePercent(currentPrice, buyPrice);
    // Sell when price rises by sellProfitThreshold% from buy price
    return change >= sellProfitThreshold;
}

function shouldSellLoss(currentPrice, buyPrice, sellLossThreshold) {
    if (!buyPrice || buyPrice === 0) return false;
    const change = calculateChangePercent(currentPrice, buyPrice);
    // Sell (stop loss) when price drops by sellLossThreshold% from buy price
    return change <= -sellLossThreshold;
}

function calculateProfitLoss(sellPrice, buyPrice, amount) {
    const FEE_RATE = 0.003; // 0.3% Indodax fee per trade
    const sellTotal = sellPrice * amount;
    const buyTotal = buyPrice * amount;
    // Deduct buy fee (paid when buying) and sell fee (paid when selling)
    const buyFee = buyTotal * FEE_RATE;
    const sellFee = sellTotal * FEE_RATE;
    const netProfit = sellTotal - buyTotal - buyFee - sellFee;
    const netPct = buyTotal > 0 ? (netProfit / buyTotal) * 100 : 0;
    return {
        absolute: Math.round(netProfit),
        percentage: netPct,
        grossProfit: sellTotal - buyTotal,
        buyFee: Math.round(buyFee),
        sellFee: Math.round(sellFee),
        totalFee: Math.round(buyFee + sellFee)
    };
}

function calculateCoinAmount(idrAmount, price) {
    if (!price || price === 0) return 0;
    // Indodax requires max 8 decimal places
    const raw = idrAmount / price;
    return Math.floor(raw * 1e8) / 1e8;
}

function formatIDR(value) {
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(value);
}

module.exports = {
    calculateChangePercent,
    shouldBuy,
    shouldSellProfit,
    shouldSellLoss,
    calculateProfitLoss,
    calculateCoinAmount,
    formatIDR
};
