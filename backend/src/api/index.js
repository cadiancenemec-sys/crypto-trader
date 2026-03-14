const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const { dbHelpers } = require('../db');

// Rate limiter state
const rateLimiter = {
  queue: [],
  processing: false,
  lastCallTime: 0,
  minIntervalMs: 100, // Space calls at least 100ms apart (adjust based on Binance limits)
  weightPerSecond: 1200, // Binance US weight limit
  currentWeight: 0,
  windowStart: Date.now(),
};

// Process the rate limit queue
async function processQueue() {
  if (rateLimiter.processing || rateLimiter.queue.length === 0) return;
  
  rateLimiter.processing = true;
  
  while (rateLimiter.queue.length > 0) {
    const now = Date.now();
    
    // Reset weight counter every second
    if (now - rateLimiter.windowStart >= 1000) {
      rateLimiter.currentWeight = 0;
      rateLimiter.windowStart = now;
    }
    
    // Wait if we hit the weight limit
    const estimatedWeight = rateLimiter.queue[0].weight || 1;
    if (rateLimiter.currentWeight + estimatedWeight > rateLimiter.weightPerSecond) {
      const waitTime = 1000 - (now - rateLimiter.windowStart);
      if (waitTime > 0) {
        await sleep(waitTime);
      }
      continue;
    }
    
    // Wait for minimum interval between calls
    const timeSinceLastCall = now - rateLimiter.lastCallTime;
    if (timeSinceLastCall < rateLimiter.minIntervalMs) {
      await sleep(rateLimiter.minIntervalMs - timeSinceLastCall);
    }
    
    const item = rateLimiter.queue.shift();
    rateLimiter.currentWeight += item.weight || 1;
    rateLimiter.lastCallTime = Date.now();
    
    try {
      const result = await item.execute();
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    }
  }
  
  rateLimiter.processing = false;
}

// Add request to queue
function enqueue(requestFn, weight = 1) {
  return new Promise((resolve, reject) => {
    rateLimiter.queue.push({ execute: requestFn, weight, resolve, reject });
    processQueue();
  });
}

// Helper for sleeping
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Public endpoints that don't require authentication
const PUBLIC_ENDPOINTS = [
  '/api/v3/ticker/price',
  '/api/v3/ticker/24hr',
  '/api/v3/depth',
  '/api/v3/klines',
  '/api/v3/exchangeInfo'
];

function isPublicEndpoint(endpoint) {
  return PUBLIC_ENDPOINTS.some(public => endpoint.startsWith(public));
}

// ==================== BINANCE API CLIENT ====================

