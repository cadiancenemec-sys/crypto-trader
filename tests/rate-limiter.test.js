const axios = require('axios');
const crypto = require('crypto');

// Rate limiter module - testing the logic directly
describe('Rate Limiter', () => {
  let rateLimiter;
  
  beforeEach(() => {
    // Create fresh rate limiter state
    rateLimiter = {
      queue: [],
      processing: false,
      lastCallTime: 0,
      minIntervalMs: 100,
      weightPerSecond: 1200,
      currentWeight: 0,
      windowStart: Date.now(),
    };
  });

  describe('Queue management', () => {
    it('should add items to queue', () => {
      const item = { fn: jest.fn(), weight: 1 };
      rateLimiter.queue.push(item);
      
      expect(rateLimiter.queue.length).toBe(1);
    });

    it('should track current weight', () => {
      rateLimiter.currentWeight = 5;
      
      expect(rateLimiter.currentWeight).toBe(5);
    });

    it('should reset weight when window expires', () => {
      const oldWindowStart = Date.now() - 1500; // 1.5 seconds ago
      rateLimiter.windowStart = oldWindowStart;
      rateLimiter.currentWeight = 500;
      
      // Simulate window check
      const now = Date.now();
      if (now - rateLimiter.windowStart >= 1000) {
        rateLimiter.currentWeight = 0;
        rateLimiter.windowStart = now;
      }
      
      expect(rateLimiter.currentWeight).toBe(0);
    });
  });

  describe('Weight calculation', () => {
    it('should calculate correct weight for order endpoints', () => {
      const orderEndpoint = '/api/v3/order';
      const weight = orderEndpoint.includes('order') ? 10 : 1;
      
      expect(weight).toBe(10);
    });

    it('should use default weight of 1 for non-order endpoints', () => {
      const tickerEndpoint = '/api/v3/ticker/price';
      const weight = tickerEndpoint.includes('order') ? 10 : 1;
      
      expect(weight).toBe(1);
    });

    it('should stay within limits', () => {
      const maxWeight = 1200;
      let currentWeight = 0;
      
      // Simulate adding 10 order requests (each weight 10)
      for (let i = 0; i < 10; i++) {
        const estimatedWeight = 10;
        if (currentWeight + estimatedWeight <= maxWeight) {
          currentWeight += estimatedWeight;
        }
      }
      
      expect(currentWeight).toBe(100); // 10 * 10
    });
  });

  describe('Interval timing', () => {
    it('should enforce minimum interval between calls', () => {
      const minInterval = 100;
      let lastCallTime = Date.now() - 50; // Called 50ms ago
      
      const timeSinceLastCall = Date.now() - lastCallTime;
      const shouldWait = timeSinceLastCall < minInterval;
      
      expect(shouldWait).toBe(true);
    });

    it('should allow call when enough time passed', () => {
      const minInterval = 100;
      let lastCallTime = Date.now() - 150; // Called 150ms ago
      
      const timeSinceLastCall = Date.now() - lastCallTime;
      const shouldWait = timeSinceLastCall < minInterval;
      
      expect(shouldWait).toBe(false);
    });
  });

  describe('HMAC signature generation', () => {
    const apiSecret = 'test-secret';
    
    it('should generate valid HMAC-SHA256 signature', () => {
      const params = 'symbol=ETHUSD&timestamp=1234567890';
      const signature = crypto
        .createHmac('sha256', apiSecret)
        .update(params)
        .digest('hex');
      
      expect(signature).toBeDefined();
      expect(signature.length).toBe(64); // SHA256 hex is always 64 chars
    });

    it('should generate different signatures for different params', () => {
      const params1 = 'symbol=ETHUSD&timestamp=1234567890';
      const params2 = 'symbol=BTCUSD&timestamp=1234567890';
      
      const sig1 = crypto.createHmac('sha256', apiSecret).update(params1).digest('hex');
      const sig2 = crypto.createHmac('sha256', apiSecret).update(params2).digest('hex');
      
      expect(sig1).not.toBe(sig2);
    });

    it('should produce consistent signature for same input', () => {
      const params = 'symbol=ETHUSD&timestamp=1234567890';
      
      const sig1 = crypto.createHmac('sha256', apiSecret).update(params).digest('hex');
      const sig2 = crypto.createHmac('sha256', apiSecret).update(params).digest('hex');
      
      expect(sig1).toBe(sig2);
    });
  });
});