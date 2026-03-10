/**
 * Kraken Trading Service
 */

const krakenAPI = require('../config/kraken');

class TradingService {
  constructor() {
    this.pair = 'XETHZUSD';  // Kraken's official pair name
    this.displayPair = 'ETH/USD';
    this.feeRate = 0.0026;
  }

  async getBalances() {
    const balances = await krakenAPI.getBalance();
    return {
      USD: parseFloat(balances.ZUSD || balances.USD || 0),
      ETH: parseFloat(balances.XETH || balances.ETH || 0),
      BTC: parseFloat(balances.XXBT || balances.BTC || 0),
      LTC: parseFloat(balances.XLTC || balances.LTC || 0)
    };
  }

  async getETHPrice() {
    const ticker = await krakenAPI.getTicker(this.pair);
    const t = ticker[this.pair];
    if (!t) throw new Error('Price data unavailable');
    return {
      last: parseFloat(t.c[0]),
      bid: parseFloat(t.b[0]),
      ask: parseFloat(t.a[0]),
      high: parseFloat(t.h[1]),
      low: parseFloat(t.l[1]),
      volume: parseFloat(t.v[1]),
      pair: this.displayPair
    };
  }

  async buyETH(amountUSD, orderType = 'market', limitPrice = null) {
    const priceData = await this.getETHPrice();
    const currentPrice = orderType === 'limit' ? limitPrice : priceData.ask;
    const ethAmount = (amountUSD / currentPrice) * (1 - this.feeRate);
    
    const result = await krakenAPI.placeOrder(this.pair, 'buy', ethAmount, orderType, limitPrice);
    
    return {
      success: true,
      type: 'buy',
      amountUSD,
      ethAmount: ethAmount.toFixed(6),
      price: currentPrice,
      fee: (amountUSD * this.feeRate).toFixed(2),
      orderIds: result.txid,
      description: result.descr
    };
  }

  async sellETH(amountETH, orderType = 'market', limitPrice = null) {
    const priceData = await this.getETHPrice();
    const currentPrice = orderType === 'limit' ? limitPrice : priceData.bid;
    const usdReturn = (amountETH * currentPrice) * (1 - this.feeRate);
    
    const result = await krakenAPI.placeOrder(this.pair, 'sell', amountETH, orderType, limitPrice);
    
    return {
      success: true,
      type: 'sell',
      amountETH,
      usdReturn: usdReturn.toFixed(2),
      price: currentPrice,
      fee: (usdReturn * this.feeRate).toFixed(2),
      orderIds: result.txid,
      description: result.descr
    };
  }

  async getSummary() {
    const [balances, price] = await Promise.all([
      this.getBalances(),
      this.getETHPrice()
    ]);
    
    const ethValue = balances.ETH * price.last;
    const total = balances.USD + ethValue;
    
    return {
      balances,
      ethPrice: price.last,
      ethValueUSD: ethValue,
      totalPortfolioValue: total,
      feeRate: this.feeRate,
      timestamp: new Date().toISOString()
    };
  }

  async getOpenOrders() {
    const result = await krakenAPI.getOpenOrders();
    return result.open || [];
  }
}

module.exports = new TradingService();
