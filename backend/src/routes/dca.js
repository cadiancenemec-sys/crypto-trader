/**
 * DCA Trading API Routes
 */

const express = require('express');
const router = express.Router();
const tradingDb = require('../trading-db');
const mockExchange = require('../mock-exchange');
const dcaBot = require('../dca-bot');

// ===== STRATEGY ROUTES =====

// Get all strategies
router.get('/strategies', (req, res) => {
  const strategies = tradingDb.getAllStrategies();
  
  // Add stats to each strategy
  const withStats = strategies.map(s => {
    // Calculate crypto holdings (ALL filled buys minus filled sells)
    const allOrders = mockExchange.getAllOrders(s.symbol);
    const filledBuys = allOrders.filter(o => o.side === 'BUY' && o.status === 'FILLED');
    const filledSells = allOrders.filter(o => o.side === 'SELL' && o.status === 'FILLED');
    
    // Calculate held quantity (ALL filled buys - ALL filled sells)
    let heldQuantity = 0;
    for (const buy of filledBuys) {
      heldQuantity += buy.quantity;
    }
    for (const sell of filledSells) {
      heldQuantity -= sell.quantity;
    }
    heldQuantity = Math.max(0, heldQuantity);
    
    // Calculate cost of open (pending) buy orders
    const openBuyOrders = allOrders.filter(o => o.side === 'BUY' && o.status === 'NEW');
    const openBuyCost = openBuyOrders.reduce((sum, o) => sum + (o.price * o.quantity), 0);
    
    // Calculate cost of ALL filled buy orders (whether processed/sold or not) - money is still committed!
    const filledBuyCost = allOrders
      .filter(o => o.side === 'BUY' && o.status === 'FILLED')
      .reduce((sum, o) => sum + (o.price * o.quantity), 0);
    
    // Calculate total from filled sells (this frees up money)
    const filledSellValue = allOrders
      .filter(o => o.side === 'SELL' && o.status === 'FILLED')
      .reduce((sum, o) => sum + (o.price * o.quantity), 0);
    
    // Current price and crypto value
    const currentPrice = mockExchange.getPrice(s.symbol);
    const cryptoValue = heldQuantity * currentPrice;
    
    // Available cash = total budget minus pending buys minus (filled buys minus filled sells)
    // filledBuys - filledSells = net money still committed
    const netCommitted = filledBuyCost - filledSellValue;
    const availableCash = s.totalBudget - openBuyCost - netCommitted;
    const totalAssets = availableCash + cryptoValue;
    
    return {
      ...s,
      stats: tradingDb.getStrategyStats(s.id),
      openOrders: mockExchange.getOpenOrders(s.symbol).filter(o => o.status === 'NEW').length,
      heldQuantity,
      cryptoValue,
      totalAssets,
      availableCash,
      openBuyCost,
      filledBuyCost,
      filledSellValue
    };
  });
  
  res.json(withStats);
});

// Get single strategy
router.get('/strategies/:id', (req, res) => {
  const strategy = tradingDb.getStrategy(parseInt(req.params.id));
  if (!strategy) {
    return res.status(404).json({ error: 'Strategy not found' });
  }
  
  const stats = tradingDb.getStrategyStats(strategy.id);
  const openOrders = mockExchange.getOpenOrders(strategy.symbol);
  const trades = tradingDb.getAllCompletedTrades(strategy.id);
  
  res.json({
    ...strategy,
    stats,
    openOrders: openOrders.filter(o => o.status === 'NEW'),
    recentTrades: trades.slice(-10)
  });
});

// Create strategy
router.post('/strategies', (req, res) => {
  const { symbol, tradeAmount, totalBudget, profitTarget, gridLevels, gridSpacing, startPrice, autoEnd, emergencyDropEnabled, emergencyDropPercent, emergencyDropMaxOrders } = req.body;
  
  if (!symbol || !tradeAmount || !totalBudget || !profitTarget) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  const strategy = tradingDb.createStrategy({
    symbol,
    tradeAmount,
    totalBudget,
    profitTarget,
    gridLevels: gridLevels || 2,
    gridSpacing: gridSpacing || 5,
    startPrice: startPrice || mockExchange.getPrice(symbol),
    autoEnd,
    emergencyDropEnabled,
    emergencyDropPercent,
    emergencyDropMaxOrders
  });
  
  res.json(strategy);
});

// Update strategy
router.put('/strategies/:id', async (req, res) => {
  const strategy = tradingDb.updateStrategy(parseInt(req.params.id), req.body);
  if (!strategy) {
    return res.status(404).json({ error: 'Strategy not found' });
  }
  
  // Re-evaluate and place orders if budget increased (skip the sell check - just use cash)
  if (strategy.status === 'active') {
    const currentPrice = mockExchange.getPrice(strategy.symbol);
    const allOrders = mockExchange.getAllOrders(strategy.symbol);
    const openBuyOrders = allOrders.filter(o => o.side === 'BUY' && o.status === 'NEW');
    
    await dcaBot.placeBuyOrders(strategy, currentPrice, openBuyOrders);
  }
  
  res.json(strategy);
});

