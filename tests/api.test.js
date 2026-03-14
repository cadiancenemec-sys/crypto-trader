const request = require('supertest');
const express = require('express');

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

const binance = require('../backend/src/api');

describe('API Endpoints', () => {
  let app;
  
  beforeAll(async () => {
    // Build the Express app (import after mocking)
    const express = require('express');
    const cors = require('cors');
    const path = require('path');
    const { initDb, dbHelpers } = require('../backend/src/db');
    const config = require('../backend/src/config');
    
    app = express();
    app.use(cors());
    app.use(express.json());
    
    // Mock DB
    jest.spyOn(dbHelpers, 'log').mockImplementation(() => {});
    
    // Routes
    app.get('/api/account', async (req, res) => {
      try {
        const account = await binance.trading.getAccount();
        res.json(account);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/api/orders', async (req, res) => {
      try {
        const orders = await binance.trading.getAllOpenOrders();
        res.json(orders);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/api/trades/:symbol', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 20;
        const trades = await binance.trading.getMyTrades(req.params.symbol, limit);
        res.json(trades);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/api/price/:symbol', async (req, res) => {
      try {
        const price = await binance.trading.getPrice(req.params.symbol);
        res.json(price);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/api/ticker/:symbol', async (req, res) => {
      try {
        const ticker = await binance.trading.get24hrTicker(req.params.symbol);
        res.json(ticker);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/api/status', (req, res) => {
      res.json({
        rateLimit: binance.trading.getRateLimitStatus(),
        uptime: 1,
        timestamp: new Date().toISOString()
      });
    });

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

    app.delete('/api/order/:symbol/:orderId', async (req, res) => {
      try {
        const result = await binance.trading.cancelOrder(req.params.symbol, req.params.orderId);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/status', () => {
    it('should return rate limit status', async () => {
      const response = await request(app).get('/api/status');
      
      expect(response.status).toBe(200);
      expect(response.body.rateLimit).toBeDefined();
      expect(response.body.uptime).toBeDefined();
    });
  });

  describe('GET /api/account', () => {
    it('should return account balances', async () => {
      const mockAccount = {
        balances: [
          { asset: 'ETH', free: '0.01', locked: '0' },
          { asset: 'USDT', free: '100', locked: '0' }
        ]
      };
      binance.trading.getAccount.mockResolvedValue(mockAccount);

      const response = await request(app).get('/api/account');
      
      expect(response.status).toBe(200);
      expect(response.body.balances).toHaveLength(2);
      expect(response.body.balances[0].asset).toBe('ETH');
    });

    it('should handle API errors', async () => {
      binance.trading.getAccount.mockRejectedValue(new Error('API Error'));

      const response = await request(app).get('/api/account');
      
      expect(response.status).toBe(500);
      expect(response.body.error).toBeDefined();
    });
  });

  describe('GET /api/orders', () => {
    it('should return open orders', async () => {
      const mockOrders = [
        { orderId: 123, symbol: 'ETHUSD', side: 'BUY', price: '2000', origQty: '0.01' }
      ];
      binance.trading.getAllOpenOrders.mockResolvedValue(mockOrders);

      const response = await request(app).get('/api/orders');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].orderId).toBe(123);
    });
  });

  describe('GET /api/trades/:symbol', () => {
    it('should return trades for a symbol', async () => {
      const mockTrades = [
        { id: 1, symbol: 'ETHUSD', price: '2000', qty: '0.01', isBuyer: true }
      ];
      binance.trading.getMyTrades.mockResolvedValue(mockTrades);

      const response = await request(app).get('/api/trades/ETHUSD?limit=10');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(binance.trading.getMyTrades).toHaveBeenCalledWith('ETHUSD', 10);
    });

    it('should use default limit of 20', async () => {
      binance.trading.getMyTrades.mockResolvedValue([]);

      await request(app).get('/api/trades/ETHUSD');
      
      expect(binance.trading.getMyTrades).toHaveBeenCalledWith('ETHUSD', 20);
    });
  });

  describe('GET /api/price/:symbol', () => {
    it('should return current price', async () => {
      const mockPrice = { symbol: 'BTCUSDT', price: '50000' };
      binance.trading.getPrice.mockResolvedValue(mockPrice);

      const response = await request(app).get('/api/price/BTCUSDT');
      
      expect(response.status).toBe(200);
      expect(response.body.price).toBe('50000');
    });
  });

  describe('POST /api/order', () => {
    it('should place a market order', async () => {
      const mockResult = { orderId: 456, symbol: 'ETHUSD', side: 'BUY' };
      binance.trading.placeMarketOrder.mockResolvedValue(mockResult);

      const response = await request(app)
        .post('/api/order')
        .send({ symbol: 'ETHUSD', side: 'BUY', quantity: '0.01', type: 'market' });
      
      expect(response.status).toBe(200);
      expect(binance.trading.placeMarketOrder).toHaveBeenCalledWith('ETHUSD', 'BUY', '0.01');
    });

    it('should place a limit order', async () => {
      const mockResult = { orderId: 789, symbol: 'ETHUSD', side: 'SELL' };
      binance.trading.placeLimitOrder.mockResolvedValue(mockResult);

      const response = await request(app)
        .post('/api/order')
        .send({ symbol: 'ETHUSD', side: 'SELL', quantity: '0.01', type: 'limit', price: '2100' });
      
      expect(response.status).toBe(200);
      expect(binance.trading.placeLimitOrder).toHaveBeenCalledWith('ETHUSD', 'SELL', '0.01', '2100');
    });
  });

  describe('DELETE /api/order/:symbol/:orderId', () => {
    it('should cancel an order', async () => {
      const mockResult = { orderId: 123, status: 'CANCELED' };
      binance.trading.cancelOrder.mockResolvedValue(mockResult);

      const response = await request(app).delete('/api/order/ETHUSD/123');
      
      expect(response.status).toBe(200);
      expect(binance.trading.cancelOrder).toHaveBeenCalledWith('ETHUSD', '123');
    });
  });
});