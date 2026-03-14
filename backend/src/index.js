const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const { initDb, dbHelpers } = require('./db');
const binance = require('./api');
const config = require('./config');

// New modules for DCA Trading
const mockExchange = require('./mock-exchange');
const dcaRoutes = require('./routes/dca');
const dcaBot = require('./dca-bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const wss = new WebSocket.Server({ server, path: '/ws' });
const PORT = config.server.port;

// Store active listenKey and WS connection
let listenKey = null;
let userWs = null;
let listenKeyInterval = null;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files
const frontendPath = path.join(__dirname, '..', '..', 'frontend');
console.log('Serving frontend from:', frontendPath);
app.use(express.static(frontendPath));

// Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Socket.io for general updates
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// WebSocket for DCA bot updates
wss.on('connection', async (ws) => {
  console.log('[WS] DCA client connected');
  
  // Send initial state - use live prices in prod
  let prices = {};
  let orders = [];
  
  if (process.env.USE_MOCK === 'false') {
    // Prod: get live prices from Binance
    try {
      const [eth, btc, ltc] = await Promise.all([
        binance.trading.getPrice('ETHUSD'),
        binance.trading.getPrice('BTCUSD'),
        binance.trading.getPrice('LTCUSD')
      ]);
      prices = {
        ETHUSD: parseFloat(eth.price),
        BTCUSD: parseFloat(btc.price),
        LTCUSD: parseFloat(ltc.price)
      };
    } catch (e) {
      console.error('Failed to fetch live prices:', e.message);
    }
  } else {
    // Dev: use mock
    const state = mockExchange.getState();
    prices = state.prices;
    orders = mockExchange.getOpenOrders();
  }
  
  ws.send(JSON.stringify({
    type: 'init',
    data: { prices, orders }
  }));
  
  ws.on('close', () => {
    console.log('[WS] DCA client disconnected');
  });
});

// Broadcast to all WS clients
function broadcastDCA(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// ===== ORIGINAL BINANCE API ROUTES =====

// Get account balance
app.get('/api/account', async (req, res) => {
  try {
    const account = await binance.trading.getAccount();
    res.json(account);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get all open orders
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await binance.trading.getAllOpenOrders();
    res.json(orders);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get trades for a symbol
app.get('/api/trades/:symbol', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const trades = await binance.trading.getMyTrades(req.params.symbol, limit);
    res.json(trades);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get current price
app.get('/api/price/:symbol', async (req, res) => {
  try {
    const price = await binance.trading.getPrice(req.params.socket);
    res.json(price);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get 24hr ticker
app.get('/api/ticker/:symbol', async (req, res) => {
  try {
    const ticker = await binance.trading.get24hrTicker(req.params.symbol);
    res.json(ticker);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Place an order
app.post('/api/order', async (req, res) => {
  try {
    const { symbol, side, quantity, type, price } = req.body;
    
    let result;
    if (type === 'market') {
      result = await binance.trading.placeMarketOrder(symbol, side, quantity);
    } else {
      result = await binance.trading.placeLimitOrder(symbol, side, quantity, price);
    }
    
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cancel an order
app.delete('/api/order/:symbol/:orderId', async (req, res) => {
  try {
    const result = await binance.trading.cancelOrder(req.params.symbol, req.params.orderId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get rate limiter status
app.get('/api/status', (req, res) => {
  res.json({
    rateLimit: binance.getRateLimitStatus(),
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ===== NEW DCA TRADING ROUTES =====
app.use('/api/dca', dcaRoutes);

// ===== BINANCE USER DATA STREAM =====

async function startUserDataStream() {
  try {
    listenKey = await binance.trading.createListenKey();
    console.log('User data stream listenKey created');
    connectUserWs();
    
    listenKeyInterval = setInterval(async () => {
      try {
        await binance.trading.pingListenKey(listenKey);
      } catch (e) {
        console.error('Failed to ping listenKey:', e.message);
      }
    }, 30 * 60 * 1000);
    
  } catch (e) {
    console.error('Failed to start user data stream:', e.message);
  }
}

function connectUserWs() {
  if (userWs) userWs.close();
  
  const wsUrl = `wss://stream.binance.us:9443/ws/${listenKey}`;
  console.log('Connecting to Binance user stream:', wsUrl);
  
  userWs = new WebSocket(wsUrl);
  
  userWs.on('open', () => {
    console.log('Binance user data stream connected');
    io.emit('binance-status', { connected: true });
  });
  
  userWs.on('message', (data) => {
    try {
      const event = JSON.parse(data);
      handleUserDataEvent(event);
    } catch (e) {
      console.error('Failed to parse user data event:', e.message);
    }
  });
  
  userWs.on('error', (error) => {
    console.error('User data stream error:', error.message);
    io.emit('binance-status', { connected: false, error: error.message });
  });
  
  userWs.on('close', () => {
    console.log('User data stream closed, reconnecting...');
    io.emit('binance-status', { connected: false });
    setTimeout(() => { if (listenKey) connectUserWs(); }, 5000);
  });
}

function handleUserDataEvent(event) {
  const eventType = event.e;
  
  switch (eventType) {
    case 'executionReport':
      const orderUpdate = {
        symbol: event.s,
        orderId: parseInt(event.o),
        clientOrderId: event.c,
        side: event.S,
        type: event.o,
        status: event.X,
        executedQty: parseFloat(event.z),
        price: parseFloat(event.p),
        updateTime: event.T
      };
      io.emit('order-update', orderUpdate);
      break;
      
    case 'outboundAccountPosition':
      io.emit('account-update', { balances: event.B, updateTime: event.E });
      break;
  }
}

// ===== PRICE CHECK LOOP FOR MOCK EXCHANGE =====
setInterval(() => {
  mockExchange.checkOrders();
}, 2000);

// ===== START SERVER =====
async function start() {
  // Initialize database
  await initDb();
  console.log('Database initialized');
  
  // Log startup
  dbHelpers.log('SERVER_START', `Starting crypto-bot server on port ${PORT}`);
  
  // Start DCA bot
  dcaBot.init(wss.clients);
  dcaBot.start(5000);
  console.log('[DCA Bot] Started');
  
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Crypto Bot server running at http://localhost:${PORT}`);
    console.log(`Frontend available at http://localhost:${PORT}`);
    console.log(`DCA Trading API at http://localhost:${PORT}/api/dca`);
  });
  
  // Start user data stream (optional, for real trading)
  // await startUserDataStream();
}

start().catch(console.error);

// Export for testing
module.exports = { app };