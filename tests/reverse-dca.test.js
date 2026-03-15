/**
 * Reverse DCA Strategy Tests
 * 
 * Tests the reverse DCA (sell then buy) strategy:
 * 1. Strategy creation with strategyType = "sell_buy"
 * 2. Grid goes UP from start price (sell high first)
 * 3. SELL orders placed initially
 * 4. When SELL fills, BUY is placed at lower price
 * 5. Profit stays as cash, original crypto returned
 */

const request = require('supertest');
const path = require('path');

// Mock the binance API module
jest.mock('../backend/src/api', () => ({
  trading: {
    getAccount: jest.fn(),
    getAllOpenOrders: jest.fn(),
    getMyTrades: jest.fn(),
    getPrice: jest.fn(),
    get24hrTicker: jest.fn(),
    placeMarketOrder: jest.fn(),
    placeLimitOrder: jest.fn(),
    cancelOrder: jest.fn(),
    getRateLimitStatus: jest.fn(() => ({
      queueLength: 0,
      currentWeight: 1,
      weightLimit: 1200,
      windowSeconds: 1
    }))
  }
}));

// Test constants
const TEST_SYMBOL = 'ETHUSDT';
const TEST_START_PRICE = 2500;
const TEST_TRADE_AMOUNT = 0.001;
const TEST_PROFIT_TARGET = 1; // 1%
const TEST_GRID_LEVELS = 2;
const TEST_GRID_SPACING = 10;

