/**
 * Binance.US Trading Service
 * Using binance-api-node package
 */

const binance = require('binance-api-node').default;

class BinanceService {
  constructor() {
    this.client = null;
    this.initialized = false;
    this.ws = null;
    this.currentPrice = null;
    this.priceCache = { last: 0, bid: 0, ask: 0, high: 0, low: 0, volume: 0 };
  }

  init() {
    if (this.initialized) return this.client;
    
    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_API_SECRET;
    
    if (!apiKey || !apiSecret) {
      throw new Error('Binance.US credentials not configured');
    }
    
    try {
      this.client = binance({
        apiKey,
        apiSecret,
        // Force Binance.US endpoint (not Binance.com)
        urls: {
          base: 'https://api.binance.us',
        }
      });
      
      this.initialized = true;
      console.log('Binance.US client initialized (using api.binance.us)');
      
      // Start WebSocket for real-time price (no rate limits!)
      this.startPriceWebSocket();
      
      return this.client;
    } catch (error) {
      console.log('Binance.US initialization skipped:', error.message);
      throw error;
    }
  }

  /**
   * WebSocket for real-time ETH/USD price - NO RATE LIMITS!
   * Starts independently of REST API (works even when IP is banned)
   */
  startPriceWebSocket() {
    try {
      if (this.ws) {
        this.ws.close();
      }
      
      // Binance.US public WebSocket stream (no API keys needed for ticker!)
      const ws = require('ws');
      this.ws = new ws('wss://stream.binance.us:9443/ws/ethusd@ticker');
      
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        this.priceCache = {
          last: parseFloat(msg.c),
          bid: parseFloat(msg.b),
          ask: parseFloat(msg.a),
          high: parseFloat(msg.h),
          low: parseFloat(msg.l),
          volume: parseFloat(msg.v)
        };
        this.currentPrice = this.priceCache.last;
        console.log('📊 Binance WebSocket Price Update:', this.currentPrice.toFixed(2));
      });
      
      this.ws.on('open', () => {
        console.log('✅ Binance.US WebSocket connected (no rate limits!)');
      });
      