// Delete strategy
router.delete('/strategies/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const strategy = tradingDb.getStrategy(id);
  
  if (!strategy) {
    return res.status(404).json({ error: 'Strategy not found' });
  }
  
  // Cancel all open orders for this symbol
  const orders = mockExchange.getOpenOrders(strategy.symbol);
  for (const order of orders) {
    mockExchange.cancelOrder(strategy.symbol, order.orderId);
  }
  
  tradingDb.deleteStrategy(id);
  res.json({ deleted: true });
});

// Start strategy
router.post('/strategies/:id/start', (req, res) => {
  const strategy = tradingDb.updateStrategy(parseInt(req.params.id), { status: 'active' });
  if (!strategy) {
    return res.status(404).json({ error: 'Strategy not found' });
  }
  res.json(strategy);
});

// Stop strategy
router.post('/strategies/:id/stop', (req, res) => {
  const strategy = tradingDb.updateStrategy(parseInt(req.params.id), { status: 'paused' });
  if (!strategy) {
    return res.status(404).json({ error: 'Strategy not found' });
  }
  
  // Optionally cancel open orders
  const orders = mockExchange.getOpenOrders(strategy.symbol);
  for (const order of orders) {
    mockExchange.cancelOrder(strategy.symbol, order.orderId);
  }
  
  res.json(strategy);
});

// ===== TRADES ROUTES =====

// Get completed trades
router.get('/trades', (req, res) => {
  const strategyId = req.query.strategyId ? parseInt(req.query.strategyId) : null;
  const trades = tradingDb.getAllCompletedTrades(strategyId);
  res.json(trades);
});

// Get total profit
router.get('/trades/profit', (req, res) => {
  const strategyId = req.query.strategyId ? parseInt(req.query.strategyId) : null;
  const profit = tradingDb.getTotalProfit(strategyId);
  res.json({ profit });
});

// ===== MOCK EXCHANGE ROUTES =====

// Get mock prices
router.get('/mock/prices', (req, res) => {
  const prices = mockExchange.getAllPrices();
  const frozen = {};
  const state = mockExchange.getState();
  for (const [symbol, price] of Object.entries(prices)) {
    frozen[symbol] = !!state.frozen[symbol];
  }
  res.json({ prices, frozen });
});

// Set mock price
router.post('/mock/prices/:symbol', (req, res) => {
  const { price, freeze } = req.body;
  const symbol = req.params.symbol.toUpperCase();
  
  if (price !== undefined) {
    mockExchange.setPrice(symbol, parseFloat(price));
  }
  
  if (freeze !== undefined) {
    mockExchange.freezePrice(symbol, freeze);
  }
  
  res.json({ 
    symbol, 
    price: mockExchange.getPrice(symbol),
    frozen: !!mockExchange.getState().frozen[symbol]
  });
});

// Run simulation
router.post('/mock/simulate', (req, res) => {
  const { symbol, mode, amount, duration } = req.body;
  const result = mockExchange.runSimulation(symbol.toUpperCase(), mode, parseFloat(amount), parseInt(duration));
  res.json(result);
});

// Get mock orders
router.get('/mock/orders', (req, res) => {
  const orders = mockExchange.getOpenOrders();
  res.json(orders);
});

// Force fill order
router.post('/mock/orders/:orderId/fill', (req, res) => {
  const order = mockExchange.fillOrder(req.params.orderId);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  res.json(order);
});

// Cancel order
router.delete('/mock/orders/:orderId', (req, res) => {
  const result = mockExchange.cancelOrder(req.params.symbol || 'UNKNOWN', req.params.orderId);
  if (!result) {
    return res.status(404).json({ error: 'Order not found' });
  }
  res.json(result);
});

// Get mock account
router.get('/mock/account', (req, res) => {
  const account = mockExchange.getAccount();
  res.json(account);
});

// Get mock state
router.get('/mock/state', (req, res) => {
  res.json(mockExchange.getState());
});

// Reset mock state
router.post('/mock/reset', (req, res) => {
  mockExchange.resetState();
  res.json({ reset: true });
});

// ===== BOT STATUS =====

router.get('/bot/status', (req, res) => {
  const state = mockExchange.getState();
  const strategies = tradingDb.getAllStrategies();
  const activeCount = strategies.filter(s => s.status === 'active').length;
  const openOrders = mockExchange.getOpenOrders().length;
  const totalProfit = tradingDb.getTotalProfit();
  
  res.json({
    running: true,
    activeStrategies: activeCount,
    totalStrategies: strategies.length,
    openOrders,
    totalProfit,
    prices: state.prices,
    frozen: state.frozen
  });
});

module.exports = router;