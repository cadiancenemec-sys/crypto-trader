/**
 * Trading Wrapper - switches between mock and real Binance
 * 
 * USE_MOCK=false uses real Binance US API
 * USE_MOCK=true (default) uses mock exchange
 */

const mockExchange = require('./mock-exchange');
const binance = require('./api');

const USE_MOCK = process.env.USE_MOCK !== 'false';

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
  if (USE_MOCK) {
    return mockExchange.getAllOrders(symbol);
  }
  
  // Real Binance - fetch all orders
  try {
    const result = await binance.trading.getAllOrders(symbol);
    // Make sure we return an array - handle any response format
    if (!result) {
      return [];
    }
    if (Array.isArray(result)) {
      return result;
    }
    // If it's an object with orders/data property, extract it
    if (typeof result === 'object') {
      if (Array.isArray(result.data)) return result.data;
      if (Array.isArray(result.orders)) return result.orders;
      if (Array.isArray(result.result)) return result.result;
    }
    console.log(`[Trading] getAllOrders unexpected response type:`, typeof result);
    return [];
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

async function placeOrder(symbol, side, quantity, price) {
  if (USE_MOCK) {
    return mockExchange.placeOrder(symbol, side, quantity, price);
  }
  
  // Real Binance - place limit order
  try {
    const order = await binance.trading.placeLimitOrder(symbol, side.toUpperCase(), quantity, price);
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

function saveState() {
  if (USE_MOCK) {
    mockExchange.saveState();
  }
  // No saving needed for real Binance
}

function getState() {
  if (USE_MOCK) {
    return mockExchange.getState();
  }
  
  return {
    prices: priceCache,
    orders: [],
    enabled: !USE_MOCK
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
  saveState,
  getState
};