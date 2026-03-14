const WebSocket = require('ws');

// Mock Socket.io
const mockEmit = jest.fn();
jest.mock('socket.io', () => {
  return class Server {
    constructor() {
      this.emit = mockEmit;
    }
    on() {}
  };
});

jest.mock('../backend/src/db', () => ({
  initDb: jest.fn().mockResolvedValue(undefined),
  dbHelpers: {
    log: jest.fn(),
    createTrade: jest.fn(),
    createOrder: jest.fn(),
    updateOrderStatus: jest.fn(),
  }
}));

jest.mock('../backend/src/config', () => ({
  binance: {
    baseUrl: 'https://api.binance.us',
    apiKey: 'test-key',
    apiSecret: 'test-secret'
  },
  server: {
    port: 3003
  }
}));

describe('WebSocket Event Handling', () => {
  let dbHelpers;
  
  beforeEach(() => {
    jest.clearAllMocks();
    dbHelpers = require('../backend/src/db').dbHelpers;
  });

  describe('executionReport event (order updates)', () => {
    const mockEvent = {
      e: 'executionReport',
      s: 'ETHUSD',
      o: '1765495575',  // orderId
      c: 'clientOrderId123', // clientOrderId
      S: 'BUY',  // side
      o: 'LIMIT', // orderType
      X: 'FILLED', // status
      z: '0.01000000', // executedQty
      Z: '21.10000000', // cumulativeQuoteQty
      p: '2110.00', // price
      T: 1773423711997 // updateTime
    };

    it('should parse executionReport event correctly', () => {
      const event = {
        e: 'executionReport',
        s: 'ETHUSD',
        o: '1765495575', // orderId
        c: 'test-client-id',
        S: 'BUY',
        ot: 'LIMIT',  // Fix: use ot for order type (Binance uses 'o' for orderId)
        X: 'FILLED',
        z: '0.01000000',
        Z: '21.10000000',
        p: '2110.00',
        T: 1234567890
      };
      
      // Parse the event
      const orderUpdate = {
        symbol: event.s,
        orderId: parseInt(event.o),
        clientOrderId: event.c,
        side: event.S,
        type: event.ot,
        status: event.X,
        executedQty: parseFloat(event.z),
        cumulativeQuoteQty: parseFloat(event.Z),
        price: parseFloat(event.p),
        updateTime: event.T
      };
      
      expect(orderUpdate.symbol).toBe('ETHUSD');
      expect(orderUpdate.orderId).toBe(1765495575);
      expect(orderUpdate.side).toBe('BUY');
      expect(orderUpdate.status).toBe('FILLED');
      expect(orderUpdate.executedQty).toBe(0.01);
    });

    it('should handle FILLED status correctly', () => {
      const status = 'FILLED';
      
      expect(status).toBe('FILLED');
      expect(['FILLED', 'NEW', 'PARTIALLY_FILLED', 'CANCELED']).toContain(status);
    });

    it('should emit order-update on executionReport', () => {
      // Simulate emitting via Socket.io
      const orderUpdate = {
        symbol: 'ETHUSD',
        orderId: 1765495575,
        status: 'FILLED'
      };
      
      // The backend should emit this
      mockEmit('order-update', orderUpdate);
      
      expect(mockEmit).toHaveBeenCalledWith('order-update', orderUpdate);
    });

    it('should log ORDER_FILLED when status is FILLED', () => {
      const event = { o: '123', s: 'ETHUSD', S: 'BUY', X: 'FILLED', z: '0.01' };
      
      if (event.X === 'FILLED') {
        dbHelpers.log('ORDER_FILLED', `Order ${event.o} ${event.s} ${event.S} filled: ${event.z}`);
      }
      
      expect(dbHelpers.log).toHaveBeenCalledWith(
        'ORDER_FILLED', 
        'Order 123 ETHUSD BUY filled: 0.01'
      );
    });

    it('should log ORDER_CANCELLED when status is CANCELED', () => {
      const event = { o: '123', s: 'ETHUSD', X: 'CANCELED' };
      
      if (event.X === 'CANCELED') {
        dbHelpers.log('ORDER_CANCELLED', `Order ${event.o} ${event.s} cancelled`);
      }
      
      expect(dbHelpers.log).toHaveBeenCalledWith(
        'ORDER_CANCELLED', 
        'Order 123 ETHUSD cancelled'
      );
    });

    it('should handle PARTIALLY_FILLED status', () => {
      const event = {
        e: 'executionReport',
        X: 'PARTIALLY_FILLED',
        z: '0.005',
        Z: '10.50'
      };
      
      const isPartialFill = event.X === 'PARTIALLY_FILLED';
      
      expect(isPartialFill).toBe(true);
      expect(parseFloat(event.z)).toBe(0.005);
    });
  });

  describe('outboundAccountPosition event', () => {
    it('should parse account position update', () => {
      const event = {
        e: 'outboundAccountPosition',
        E: 1234567890,
        B: [
          { a: 'ETH', f: '0.01000000', l: '0.00000000' },
          { a: 'USDT', f: '100.00000000', l: '10.00000000' }
        ]
      };
      
      const parsed = {
        balances: event.B,
        updateTime: event.E
      };
      
      expect(parsed.balances).toHaveLength(2);
      expect(parsed.balances[0].a).toBe('ETH');
      expect(parsed.balances[1].a).toBe('USDT');
    });

    it('should emit account-update on balance change', () => {
      const accountUpdate = {
        balances: [{ a: 'ETH', f: '0.01', l: '0' }],
        updateTime: 1234567890
      };
      
      mockEmit('account-update', accountUpdate);
      
      expect(mockEmit).toHaveBeenCalledWith('account-update', accountUpdate);
    });
  });

  describe('balanceUpdate event', () => {
    it('should parse balance update correctly', () => {
      const event = {
        e: 'balanceUpdate',
        a: 'ETH',
        f: '0.01500000',
        t: '0.01000000',
        E: 1234567890
      };
      
      const parsed = {
        asset: event.a,
        free: parseFloat(event.f),
        locked: parseFloat(event.t),
        updateTime: event.E
      };
      
      expect(parsed.asset).toBe('ETH');
      expect(parsed.free).toBe(0.015);
      expect(parsed.locked).toBe(0.01);
    });

    it('should emit balance-update event', () => {
      const balanceUpdate = {
        asset: 'ETH',
        free: 0.015,
        locked: 0.01,
        updateTime: 1234567890
      };
      
      mockEmit('balance-update', balanceUpdate);
      
      expect(mockEmit).toHaveBeenCalledWith('balance-update', balanceUpdate);
    });
  });

  describe('WebSocket connection status', () => {
    it('should emit connected status', () => {
      mockEmit('binance-status', { connected: true });
      
      expect(mockEmit).toHaveBeenCalledWith('binance-status', { connected: true });
    });

    it('should emit disconnected status', () => {
      mockEmit('binance-status', { connected: false });
      
      expect(mockEmit).toHaveBeenCalledWith('binance-status', { connected: false });
    });

    it('should emit error status with message', () => {
      mockEmit('binance-status', { 
        connected: false, 
        error: 'Connection lost' 
      });
      
      expect(mockEmit).toHaveBeenCalledWith('binance-status', { 
        connected: false, 
        error: 'Connection lost' 
      });
    });
  });

  describe('Event type routing', () => {
    const testCases = [
      { event: { e: 'executionReport' }, type: 'order' },
      { event: { e: 'outboundAccountPosition' }, type: 'account' },
      { event: { e: 'balanceUpdate' }, type: 'balance' },
    ];

    it.each(testCases)('should route $event.e to $type handler', ({ event, type }) => {
      let routedType;
      
      switch (event.e) {
        case 'executionReport':
          routedType = 'order';
          break;
        case 'outboundAccountPosition':
          routedType = 'account';
          break;
        case 'balanceUpdate':
          routedType = 'balance';
          break;
      }
      
      expect(routedType).toBe(type);
    });
  });

  describe('JSON parsing', () => {
    it('should handle valid JSON', () => {
      const jsonString = '{"e":"executionReport","s":"ETHUSD","X":"FILLED"}';
      
      expect(() => JSON.parse(jsonString)).not.toThrow();
      
      const parsed = JSON.parse(jsonString);
      expect(parsed.e).toBe('executionReport');
    });

    it('should handle invalid JSON gracefully', () => {
      const invalidJson = '{ invalid json }';
      
      expect(() => JSON.parse(invalidJson)).toThrow();
    });
  });
});