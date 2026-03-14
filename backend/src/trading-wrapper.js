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

function getAllOrders(symbol) {
  if (USE_MOCK) {
    return mockExchange.getAllOrders(symbol);
  }
  
  // Real Binance - would need to fetch from API
  // For now, return empty in prod until we fully implement
  console.log(`[Trading] Real order fetching not yet implemented for ${symbol}`);
  return [];
}

function getOpenOrders(symbol) {
  if (USE_MOCK) {
    return mockExchange.getOpenOrders(symbol);
  }
  
  // Real Binance
  return []; // TODO: implement
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

module.exports = {
  USE_MOCK,
  getPrice,
  getAllPrices,
  getAllOrders,
  getOpenOrders,
  placeOrder,
  cancelOrder,
  saveState,
  getState
};