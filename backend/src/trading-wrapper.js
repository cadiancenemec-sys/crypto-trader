/**
 * Trading Wrapper - switches between mock and real Binance
 * 
 * USE_MOCK=false uses real Binance US API
 * USE_MOCK=true (default) uses mock exchange
 */

const mockExchange = require('./mock-exchange');
const binance = require('./api');
const fs = require('fs');
const path = require('path');

const USE_MOCK = process.env.USE_MOCK !== 'false';
const STATE_FILE = path.join(__dirname, '..', '..', 'data-prod', 'processed-orders.json');

// Track processed order IDs for real Binance
let processedOrderIds = new Set();

// Load processed orders on startup
function loadProcessedOrders() {
  if (USE_MOCK) return;
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      processedOrderIds = new Set(data.processedOrderIds || []);
      console.log('[Trading] Loaded', processedOrderIds.size, 'processed order IDs');
    }
  } catch (e) {
    console.log('[Trading] No processed orders file yet');
  }
}
loadProcessedOrders();

function isOrderProcessed(orderId) {
  return processedOrderIds.has(String(orderId));
}

function markOrderProcessed(orderId) {
  processedOrderIds.add(String(orderId));
}

// Cache for real prices
let priceCache = {};
let priceCacheTime = 0;
const PRICE_CACHE_TTL = 5000; // 5 seconds

async function getPrice(symbol) {
  if (USE_MOCK) {
    return mockExchange.getPrice(symbol);
  }
  
  // Use live Binance
  try {
    const ticker = await binance.trading.getPrice(symbol);
    return parseFloat(ticker.price);
  } catch (e) {
    console.error(`[Trading] Failed to get price for ${symbol}:`, e.message);
    return priceCache[symbol] || 0;
  }
}

async function getAllPrices() {
  if (USE_MOCK) {
    return mockExchange.getAllPrices();
  }
  
  // Fetch live prices from Binance
  // Binance US uses USD (not USDT) for fiat accounts
  const symbols = USE_MOCK ? ['ETHUSDT', 'BTCUSDT', 'LTCUSDT'] : ['ETHUSD', 'BTCUSD', 'LTCUSD'];
  const prices = {};
  
  for (const symbol of symbols) {
    try {
      const ticker = await binance.trading.getPrice(symbol);
      prices[symbol] = parseFloat(ticker.price);
    } catch (e) {
      prices[symbol] = priceCache[symbol] || 0;
    }
  }
  
  // Update cache
  priceCache = { ...prices };
  priceCacheTime = Date.now();
  
  return prices;
}

// Get all orders for a symbol (sync for mock, async for real)
async function getAllOrders(symbol) {
  if (!symbol) {
    console.error('[Trading] getAllOrders called with empty symbol');
    return [];
  }
  if (USE_MOCK) {
    return mockExchange.getAllOrders(symbol);
  }
  
  // Real Binance - fetch all orders (including filled)
  try {
    // Fetch open orders
    const openResult = await binance.trading.getAllOrders(symbol);
    // Make sure we return an array - handle any response format
    if (!openResult) {
      return [];
    }
    
    let openOrders = openResult;
    if (!Array.isArray(openResult) && typeof openResult === 'object') {
      if (Array.isArray(openResult.data)) openOrders = openResult.data;
      else if (Array.isArray(openResult.orders)) openOrders = openResult.orders;
      else if (Array.isArray(openResult.result)) openOrders = openResult.result;
      else {
        console.log(`[Trading] getAllOrders unexpected response type:`, typeof openResult);
        openOrders = [];
      }
    }
    
    // Fetch trade history to find filled orders
    let filledFromTrades = [];
    try {
      const trades = await binance.fetchMyTrades(symbol);
      if (Array.isArray(trades)) {
        // Convert trades to order format
        filledFromTrades = trades.map(t => ({
          orderId: t.orderId,
          quantity: t.amount || t.quantity || 0,
          price: t.price || 0,
          side: t.side || t.type,
          status: 'FILLED',
          filledAt: new Date(t.timestamp || t.time).toISOString()
        }));
      }
    } catch (e) {
      console.log(`[Trading] Could not fetch trade history:`, e.message);
    }
    
    // Merge open orders with filled orders from trades
    const allOrders = [...openOrders, ...filledFromTrades];
    
    // Normalize field names for consistency (Binance uses origQty)
    return allOrders.map(o => ({
      ...o,
      quantity: o.quantity || o.origQty || o.executedQty || 0,
      price: o.price || 0,
      side: o.side || o.type,
      status: o.status
    }));
  } catch (e) {
    console.error(`[Trading] Failed to fetch orders:`, e.message);
    return [];
  }
}

// Get open orders for a symbol
async function getOpenOrders(symbol) {
  if (USE_MOCK) {
    return mockExchange.getOpenOrders(symbol);
  }
  
  // Real Binance - fetch open orders
  try {
    const orders = await binance.trading.getAllOrders(symbol);
    return orders.filter(o => o.status === 'NEW');
  } catch (e) {
    console.error(`[Trading] Failed to fetch open orders:`, e.message);
    return [];
  }
}

