/**
 * Binance.US Trading Service
 * Direct REST API calls (bypasses library geo-detection issues)
 * PLUS WebSocket for real-time price (NO RATE LIMITS!)
 */

const https = require('https');
const crypto = require('crypto');
const WebSocket = require('ws');

class BinanceUSService {
  constructor() {
    this.apiKey = process.env.BINANCE_API_KEY;
    this.apiSecret = process.env.BINANCE_API_SECRET;
    this.baseUrl = 'https://api.binance.us';
    this.ws = null;
    this.priceCache = { last: 0, bid: 0, ask: 0, high: 0, low: 0, volume: 0 };
    this.currentPrice = 0;
    
    // Rate limiting & caching to prevent bans
    this.balanceCache = null;
    this.balanceCacheTime = 0;
    this.orderHistoryCache = null;
    this.orderHistoryCacheTime = 0;
    this.lastRequestTime = 0;
    this.minRequestInterval = 2000; // Minimum 2 seconds between REST calls
    
    // Start WebSocket for real-time price (no rate limits!)
    this.startPriceWebSocket();
  }
  
  /**
   * Rate limit helper - wait between requests
   */
  async rateLimitDelay() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minRequestInterval) {
      const delay = this.minRequestInterval - elapsed;
      console.log(`⏳ Rate limit delay: ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    this.lastRequestTime = Date.now();
  }
  
  /**
   * Get cached balances (valid for 60 seconds)
   */
  getCachedBalances() {
    const now = Date.now();
    if (this.balanceCache && (now - this.balanceCacheTime) < 60000) {
      console.log('📦 Returning cached balances (60s cache)');
      return this.balanceCache;
    }
    return null;
  }
  
  /**
   * Get cached order history (valid for 30 seconds)
   */
  getCachedOrderHistory() {
    const now = Date.now();
    if (this.orderHistoryCache && (now - this.orderHistoryCacheTime) < 30000) {
      console.log('📜 Returning cached order history (30s cache)');
      return this.orderHistoryCache;
    }
    return null;
  }
  
  /**
   * WebSocket for real-time ETH/USD price - NO RATE LIMITS!
   * Works even when IP is banned from REST API
   */
  startPriceWebSocket() {
    try {
      if (this.ws) {
        this.ws.close();
      }
      
      // Binance.US public WebSocket stream (no API keys needed for ticker!)
      this.ws = new WebSocket('wss://stream.binance.us:9443/ws/ethusd@ticker');
      
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
   * Get current price from WebSocket cache (instant, no rate limit)
   */
  getCurrentPrice() {
    return this.currentPrice || 0;
  }

  // Make signed request to Binance.US
  async request(endpoint, params = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
      const timestamp = Date.now();
      const data = { ...params, timestamp };
      const queryString = new URLSearchParams(data).toString();
      
      const signature = crypto
        .createHmac('sha256', this.apiSecret)
        .update(queryString)
        .digest('hex');
      
      const url = `${this.baseUrl}${endpoint}?${queryString}&signature=${signature}`;
      
      const options = {
        hostname: 'api.binance.us',
        path: endpoint + '?' + queryString + '&signature=' + signature,
        method: method,
        headers: {
          'X-MBX-APIKEY': this.apiKey,
          'Content-Type': 'application/json'
        }
      };
      
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.code && json.code < 0) {
              reject(new Error(json.msg || 'Binance.US API error'));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(e);
          }
        });
      });
      
      req.on('error', reject);
      req.end();
    });
  }

  // Make unsigned public request
  async publicRequest(endpoint, params = {}) {
    return new Promise((resolve, reject) => {
      const queryString = new URLSearchParams(params).toString();
      const url = `${this.baseUrl}${endpoint}${queryString ? '?' + queryString : ''}`;
      
      const options = {
        hostname: 'api.binance.us',
        path: endpoint + (queryString ? '?' + queryString : ''),
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      };
      
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      });
      
      req.on('error', reject);
      req.end();
    });
  }

  async getBalances() {
    // Check cache first (60 second cache)
    const cached = this.getCachedBalances();
    if (cached) {
      return cached;
    }
    
    // Rate limit before making request
    await this.rateLimitDelay();
    
    try {
      console.log('📡 Fetching fresh balances from API...');
      const accountInfo = await this.request('/api/v3/account');
      const balances = {};
      
      accountInfo.balances.forEach(balance => {
        const free = parseFloat(balance.free);
        const locked = parseFloat(balance.locked);
        const total = free + locked;
        if (total > 0) {
          balances[balance.asset] = { free, locked, total };
        }
      });
      
      // Cache the result
      this.balanceCache = balances;
      this.balanceCacheTime = Date.now();
      console.log('✅ Balances cached for 60 seconds');
      
      return balances;
    } catch (error) {
      console.error('Binance.US balance error:', error.message);
      // Return cached data on error if available
      if (this.balanceCache) {
        console.log('⚠️ Returning stale cache due to error');
        return this.balanceCache;
      }
      throw error;
    }
  }

  async getTicker(symbol = 'ETHUSD') {
    // Return cached WebSocket data (instant, no rate limit!)
    if (this.priceCache && this.priceCache.last > 0) {
      console.log('📡 Returning cached WebSocket price:', this.priceCache.last.toFixed(2));
      return this.priceCache;
    }
    
    // Fallback to REST API if WebSocket not ready (rate-limited!)
    console.warn('⚠️ WebSocket not ready, falling back to REST API (rate-limited)');
    try {
      const ticker = await this.publicRequest('/api/v3/ticker/24hr', { symbol });
      const lastPrice = parseFloat(ticker.lastPrice);
      
      return {
        last: lastPrice,
        bid: lastPrice * 0.9999,
        ask: lastPrice * 1.0001,
        high: parseFloat(ticker.highPrice),
        low: parseFloat(ticker.lowPrice),
        volume: parseFloat(ticker.volume),
        pair: 'ETH/USD'
      };
    } catch (error) {
      console.error('Binance.US ticker error:', error.message);
      throw error;
    }
  }

  async buyETH(amountUSD) {
    try {
      const ticker = await this.getTicker('ETHUSD');
      const price = ticker.ask;
      const feeRate = 0.001;
      
      const ethAmount = (amountUSD / price) * (1 - feeRate);
      
      // Place market buy order
      const order = await this.request('/api/v3/order', {
        symbol: 'ETHUSD',
        side: 'BUY',
        type: 'MARKET',
        quantity: ethAmount.toFixed(6)
      }, 'POST');
      
      const executedQty = parseFloat(order.executedQty || ethAmount);
      const executedValue = parseFloat(order.cummulativeQuoteQty || amountUSD);
      const fee = executedValue * feeRate;
      
      return {
        success: true,
        data: {
          type: 'buy',
          amountUSD: executedValue,
          ethAmount: executedQty.toFixed(6),
          price,
          fee: fee.toFixed(2),
          orderId: order.orderId,
          status: order.status
        }
      };
    } catch (error) {
      console.error('Binance.US buy error:', error.message);
      throw error;
    }
  }

  async buyETHAmount(amountETH, limitPrice = null) {
    try {
      const ticker = await this.getTicker('ETHUSD');
      const price = ticker.ask;
      const feeRate = 0.001;
      
      const estimatedUSD = amountETH * price;
      
      // Place order (LIMIT if limitPrice provided, otherwise MARKET)
      const orderParams = {
        symbol: 'ETHUSD',
        side: 'BUY',
        quantity: amountETH.toFixed(6)
      };
      
      if (limitPrice && limitPrice > 0) {
        // LIMIT order - execute at specified price or better
        orderParams.type = 'LIMIT';
        orderParams.price = limitPrice.toFixed(2);
        orderParams.timeInForce = 'GTC'; // Good Till Cancel
        console.log('📊 Placing LIMIT buy order:', amountETH, 'ETH @ $' + limitPrice.toFixed(2));
      } else {
        // MARKET order - execute immediately at current price
        orderParams.type = 'MARKET';
        console.log('📊 Placing MARKET buy order:', amountETH, 'ETH');
      }
      
      const order = await this.request('/api/v3/order', orderParams, 'POST');
      
      const executedQty = parseFloat(order.executedQty || amountETH);
      const executedValue = parseFloat(order.cummulativeQuoteQty || estimatedUSD);
      const fee = executedValue * feeRate;
      
      return {
        success: true,
        data: {
          type: 'buy',
          orderType: limitPrice ? 'limit' : 'market',
          limitPrice: limitPrice || null,
          amountUSD: executedValue,
          ethAmount: executedQty.toFixed(6),
          price: limitPrice || price,
          fee: fee.toFixed(2),
          orderId: order.orderId,
          status: order.status
        }
      };
    } catch (error) {
      console.error('Binance.US buy error:', error.message);
      throw error;
    }
  }

  async sellETH(amountETH) {
    try {
      const ticker = await this.getTicker('ETHUSD');
      const price = ticker.bid;
      const feeRate = 0.001;
      
      const order = await this.request('/api/v3/order', {
        symbol: 'ETHUSD',
        side: 'SELL',
        type: 'MARKET',
        quantity: amountETH.toFixed(6)
      }, 'POST');
      
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
      console.error('Binance.US sell error:', error.message);
      throw error;
    }
  }

  async sellETHLimit(amountETH, limitPrice) {
    try {
      const feeRate = 0.001;
      
      const order = await this.request('/api/v3/order', {
        symbol: 'ETHUSD',
        side: 'SELL',
        type: 'LIMIT',
        quantity: amountETH.toFixed(6),
        price: limitPrice.toFixed(2),
        timeInForce: 'GTC' // Good Till Canceled
      }, 'POST');
      
      const executedQty = parseFloat(order.executedQty || 0);
      const executedValue = parseFloat(order.cummulativeQuoteQty || 0);
      const fee = executedValue * feeRate;
      
      return {
        success: true,
        data: {
          type: 'sell',
          orderType: 'limit',
          amountETH: amountETH.toFixed(6),
          limitPrice: limitPrice,
          executedQty: executedQty.toFixed(6),
          usdReturn: executedValue > 0 ? executedValue.toFixed(2) : 'Pending',
          price: limitPrice,
          fee: fee > 0 ? fee.toFixed(2) : 'Pending',
          orderId: order.orderId,
          status: order.status
        }
      };
    } catch (error) {
      console.error('Binance.US limit sell error:', error.message);
      throw error;
    }
  }

  async sellAsset(asset, amount) {
    try {
      const ticker = await this.getTicker(`${asset}USD`);
      const price = ticker.bid;
      const feeRate = 0.001;
      
      const order = await this.request('/api/v3/order', {
        symbol: `${asset}USD`,
        side: 'SELL',
        type: 'MARKET',
        quantity: amount.toFixed(6)
      }, 'POST');
      
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
      console.error(`Binance.US sell ${asset} error:`, error.message);
      throw error;
    }
  }

  async sellAssetLimit(asset, amount, limitPrice) {
    try {
      const feeRate = 0.001;
      
      const order = await this.request('/api/v3/order', {
        symbol: `${asset}USD`,
        side: 'SELL',
        type: 'LIMIT',
        quantity: amount.toFixed(6),
        price: limitPrice.toFixed(2),
        timeInForce: 'GTC'
      }, 'POST');
      
      const executedQty = parseFloat(order.executedQty || 0);
      const executedValue = parseFloat(order.cummulativeQuoteQty || 0);
      const fee = executedValue * feeRate;
      
      return {
        success: true,
        data: {
          type: 'sell',
          orderType: 'limit',
          asset,
          amount: amount.toFixed(6),
          limitPrice: limitPrice,
          executedQty: executedQty.toFixed(6),
          usdReturn: executedValue > 0 ? executedValue.toFixed(2) : 'Pending',
          price: limitPrice,
          fee: fee > 0 ? fee.toFixed(2) : 'Pending',
          orderId: order.orderId,
          status: order.status
        }
      };
    } catch (error) {
      console.error(`Binance.US limit sell ${asset} error:`, error.message);
      throw error;
    }
  }

  async testConnection() {
    try {
      await this.request('/api/v3/account');
      return { success: true, message: 'Binance.US connection successful' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = new BinanceUSService();