const binance = {
  // Base request handler with HMAC signature
  async request(method, endpoint, params = {}) {
    return enqueue(async () => {
      // Skip signing for public endpoints
      if (isPublicEndpoint(endpoint)) {
        const queryString = Object.keys(params)
          .sort()
          .map(key => `${key}=${params[key]}`)
          .join('&');
        
        const url = `${config.binance.baseUrl}${endpoint}${queryString ? '?' + queryString : ''}`;
        
        const response = await axios({
          method,
          url,
          headers: {
            'Content-Type': 'application/json'
          }
        });
        
        return response.data;
      }
      
      // Add timestamp to params for signed endpoints
      params.timestamp = Date.now();
      
      // Create query string and signature
      const queryString = Object.keys(params)
        .sort()
        .map(key => `${key}=${params[key]}`)
        .join('&');
      
      const signature = crypto
        .createHmac('sha256', config.binance.apiSecret)
        .update(queryString)
        .digest('hex');
      
      const url = `${config.binance.baseUrl}${endpoint}?${queryString}&signature=${signature}`;
      
      try {
        const response = await axios({
          method,
          url,
          headers: {
            'X-MBX-APIKEY': config.binance.apiKey,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        });
        
        // Log the API call
        dbHelpers.log('API_CALL', `${method} ${endpoint} - Success`);
        
        return response.data;
      } catch (error) {
        const errorMsg = error.response?.data?.msg || error.message;
        const status = error.response?.status;
        
        dbHelpers.log('API_ERROR', `${method} ${endpoint} - ${status}: ${errorMsg}`);
        
        // Handle rate limiting (429)
        if (status === 429 || status === 418) {
          const retryAfter = error.response?.headers['retry-after'] || 60;
          console.log(`Rate limited! Waiting ${retryAfter}s before retry...`);
          await sleep(retryAfter * 1000);
          throw new Error('Rate limited - please retry');
        }
        
        throw error;
      }
    }, endpoint.includes('order') ? 10 : 1); // Orders cost more weight
  },

  // GET requests
  async get(endpoint, params) {
    return this.request('GET', endpoint, params);
  },

  // POST requests
  async post(endpoint, params) {
    return this.request('POST', endpoint, params);
  },

  // DELETE requests
  async delete(endpoint, params) {
    return this.request('DELETE', endpoint, params);
  },
};

// ==================== TRADING ENDPOINTS ====================

binance.trading = {
  // Get account balance
  async getAccount() {
    return binance.get('/api/v3/account');
  },

  // Get current price
  async getPrice(symbol) {
    return binance.get('/api/v3/ticker/price', { symbol });
  },

  // Get 24hr ticker (more info)
  async get24hrTicker(symbol) {
    return binance.get('/api/v3/ticker/24hr', { symbol });
  },

  // Get order book
  async getOrderBook(symbol, limit = 20) {
    return binance.get('/api/v3/depth', { symbol, limit });
  },

  // Place market order
  async placeMarketOrder(symbol, side, quantity) {
    const params = {
      symbol,
      side: side.toUpperCase(),
      type: 'MARKET',
      quantity
    };
    
    const result = await binance.post('/api/v3/order', params);
    
    // Log the trade
    dbHelpers.createTrade({
      order_id: result.orderId,
      symbol: result.symbol,
      side: result.side,
      quantity: parseFloat(result.executedQty),
      price: parseFloat(result.price || 0),
      total: parseFloat(result.cummulativeQuoteQty),
      status: result.status === 'FILLED' ? 'filled' : 'pending'
    });
    
    dbHelpers.log('TRADE_PLACED', `${side} ${quantity} ${symbol} at market`);
    
    return result;
  },

  // Place limit order
  async placeLimitOrder(symbol, side, quantity, price, timeInForce = 'GTC') {
    const params = {
      symbol,
      side: side.toUpperCase(),
      type: 'LIMIT',
      quantity,
      price,
      timeInForce
    };
    
    const result = await binance.post('/api/v3/order', params);
    
    // Log the order
    dbHelpers.createOrder({
      order_id: result.orderId,
      symbol: result.symbol,
      side: result.side,
      type: 'limit',
      quantity: parseFloat(result.origQty),
      price: parseFloat(result.price),
      time_in_force: result.timeInForce,
      status: result.status === 'NEW' ? 'open' : result.status.toLowerCase()
    });
    
    dbHelpers.log('ORDER_PLACED', `${side} ${quantity} ${symbol} @ ${price} (limit)`);
    
    return result;
  },

  // Cancel order
  async cancelOrder(symbol, orderId) {
    const result = await binance.delete('/api/v3/order', { symbol, orderId });
    
    dbHelpers.updateOrderStatus(orderId, 'cancelled');
    dbHelpers.log('ORDER_CANCELLED', `${orderId} on ${symbol}`);
    
    return result;
  },

  // Check order status
  async getOrder(symbol, orderId) {
    return binance.get('/api/v3/order', { symbol, orderId });
  },

  // Get open orders for a symbol
  async getOpenOrders(symbol) {
    return binance.get('/api/v3/openOrders', { symbol });
  },

  // Get all open orders (no symbol filter) - goes through rate limiter
  async getAllOpenOrders() {
    return binance.get('/api/v3/openOrders', {});
  },

  // Get all orders for symbol
  async getAllOrders(symbol, limit = 100) {
    return binance.get('/api/v3/allOrders', { symbol, limit });
  },

  // Get trade history
  async getMyTrades(symbol, limit = 100) {
    return binance.get('/api/v3/myTrades', { symbol, limit });
  },

  // User Data Stream - create listenKey (separate from rate limiter)
  // Using direct axios call to avoid rate limiter interference
  async createListenKey() {
    const response = await axios.post(
      `${config.binance.baseUrl}/api/v3/userDataStream`,
      '',
      {
        headers: { 
          'X-MBX-APIKEY': config.binance.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    return response.data.listenKey;
  },

  // User Data Stream - ping to keep alive
  async pingListenKey(listenKey) {
    await axios.put(
      `${config.binance.baseUrl}/api/v3/userDataStream`,
      `listenKey=${listenKey}`,
      {
        headers: { 
          'X-MBX-APIKEY': config.binance.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
  },

  // User Data Stream - close
  async deleteListenKey(listenKey) {
    await axios.delete(
      `${config.binance.baseUrl}/api/v3/userDataStream?listenKey=${listenKey}`,
      {
        headers: { 'X-MBX-APIKEY': config.binance.apiKey }
      }
    );
  },

  // Get klines (candlestick) data
  async getKlines(symbol, interval, limit = 100) {
    const klines = await binance.get('/api/v3/klines', { symbol, interval, limit });
    
    // Parse and store in database
    const parsed = klines.map(k => ({
      symbol,
      interval,
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      timestamp: new Date(k[0]).toISOString()
    }));
    
    // Store in DB
    for (const candle of parsed) {
      dbHelpers.insertPriceCandle(candle);
    }
    
    return parsed;
  }
};

// ==================== RATE LIMITER STATUS ====================

binance.getRateLimitStatus = () => ({
  queueLength: rateLimiter.queue.length,
  currentWeight: rateLimiter.currentWeight,
  weightLimit: rateLimiter.weightPerSecond,
  windowSeconds: (Date.now() - rateLimiter.windowStart) / 1000
});

module.exports = binance;