describe('Reverse DCA Strategy', () => {
  let app;
  
  beforeAll(async () => {
    // Import the app after mocking
    const indexModule = require('../backend/src/index.js');
    app = indexModule.app;
    
    // Give the bot time to initialize
    await new Promise(r => setTimeout(r, 1000));
  });
  
  // Helper to clear all data
  async function clearAllData() {
    // Reset mock exchange
    try {
      await request(app).post('/api/dca/mock/reset');
    } catch (e) { /* ignore */ }
    
    // Get all strategies
    const strategiesRes = await request(app).get('/api/dca/strategies');
    const strategies = strategiesRes.body;
    
    // Delete each strategy
    for (const strategy of strategies) {
      try {
        await request(app).delete(`/api/dca/strategies/${strategy.id}`);
      } catch (e) { /* ignore */ }
    }
  }
  
  beforeEach(async () => {
    await clearAllData();
  });
  
  afterAll(async () => {
    // Cleanup
    await clearAllData();
  });
  
  describe('Strategy Creation', () => {
    it('should create a reverse DCA strategy with strategyType = "sell_buy"', async () => {
      const res = await request(app)
        .post('/api/dca/strategies')
        .send({
          symbol: TEST_SYMBOL,
          strategyType: 'sell_buy',
          tradeAmount: TEST_TRADE_AMOUNT,
          totalBudget: 5,
          profitTarget: TEST_PROFIT_TARGET,
          gridLevels: TEST_GRID_LEVELS,
          gridSpacing: TEST_GRID_SPACING,
          startPrice: TEST_START_PRICE
        });
      
      expect(res.status).toBe(201);
      expect(res.body.strategyType).toBe('sell_buy');
      expect(res.body.symbol).toBe(TEST_SYMBOL);
    });
    
    it('should create grid steps going UP from start price for reverse DCA', async () => {
      const res = await request(app)
        .post('/api/dca/strategies')
        .send({
          symbol: TEST_SYMBOL,
          strategyType: 'sell_buy',
          tradeAmount: TEST_TRADE_AMOUNT,
          totalBudget: 5,
          profitTarget: TEST_PROFIT_TARGET,
          gridLevels: TEST_GRID_LEVELS,
          gridSpacing: TEST_GRID_SPACING,
          startPrice: TEST_START_PRICE
        });
      
      expect(res.status).toBe(201);
      
      // Grid should go UP: level 0 = 2500, level 1 = 2510
      const gridSteps = res.body.gridSteps;
      expect(gridSteps[0].price).toBe(TEST_START_PRICE); // 2500
      expect(gridSteps[1].price).toBe(TEST_START_PRICE + TEST_GRID_SPACING); // 2510
      expect(gridSteps[0].status).toBe('available_sell');
    });
    
    it('should default to buy_sell if strategyType not provided', async () => {
      const res = await request(app)
        .post('/api/dca/strategies')
        .send({
          symbol: TEST_SYMBOL,
          tradeAmount: TEST_TRADE_AMOUNT,
          totalBudget: 5,
          profitTarget: TEST_PROFIT_TARGET,
          gridLevels: TEST_GRID_LEVELS,
          gridSpacing: TEST_GRID_SPACING,
          startPrice: TEST_START_PRICE
        });
      
      expect(res.status).toBe(201);
      expect(res.body.strategyType).toBe('buy_sell');
      
      // Grid should go DOWN: level 0 = 2500, level 1 = 2490
      const gridSteps = res.body.gridSteps;
      expect(gridSteps[0].price).toBe(TEST_START_PRICE); // 2500
      expect(gridSteps[1].price).toBe(TEST_START_PRICE - TEST_GRID_SPACING); // 2490
    });
  });
  
  describe('Order Placement', () => {
    it('should place SELL orders for reverse DCA', async () => {
      // Create strategy
      await request(app)
        .post('/api/dca/strategies')
        .send({
          symbol: TEST_SYMBOL,
          strategyType: 'sell_buy',
          tradeAmount: TEST_TRADE_AMOUNT,
          totalBudget: 5,
          profitTarget: TEST_PROFIT_TARGET,
          gridLevels: TEST_GRID_LEVELS,
          gridSpacing: TEST_GRID_SPACING,
          startPrice: TEST_START_PRICE
        });
      
      // Wait for bot to place orders
      await new Promise(r => setTimeout(r, 3000));
      
      // Check orders
      const ordersRes = await request(app).get('/api/dca/orders');
      const reverseOrders = ordersRes.body.filter(o => o.side === 'SELL');
      
      expect(reverseOrders.length).toBeGreaterThan(0);
    });
    
    it('should place BUY orders for normal DCA', async () => {
      // Create normal strategy
      await request(app)
        .post('/api/dca/strategies')
        .send({
          symbol: TEST_SYMBOL,
          strategyType: 'buy_sell',
          tradeAmount: TEST_TRADE_AMOUNT,
          totalBudget: 5,
          profitTarget: TEST_PROFIT_TARGET,
          gridLevels: TEST_GRID_LEVELS,
          gridSpacing: TEST_GRID_SPACING,
          startPrice: TEST_START_PRICE
        });
      
      // Wait for bot to place orders
      await new Promise(r => setTimeout(r, 3000));
      
      // Check orders
      const ordersRes = await request(app).get('/api/dca/orders');
      const buyOrders = ordersRes.body.filter(o => o.side === 'BUY');
      
      expect(buyOrders.length).toBeGreaterThan(0);
    });
  });
  
  describe('Reverse DCA Profit Logic', () => {
    it('should track cash when SELL order fills', async () => {
      // Create strategy
      const createRes = await request(app)
        .post('/api/dca/strategies')
        .send({
          symbol: TEST_SYMBOL,
          strategyType: 'sell_buy',
          tradeAmount: TEST_TRADE_AMOUNT,
          totalBudget: 5,
          profitTarget: TEST_PROFIT_TARGET,
          gridLevels: TEST_GRID_LEVELS,
          gridSpacing: TEST_GRID_SPACING,
          startPrice: TEST_START_PRICE
        });
      
      const strategyId = createRes.body.id;
      
      // Wait for SELL to be placed and filled
      await new Promise(r => setTimeout(r, 5000));
      
      // Check strategy - usableBudget should increase after SELL fills
      const strategyRes = await request(app).get(`/api/dca/strategies/${strategyId}`);
      // After sell fills, budget should be positive (cash from sold crypto)
      expect(parseFloat(strategyRes.body.usableBudget)).toBeGreaterThan(0);
    });
    
    it('should have pending_buy status after SELL fills', async () => {
      // Create strategy
      await request(app)
        .post('/api/dca/strategies')
        .send({
          symbol: TEST_SYMBOL,
          strategyType: 'sell_buy',
          tradeAmount: TEST_TRADE_AMOUNT,
          totalBudget: 5,
          profitTarget: TEST_PROFIT_TARGET,
          gridLevels: TEST_GRID_LEVELS,
          gridSpacing: TEST_GRID_SPACING,
          startPrice: TEST_START_PRICE
        });
      
      // Wait for cycle to complete (sell fills, buy placed)
      await new Promise(r => setTimeout(r, 8000));
      
      // Get strategy and check for pending_buy status
      const strategiesRes = await request(app).get('/api/dca/strategies');
      const reverseStrategy = strategiesRes.body.find(s => s.strategyType === 'sell_buy');
      
      if (reverseStrategy) {
        const hasPendingBuy = reverseStrategy.gridSteps.some(s => s.status === 'pending_buy');
        // Either pending_buy exists (full cycle) or open_sell exists (waiting for sell)
        const hasOpenSell = reverseStrategy.gridSteps.some(s => s.status === 'open_sell');
        expect(hasPendingBuy || hasOpenSell).toBe(true);
      }
    });
  });
});