// Get precision settings for each trading pair
function getPrecision(symbol) {
  const precisionConfig = {
    'ETHUSD': { price: 2, qty: 4 },
    'BTCUSD': { price: 2, qty: 6 },
    'LTCUSD': { price: 2, qty: 8 },
    'ETHUSDT': { price: 2, qty: 4 },
    'BTCUSDT': { price: 2, qty: 6 },
    'LTCUSDT': { price: 2, qty: 8 }
  };
  return precisionConfig[symbol] || { price: 2, qty: 4 };
}

async function placeOrder(symbol, side, quantity, price) {
  if (USE_MOCK) {
    return mockExchange.placeOrder(symbol, side, quantity, price);
  }
  
  // Round values to Binance precision limits based on pair
  const precision = getPrecision(symbol);
  const roundedPrice = Math.round(price * Math.pow(10, precision.price)) / Math.pow(10, precision.price);
  const roundedQty = Math.round(quantity * Math.pow(10, precision.qty)) / Math.pow(10, precision.qty);
  
  // Real Binance - place limit order
  try {
    const order = await binance.trading.placeLimitOrder(symbol, side.toUpperCase(), roundedQty, roundedPrice);
    console.log(`[Trading] Placed REAL ${side} order: ${quantity} ${symbol} @ ${price}`);
    return {
      orderId: order.orderId,
      symbol: order.symbol,
      side: order.side,
      quantity: parseFloat(order.origQty),
      price: parseFloat(order.price),
      status: order.status === 'NEW' ? 'NEW' : 'FILLED'
    };
  } catch (e) {
    console.error(`[Trading] Failed to place order:`, e.message);
    throw e;
  }
}

async function cancelOrder(symbol, orderId) {
  if (USE_MOCK) {
    return mockExchange.cancelOrder(symbol, orderId);
  }
  
  // Real Binance
  try {
    return await binance.trading.cancelOrder(symbol, orderId);
  } catch (e) {
    console.error(`[Trading] Failed to cancel order:`, e.message);
    throw e;
  }
}

/**
 * Cancel an order and verify it was actually removed from Binance
 * @returns {object} Result with success boolean and details
 */
async function cancelOrderWithVerification(symbol, orderId) {
  // First, cancel the order
  const cancelResult = await cancelOrder(symbol, orderId);
  
  if (USE_MOCK) {
    return { success: true, cancelResult };
  }
  
  // Wait a moment for Binance to process
  await new Promise(r => setTimeout(r, 500));
  
  // Verify the order is gone
  const openOrders = await getOpenOrders(symbol);
  const stillExists = openOrders.some(o => o.orderId === orderId);
  
  if (stillExists) {
    console.error(`[Trading] Order ${orderId} still exists on Binance after cancellation!`);
    return { success: false, cancelResult, error: 'Order still exists after cancellation' };
  }
  
  console.log(`[Trading] Order ${orderId} successfully cancelled and verified`);
  return { success: true, cancelResult };
}

function saveState() {
  if (USE_MOCK) {
    mockExchange.saveState();
  } else {
    // Save processed order IDs for real Binance
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        processedOrderIds: Array.from(processedOrderIds)
      }, null, 2));
      
      // Also persist strategies (includes grid steps) to prevent data loss on crash
      const db = require('./trading-db');
      const strategies = db.getAllStrategies();
      const strategiesFile = path.join(__dirname, '..', '..', 'data-prod', 'strategies.json');
      fs.writeFileSync(strategiesFile, JSON.stringify(strategies, null, 2));
      
      // Persist completed trades
      const tradesFile = path.join(__dirname, '..', '..', 'data-prod', 'completed-trades.json');
      const trades = db.getAllCompletedTrades();
      fs.writeFileSync(tradesFile, JSON.stringify(trades, null, 2));
      
      console.log('[Trading] State persisted to data-prod/');
    } catch (e) {
      console.error('[Trading] Failed to persist state:', e.message);
    }
  }
}

function getState() {
  if (USE_MOCK) {
    return mockExchange.getState();
  }
  
  return {
    prices: priceCache,
    orders: [],
    enabled: !USE_MOCK,
    processedOrderIds: Array.from(processedOrderIds)
  };
}

// Get order status from exchange
async function getOrder(symbol, orderId) {
  if (USE_MOCK) {
    return mockExchange.getOrder(symbol, orderId);
  }
  
  try {
    return await binance.trading.getOrder(symbol, orderId);
  } catch (e) {
    console.error(`[Trading] Failed to get order:`, e.message);
    throw e;
  }
}

module.exports = {
  USE_MOCK,
  getPrice,
  getAllPrices,
  getAllOrders,
  getOpenOrders,
  getOrder,
  placeOrder,
  cancelOrder,
  cancelOrderWithVerification,
  saveState,
  getState,
  isOrderProcessed,
  markOrderProcessed
};