/**
 * Mock Binance Exchange for Testing
 * 
 * Simulates Binance API with manual price control
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../../data');
const STATE_FILE = path.join(DATA_DIR, 'mock-exchange-state.json');

// In-memory state
let state = {
  enabled: true,
  prices: {
    ETHUSDT: 2500,
    BTCUSDT: 45000,
    LTCUSDT: 75
  },
  frozen: {},
  orders: [],
  nextOrderId: 1000,
  fees: {
    maker: 0.001,  // 0.1% Binance standard
    taker: 0.001   // 0.1% Binance standard
  }
};

// Load persisted state
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      const loaded = JSON.parse(data);
      // Merge with defaults to ensure all required properties exist
      state = { ...state, ...loaded };
    }
  } catch (e) {
    console.log('[Mock] Starting fresh state');
  }
}

// Save state
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[Mock] Failed to save state:', e.message);
  }
}

loadState();

// Get current price for symbol
function getPrice(symbol) {
  return state.prices[symbol] || 0;
}

// Set price for symbol
function setPrice(symbol, price) {
  state.prices[symbol] = price;
  saveState();
  broadcastPrice(symbol, price);
  return { symbol, price };
}

// Freeze/unfreeze price
function freezePrice(symbol, frozen) {
  state.frozen[symbol] = frozen;
  saveState();
  return { symbol, frozen };
}

// Get all prices
function getAllPrices() {
  return { ...state.prices };
}

// Generate order ID
function generateOrderId() {
  return `mock_${state.nextOrderId++}`;
}

// Place order (limit order)
function placeOrder(symbol, side, quantity, price, type = 'LIMIT') {
  const orderId = generateOrderId();
  const order = {
    orderId,
    symbol,
    side,
    type,
    price: parseFloat(price),
    quantity: parseFloat(quantity),
    status: 'NEW',
    createdAt: new Date().toISOString()
  };
  state.orders.push(order);
  saveState();
  return order;
}

// Get open orders
function getOpenOrders(symbol = null) {
  if (symbol) {
    return state.orders.filter(o => o.symbol === symbol && o.status === 'NEW');
  }
  return state.orders.filter(o => o.status === 'NEW');
}

// Get all orders (including filled)
function getAllOrders(symbol = null) {
  if (symbol) {
    return state.orders.filter(o => o.symbol === symbol);
  }
  return [...state.orders];
}

// Cancel order
function cancelOrder(symbol, orderId) {
  const order = state.orders.find(o => o.orderId === orderId && o.symbol === symbol);
  if (order) {
    order.status = 'CANCELED';
    saveState();
    return { orderId, status: 'CANCELED' };
  }
  return null;
}

// Fill order (simulate market hit)
function fillOrder(orderId) {
  const order = state.orders.find(o => o.orderId === orderId);
  if (order && order.status === 'NEW') {
    order.status = 'FILLED';
    order.filledAt = new Date().toISOString();
    order.price = getPrice(order.symbol); // Fill at current price
    // Calculate fee (0.1% taker fee)
    order.fee = order.price * order.quantity * state.fees.taker;
    order.feeCurrency = order.symbol.replace('USDT', '');
    saveState();
    return order;
  }
  return null;
}

// Fill all orders for a symbol (simulate price movement through orders)
function fillOrdersForSymbol(symbol) {
  const price = getPrice(symbol);
  const ordersToFill = state.orders
    .filter(o => o.symbol === symbol && o.status === 'NEW')
    .sort((a, b) => a.side === 'BUY' ? b.price - a.price : a.price - b.price); // Buy low, sell high

  const filled = [];
  
  for (const order of ordersToFill) {
    if (order.side === 'BUY' && price <= order.price) {
      // Buy order fills when price drops to or below order price (buy low)
      order.status = 'FILLED';
      order.filledAt = new Date().toISOString();
      order.price = price; // Fill at current (lower) price
      // Calculate fee (0.1% taker fee)
      order.fee = price * order.quantity * state.fees.taker;
      order.feeCurrency = order.symbol.replace('USDT', '');
      filled.push(order);
    } else if (order.side === 'SELL' && price >= order.price) {
      // Sell order fills when price rises to or above order price (sell high)
      order.status = 'FILLED';
      order.filledAt = new Date().toISOString();
      order.price = price; // Fill at current (higher) price
      // Calculate fee (0.1% taker fee)
      order.fee = price * order.quantity * state.fees.taker;
      order.feeCurrency = order.symbol.replace('USDT', '');
      filled.push(order);
    }
  }
  
  if (filled.length > 0) {
    saveState();
  }
  
  return filled;
}

// Get account balances (mock)
function getAccount() {
  // Calculate owned crypto from filled orders
  const balances = {
    ETH: { asset: 'ETH', free: '0', locked: '0' },
    BTC: { asset: 'BTC', free: '0', locked: '0' },
    LTC: { asset: 'LTC', free: '0', locked: '0' },
    USDT: { asset: 'USDT', free: '10000', locked: '0' }
  };
  
  for (const order of state.orders) {
    if (order.status === 'FILLED') {
      const [base] = order.symbol.replace('USDT', '').split('');
      let asset = order.symbol.replace('USDT', '');
      if (asset === 'ETH') asset = 'ETH';
      if (asset === 'BTC') asset = 'BTC';
      if (asset === 'LTC') asset = 'LTC';
      
      if (balances[asset]) {
        if (order.side === 'BUY') {
          const current = parseFloat(balances[asset].free);
          balances[asset].free = (current + order.quantity).toString();
        } else {
          const current = parseFloat(balances[asset].free);
          balances[asset].free = Math.max(0, current - order.quantity).toString();
        }
      }
      
      // Deduct USDT on buy, add on sell (including fees)
      const feeRate = state.fees.taker; // Using taker fee for simplicity
      if (order.side === 'BUY') {
        const cost = order.quantity * order.price;
        const fee = cost * feeRate;
        const current = parseFloat(balances.USDT.free);
        balances.USDT.free = (current - cost - fee).toString();
      } else {
        const proceeds = order.quantity * order.price;
        const fee = proceeds * feeRate;
        const current = parseFloat(balances.USDT.free);
        balances.USDT.free = (current + proceeds - fee).toString();
      }
    }
  }
  
  return { balances: Object.values(balances) };
}

// Check and fill orders (call this periodically)
function checkOrders() {
  const symbols = Object.keys(state.prices);
  for (const symbol of symbols) {
    fillOrdersForSymbol(symbol);
  }
}

// Simulation functions
function runSimulation(symbol, mode, amount, duration) {
  const originalPrice = getPrice(symbol);
  let interval;
  let elapsed = 0;
  
  switch (mode) {
    case 'spike':
      setPrice(symbol, originalPrice + amount);
      setTimeout(() => setPrice(symbol, originalPrice), duration * 1000);
      break;
      
    case 'drop':
      setPrice(symbol, Math.max(0, originalPrice - amount));
      setTimeout(() => setPrice(symbol, originalPrice), duration * 1000);
      break;
      
    case 'trend':
      interval = setInterval(() => {
        elapsed += 500;
        const newPrice = getPrice(symbol) + (amount / (duration * 2));
        setPrice(symbol, newPrice);
        checkOrders();
        if (elapsed >= duration * 1000) {
          clearInterval(interval);
          setPrice(symbol, originalPrice);
        }
      }, 500);
      break;
      
    case 'volatile':
      interval = setInterval(() => {
        elapsed += 500;
        const variance = (Math.random() - 0.5) * amount;
        setPrice(symbol, Math.max(0.01, originalPrice + variance));
        checkOrders();
        if (elapsed >= duration * 1000) {
          clearInterval(interval);
          setPrice(symbol, originalPrice);
        }
      }, 500);
      break;
  }
  
  checkOrders();
  return { symbol, mode, amount, duration, originalPrice };
}

// WebSocket for price updates
let wsClients = [];

function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws/mock' });
  
  wss.on('connection', (ws) => {
    wsClients.push(ws);
    
    // Send initial prices
    ws.send(JSON.stringify({
      type: 'prices',
      data: state.prices
    }));
    
    ws.on('close', () => {
      wsClients = wsClients.filter(c => c !== ws);
    });
  });
  
  return wss;
}

function broadcastPrice(symbol, price) {
  const msg = JSON.stringify({
    type: 'price',
    data: { symbol, price, frozen: !!state.frozen[symbol] }
  });
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

function broadcastOrderUpdate(order) {
  const msg = JSON.stringify({
    type: 'order_update',
    data: order
  });
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

// Get state for debugging
// Get current fees
function getFees() {
  return state.fees;
}

function getState() {
  return { ...state };
}

// Reset state
function resetState() {
  state = {
    enabled: true,
    prices: { ETHUSDT: 2500, BTCUSDT: 45000, LTCUSDT: 75 },
    frozen: {},
    orders: [],
    nextOrderId: 1000,
    fees: { maker: 0.001, taker: 0.001 }
  };
  saveState();
  return { reset: true };
}

module.exports = {
  getPrice,
  setPrice,
  freezePrice,
  getAllPrices,
  placeOrder,
  getOpenOrders,
  getAllOrders,
  cancelOrder,
  fillOrder,
  fillOrdersForSymbol,
  getAccount,
  getFees,
  checkOrders,
  runSimulation,
  setupWebSocket,
  broadcastOrderUpdate,
  getState,
  resetState,
  saveState
};