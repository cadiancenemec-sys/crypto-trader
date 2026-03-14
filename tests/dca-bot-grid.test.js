/**
 * DCA Bot Grid Logic Tests
 * 
 * Tests the grid order placement logic to ensure:
 * 1. Orders are placed at correct grid levels relative to startPrice
 * 2. Occupied grid levels are skipped (open buys AND filled buys with pending sells)
 * 3. Budget calculations are correct
 */

const request = require('supertest');
const express = require('express');
const path = require('path');
const fs = require('fs');

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

describe('DCA Bot Grid Logic', () => {
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
    await request(app).post('/api/dca/mock/reset');
    
    // Delete all strategies
    const strategiesRes = await request(app).get('/api/dca/strategies');
    const strategies = strategiesRes.body;
    for (const s of strategies) {
      await request(app).delete(`/api/dca/strategies/${s.id}`);
    }
    
    // Delete data files
    const dataDir = path.join(__dirname, '..', 'data');
    const files = ['completed-trades.json', 'strategies.json', 'mock-orders.json'];
    for (const f of files) {
      const fp = path.join(dataDir, f);
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
      }
    }
    
    // Wait for bot to process
    await new Promise(r => setTimeout(r, 500));
  }
  
  // Helper to wait for bot tick
  async function waitForBot(ms = 2000) {
    await new Promise(r => setTimeout(r, ms));
  }
  
  describe('Grid Level Placement', () => {
    jest.setTimeout(30000); // 30 second timeout for all tests in this describe
    it('should place first buy at startPrice (grid level 0)', async () => {
      await clearAllData();
      await waitForBot();
      
      // Create strategy with budget $30 (should only afford 1 order at ~$25)
      const createRes = await request(app)
        .post('/api/dca/strategies')
        .send({
          symbol: 'ETHUSDT',
          tradeAmount: 0.01,
          totalBudget: 30,
          profitTarget: 1,
          gridLevels: 10,
          gridSpacing: 5,
          startPrice: 2495,
          autoEnd: false,
          emergencyDropEnabled: false
        });
      
      expect(createRes.status).toBeGreaterThanOrEqual(200);
      expect(createRes.status).toBeLessThan(300);
      await waitForBot();
      
      // Check orders
      const ordersRes = await request(app).get('/api/dca/mock/orders');
      const buyOrders = ordersRes.body.filter(o => o.side === 'BUY' && o.status === 'NEW');
      
      expect(buyOrders.length).toBe(1);
      expect(buyOrders[0].price).toBe(2495); // startPrice = grid level 0
      
      // Check cash calculation
      const strategyRes = await request(app).get('/api/dca/strategies');
      const strategy = strategyRes.body[0];
      
      // Cash should be budget - order cost = 30 - 24.95 = ~5.05
      expect(strategy.availableCash).toBeGreaterThan(5);
      expect(strategy.availableCash).toBeLessThan(5.1);
    });
    
    it('should skip occupied grid levels when placing new buys after budget increase', async () => {
      await clearAllData();
      await waitForBot();
      
      // Create strategy with small budget
      const createRes = await request(app)
        .post('/api/dca/strategies')
        .send({
          symbol: 'ETHUSDT',
          tradeAmount: 0.01,
          totalBudget: 26, // Just enough for 1 order
          profitTarget: 1,
          gridLevels: 10,
          gridSpacing: 5,
          startPrice: 2495,
          autoEnd: false,
          emergencyDropEnabled: false
        });
      
      expect(createRes.status).toBeGreaterThanOrEqual(200);
      expect(createRes.status).toBeLessThan(300);
      await waitForBot();
      
      // Verify 1 buy order at $2495
      let ordersRes = await request(app).get('/api/dca/mock/orders');
      let buyOrders = ordersRes.body.filter(o => o.side === 'BUY' && o.status === 'NEW');
      expect(buyOrders.length).toBe(1);
      expect(buyOrders[0].price).toBe(2495);
      
      // Now increase budget to allow more orders
      const strategyRes = await request(app).get('/api/dca/strategies');
      const strategy = strategyRes.body[0];
      
      const updateRes = await request(app)
        .put(`/api/dca/strategies/${strategy.id}`)
        .send({ totalBudget: 60 }); // Enough for more orders
      
      expect(updateRes.status).toBe(200);
      await waitForBot();
      
      // Check new buy orders - should include $2490 (next grid level), not $2489 (current price - spacing)
      ordersRes = await request(app).get('/api/dca/mock/orders');
      buyOrders = ordersRes.body.filter(o => o.side === 'BUY' && o.status === 'NEW');
      
      // With budget $60, can afford ~2 orders. One at $2495 already exists, so new one should be at $2490
      const prices = buyOrders.map(o => o.price).sort((a, b) => b - a);
      expect(prices).toContain(2490); // Should have $2490 (startPrice - 1*spacing)
    });
    
    it('should correctly calculate available cash (not showing negative)', async () => {
      await clearAllData();
      await waitForBot();
      
      // Create strategy
      await request(app)
        .post('/api/dca/strategies')
        .send({
          symbol: 'ETHUSDT',
          tradeAmount: 0.01,
          totalBudget: 100,
          profitTarget: 1,
          gridLevels: 10,
          gridSpacing: 5,
          startPrice: 2495,
          autoEnd: false,
          emergencyDropEnabled: false
        });
      
      await waitForBot();
      
      const strategyRes = await request(app).get('/api/dca/strategies');
      const strategy = strategyRes.body[0];
      
      // Available cash should never be negative
      expect(strategy.availableCash).toBeGreaterThanOrEqual(0);
      expect(strategy.totalAssets).toBeGreaterThan(0);
    });
    
    it('should handle multiple grid levels correctly with larger budget', async () => {
      await clearAllData();
      await waitForBot();
      
      // Create strategy with larger budget
      await request(app)
        .post('/api/dca/strategies')
        .send({
          symbol: 'ETHUSDT',
          tradeAmount: 0.01,
          totalBudget: 80,
          profitTarget: 1,
          gridLevels: 10,
          gridSpacing: 5,
          startPrice: 2500,
          autoEnd: false,
          emergencyDropEnabled: false
        });
      
      await waitForBot();
      
      // Should have placed multiple orders at correct grid levels
      const ordersRes = await request(app).get('/api/dca/mock/orders');
      const buyOrders = ordersRes.body.filter(o => o.side === 'BUY' && o.status === 'NEW');
      
      // Should have 3 orders (budget of $80 / ~$25 per order)
      expect(buyOrders.length).toBe(3);
      
      // Each should be at a correct grid level: 2500, 2495, 2490
      const prices = buyOrders.map(o => o.price).sort((a, b) => b - a);
      expect(prices[0]).toBe(2500);
      expect(prices[1]).toBe(2495);
      expect(prices[2]).toBe(2490);
    });
  });
});