      this.ws.on('error', (err) => {
        console.warn('⚠️ WebSocket error:', err.message);
      });
      
    } catch (error) {
      console.warn('⚠️ WebSocket setup failed:', error.message);
    }
  }

  /**
   * Get ticker from WebSocket cache (instant, no API call)
   */
  async getTicker(symbol) {
    // Return cached WebSocket data (instant, no rate limit)
    if (this.priceCache && this.priceCache.last > 0) {
      console.log('📡 Returning cached WebSocket price:', this.priceCache.last.toFixed(2));
      return this.priceCache;
    }
    
    // Fallback to REST API if WebSocket not ready (rate-limited!)
    console.warn('⚠️ WebSocket not ready, falling back to REST API (rate-limited)');
    const client = this.init();
    const ticker = await client.prices({ symbol: 'ETHUSD' });
    return {
      last: parseFloat(ticker.ETHUSD),
      bid: 0,
      ask: 0,
      high: 0,
      low: 0,
      volume: 0
    };
  }

  /**
   * Get current price from WebSocket cache
   */
  getCurrentPrice() {
    return this.currentPrice || 0;
  }

  async getBalances() {
    try {
      if (!this.initialized) {
        console.log('Binance: Skipping initialization - not configured or restricted');
        return { USD: { total: 0 }, ETH: { total: 0 }, BTC: { total: 0 }, LTC: { total: 0 } };
      }
      const client = this.init();
      const accountInfo = await client.accountInfo();
      
      const balances = {};
      accountInfo.balances.forEach(balance => {
        const free = parseFloat(balance.free);
        const locked = parseFloat(balance.locked);
        const total = free + locked;
        if (total > 0) {
          balances[balance.asset] = {
            free,
            locked,
            total
          };
        }
      });
      
      return balances;
    } catch (error) {
      console.error('Binance balance error:', error.message);
      throw error;
    }
  }

  async getPrice(symbol = 'ETHUSD') {
    try {
      const client = this.init();
      // Binance.US uses ETHUSD format
      const ticker = await client.prices({ symbol: 'ETHUSD' });
      const price = parseFloat(ticker.ETHUSD);
      
      // Get 24hr stats
      const stats = await client.prices({ symbol: 'ETHUSD' });
      
      return {
        last: price,
        bid: price * 0.9999, // Approximate
        ask: price * 1.0001, // Approximate
        high: price * 1.05, // Will get from 24hr stats
        low: price * 0.95,
        volume: 0, // Will get from 24hr stats
        pair: 'ETH/USD'
      };
    } catch (error) {
      console.error('Binance price error:', error.message);
      throw error;
    }
  }

  async get24hrStats(symbol = 'ETHUSD') {
    try {
      const client = this.init();
      const stats = await client.dailyStats({ symbol: 'ETHUSD' });
      return {
        high: parseFloat(stats.highPrice),
        low: parseFloat(stats.lowPrice),
        volume: parseFloat(stats.volume)
      };
    } catch (error) {
      console.error('Binance 24hr stats error:', error.message);
      return { high: 0, low: 0, volume: 0 };
    }
  }

  async getTicker(symbol = 'ETHUSD') {
    try {
      const client = this.init();
      const price = await client.prices({ symbol });
      const stats = await this.get24hrStats(symbol);
      const lastPrice = parseFloat(price[symbol]);
      
      return {
        last: lastPrice,
        bid: lastPrice * 0.9999,
        ask: lastPrice * 1.0001,
        high: stats.high,
        low: stats.low,
        volume: stats.volume,
        pair: symbol.replace('USD', '/USD')
      };
    } catch (error) {
      console.error('Binance ticker error:', error.message);
      throw error;
    }
  }

  async buyETH(amountUSD, limitPrice = null) {
    try {
      const client = this.init();
      const feeRate = 0.001; // Binance.US fee: 0.1%
      
      if (limitPrice && limitPrice > 0) {
        // Limit order
        const ticker = await this.getTicker('ETHUSD');
        const marketPrice = ticker.ask;
        
        // Calculate ETH amount based on limit price
        const ethAmount = (amountUSD / limitPrice) * (1 - feeRate);
        
        // Place limit order
        const order = await client.orders.limitBuy({
          symbol: 'ETHUSD',
          quantity: ethAmount.toFixed(6),
          price: limitPrice.toFixed(2)
        });
        
        return {
          success: true,
          data: {
            type: 'buy',
            orderType: 'limit',
            limitPrice: limitPrice,
            marketPrice: marketPrice,
            amountUSD: amountUSD,
            ethAmount: ethAmount.toFixed(6),
            price: limitPrice,
            fee: (amountUSD * feeRate).toFixed(2),
            orderId: order.orderId,
            status: order.status
          }
        };
      } else {
        // Market order
        const ticker = await this.getTicker('ETHUSD');
        const price = ticker.ask;
        
        // Calculate ETH amount
        const ethAmount = (amountUSD / price) * (1 - feeRate);
        
        // Place market order (Binance uses quantity in base asset)
        const order = await client.orders.marketBuy({
          symbol: 'ETHUSD',
          quantity: ethAmount.toFixed(6)
        });
        
        const executedQty = parseFloat(order.executedQty || ethAmount);
        const executedValue = parseFloat(order.cummulativeQuoteQty || amountUSD);
        const fee = executedValue * feeRate;
        
        return {
          success: true,
          data: {
            type: 'buy',
            orderType: 'market',
            amountUSD: executedValue,
            ethAmount: executedQty.toFixed(6),
            price,
            fee: fee.toFixed(2),
            orderId: order.orderId,
            status: order.status
          }
        };
      }
    } catch (error) {
      console.error('Binance buy error:', error.message);
      throw error;
    }
  }

  async buyETHAmount(amountETH, limitPrice = null) {
    try {
      const client = this.init();
      const feeRate = 0.001; // Binance.US fee: 0.1%
      
      if (limitPrice && limitPrice > 0) {
        // Limit order - buy specific ETH amount at limit price
        const ticker = await this.getTicker('ETHUSD');
        const marketPrice = ticker.ask;
        
        // Place limit order
        const order = await client.orders.limitBuy({
          symbol: 'ETHUSD',
          quantity: amountETH.toFixed(6),
          price: limitPrice.toFixed(2)
        });
        
        const estimatedValue = amountETH * limitPrice;
        
        return {
          success: true,
          data: {
            type: 'buy',
            orderType: 'limit',
            limitPrice: limitPrice,
            marketPrice: marketPrice,
            ethAmount: amountETH.toFixed(6),
            estimatedUSD: estimatedValue.toFixed(2),
            price: limitPrice,
            fee: (estimatedValue * feeRate).toFixed(2),
            orderId: order.orderId,
            status: order.status
          }
        };
      } else {
        // Market order - buy specific ETH amount at market price
        const ticker = await this.getTicker('ETHUSD');
        const price = ticker.ask;
        
        // Place market order
        const order = await client.orders.marketBuy({
          symbol: 'ETHUSD',
          quantity: amountETH.toFixed(6)
        });
        
        const executedQty = parseFloat(order.executedQty || amountETH);
        const executedValue = parseFloat(order.cummulativeQuoteQty || (amountETH * price));
        const fee = executedValue * feeRate;
        
        return {
          success: true,
          data: {
            type: 'buy',
            orderType: 'market',
            ethAmount: executedQty.toFixed(6),
            amountUSD: executedValue,
            price,
            fee: fee.toFixed(2),
            orderId: order.orderId,
            status: order.status
          }
        };
      }
    } catch (error) {
      console.error('Binance buyETHAmount error:', error.message);
      throw error;
    }
  }

  async sellETH(amountETH) {
    try {
      const client = this.init();
      const ticker = await this.getTicker('ETHUSD');
      const price = ticker.bid;
      const feeRate = 0.001; // Binance.US fee: 0.1%
      
      // Place market sell order
      const order = await client.orders.marketSell({
        symbol: 'ETHUSD',
        quantity: amountETH.toFixed(6)
      });
      
      const executedQty = parseFloat(order.executedQty || amountETH);
      const executedValue = parseFloat(order.cummulativeQuoteQty || (amountETH * price));
      const fee = executedValue * feeRate;
      
      return {
        success: true,
        data: {
          type: 'sell',
          amountETH: executedQty.toFixed(6),
          usdReturn: executedValue.toFixed(2),
          price,
          fee: fee.toFixed(2),
          orderId: order.orderId,
          status: order.status
        }
      };
    } catch (error) {
      console.error('Binance sell error:', error.message);
      throw error;
    }
  }

  async sellAsset(asset, amount) {
    try {
      const client = this.init();
      const symbol = `${asset}USD`;
      const feeRate = 0.001;
      
      const ticker = await this.getTicker(symbol);
      const price = ticker.bid;
      
      const order = await client.orders.marketSell({
        symbol: symbol,
        quantity: amount.toFixed(6)
      });
      
      const executedQty = parseFloat(order.executedQty || amount);
      const executedValue = parseFloat(order.cummulativeQuoteQty || (amount * price));
      const fee = executedValue * feeRate;
      
      return {
        success: true,
        data: {
          type: 'sell',
          asset,
          amount: executedQty.toFixed(6),
          usdReturn: executedValue.toFixed(2),
          price,
          fee: fee.toFixed(2),
          orderId: order.orderId,
          status: order.status
        }
      };
    } catch (error) {
      console.error(`Binance sell ${asset} error:`, error.message);
      throw error;
    }
  }

  async testConnection() {
    try {
      const client = this.init();
      await client.accountInfo();
      return { success: true, message: 'Binance.US connection successful' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async checkTradingEnabled() {
    try {
      const client = this.init();
      // Try a small test order
      await client.orderTest({
        symbol: 'ETHUSD',
        side: 'BUY',
        type: 'MARKET',
        quantity: '0.001'
      });
      return { success: true, tradingEnabled: true };
    } catch (error) {
      return { 
        success: false, 
        tradingEnabled: false, 
        error: error.message 
      };
    }
  }
}

module.exports = new BinanceService();
