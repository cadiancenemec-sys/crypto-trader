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
    
    let orders = result;
    if (!Array.isArray(result) && typeof result === 'object') {
      if (Array.isArray(result.data)) orders = result.data;
      else if (Array.isArray(result.orders)) orders = result.orders;
      else if (Array.isArray(result.result)) orders = result.result;
      else {
        console.log(`[Trading] getAllOrders unexpected response type:`, typeof result);
        return [];
      }
    }
    
    // Normalize field names for consistency (Binance uses origQty)
    return orders.map(o => ({
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

async function placeOrder(symbol, side, quantity, price) {
  if (USE_MOCK) {
    return mockExchange.placeOrder(symbol, side, quantity, price);
  }
  
  // Round values to Binance precision limits
  const pricePrecision = 2;  // ETHUSD price: 2 decimals
  const qtyPrecision = 4;     // ETH quantity: 4 decimals
  const roundedPrice = Math.round(price * Math.pow(10, pricePrecision)) / Math.pow(10, pricePrecision);
  const roundedQty = Math.round(quantity * Math.pow(10, qtyPrecision)) / Math.pow(10, qtyPrecision);
  
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
  cancelOrderWithVerification,
  saveState,
  getState
};