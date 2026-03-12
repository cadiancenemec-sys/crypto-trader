/**
 * Multi-Exchange Trading API Routes
 * Supports: Kraken, Binance.US
 */

const express = require('express');
const router = express.Router();
const Kraken = require('kraken-api');
const binanceUSService = require('../services/binance-us-service');

// Rate limiting cache for REST API calls
const apiCache = {
  orders: null,
  ordersTime: 0,
  orderHistory: null,
  orderHistoryTime: 0
};
const CACHE_TTL = {
  orders: 30000,      // 30 seconds for open orders
  orderHistory: 60000 // 60 seconds for order history
};

// Get current exchange (from memory variable)
function getExchange() {
  return currentExchange || 'kraken';
}

// Initialize Kraken client
function getKrakenClient() {
  return new Kraken(
    process.env.KRAKEN_API_KEY,
    process.env.KRAKEN_API_SECRET,
    { timeout: 5000 }
  );
}

// Kraken pair mappings
const KRAKEN_PAIRS = {
  ETH: 'XETHZUSD',
  BTC: 'XXBTZUSD',
  LTC: 'XLTCZUSD'
};

// GET /api/exchange - Get current exchange
router.get('/exchange', (req, res) => {
  res.json({
    success: true,
    exchange: getExchange(),
    available: ['kraken', 'binance']
  });
});

// Store exchange in memory (allows switching without restart)
let currentExchange = process.env.EXCHANGE || 'kraken';

// GET /api/exchange - Get current exchange
router.get('/exchange', (req, res) => {
  res.json({
    success: true,
    exchange: currentExchange,
    available: ['kraken', 'binance']
  });
});

// POST /api/exchange - Switch exchange (no restart needed)
router.post('/exchange', (req, res) => {
  const { exchange } = req.body;
  
  if (!['kraken', 'binance'].includes(exchange)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Invalid exchange. Choose: kraken, binance' 
    });
  }
  
  currentExchange = exchange;
  console.log(`Exchange switched to: ${exchange}`);
  
  res.json({
    success: true,
    exchange,
    message: `Switched to ${exchange}`,
    restart: false
  });
});

// GET /api/summary
router.get('/summary', async (req, res) => {
  try {
    const exchange = getExchange();
    
    if (exchange === 'binance') {
      // Binance.US
      try {
        const balances = await binanceUSService.getBalances();
        const ticker = await binanceUSService.getTicker('ETHUSD');
      
        const ethBalance = balances.ETH?.total || 0;
        const usdBalance = balances.USD?.total || 0;
        const btcBalance = balances.BTC?.total || 0;
        const ltcBalance = balances.LTC?.total || 0;
        
        const ethPrice = ticker.last;
        const ethValue = ethBalance * ethPrice;
        
        res.json({
          success: true,
          data: {
            balances: {
              USD: usdBalance,
              ETH: ethBalance,
              BTC: btcBalance,
              LTC: ltcBalance
            },
            ethPrice,
            ethValueUSD: ethValue,
            totalPortfolioValue: usdBalance + ethValue,
            feeRate: 0.001,
            exchange: 'binance',
            timestamp: new Date().toISOString()
          }
        });
      } catch (binanceError) {
        console.error('Binance.US error:', binanceError.message);
        res.json({
          success: false,
          error: binanceError.message,
          exchange: 'binance'
        });
      }
    } else {
      // Kraken
      const kraken = getKrakenClient();
      const balanceResult = await kraken.api('Balance');
      const balance = balanceResult.result || balanceResult;
      
      const tickerResult = await kraken.api('Ticker', { pair: 'XETHZUSD' });
      const ticker = tickerResult.result || tickerResult;
      const t = ticker.XETHZUSD;
      
      const ethPrice = parseFloat(t.c[0]);
      const ethBalance = parseFloat(balance.XETH || 0);
      const usdBalance = parseFloat(balance.ZUSD || 0);
      const ethValue = ethBalance * ethPrice;
      
      res.json({
        success: true,
        data: {
          balances: {
            USD: usdBalance,
            ETH: ethBalance,
            BTC: parseFloat(balance.XXBT || 0),
            LTC: parseFloat(balance.XLTC || 0)
          },
          ethPrice,
          ethValueUSD: ethValue,
          totalPortfolioValue: usdBalance + ethValue,
          feeRate: 0.0026,
          exchange: 'kraken',
          timestamp: new Date().toISOString()
        }
      });
    }
  } catch (error) {
    console.error('Summary error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/balance
router.get('/balance', async (req, res) => {
  try {
    const exchange = getExchange();
    
    if (exchange === 'binance') {
      try {
        const balances = await binanceUSService.getBalances();
        res.json({
          success: true,
          data: {
            USD: balances.USD?.total || 0,
            ETH: balances.ETH?.total || 0,
            BTC: balances.BTC?.total || 0,
            LTC: balances.LTC?.total || 0
          },
          exchange: 'binance'
        });
      } catch (binanceError) {
        console.warn('Binance balance error:', binanceError.message);
        res.json({
          success: false,
          error: 'Binance API rate limited. Please wait 10 minutes.',
          data: { USD: 0, ETH: 0, BTC: 0, LTC: 0 },
          exchange: 'binance'
        });
      }
    } else {
      const kraken = getKrakenClient();
      const balanceResult = await kraken.api('Balance');
      const balance = balanceResult.result || balanceResult;
      
      res.json({
        success: true,
        data: {
          USD: parseFloat(balance.ZUSD || 0),
          ETH: parseFloat(balance.XETH || 0),
          BTC: parseFloat(balance.XXBT || 0),
          LTC: parseFloat(balance.XLTC || 0)
        },
        exchange: 'kraken'
      });
    }
  } catch (error) {
    console.error('Balance error:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// GET /api/price
router.get('/price', async (req, res) => {
  try {
    const exchange = getExchange();
    
    if (exchange === 'binance') {
      try {
        // Try WebSocket cache first (instant, no rate limits!)
        const wsPrice = binanceUSService.getCurrentPrice();
        if (wsPrice && wsPrice > 0) {
          console.log('📡 Returning WebSocket price:', wsPrice.toFixed(2));
          res.json({
            success: true,
            data: binanceUSService.priceCache,
            exchange: 'binance',
            source: 'websocket'
          });
        } else {
          // Fallback to REST API (rate-limited)
          const ticker = await binanceUSService.getTicker('ETHUSD');
          res.json({
            success: true,
            data: ticker,
            exchange: 'binance',
            source: 'rest-api'
          });
        }
      } catch (binanceError) {
        console.warn('Binance price error:', binanceError.message);
        res.json({
          success: false,
          error: 'Binance API rate limited. Please wait.',
          data: { last: 0, bid: 0, ask: 0 },
          exchange: 'binance'
        });
      }
    } else {
      const kraken = getKrakenClient();
      const tickerResult = await kraken.api('Ticker', { pair: 'XETHZUSD' });
      const ticker = tickerResult.result || tickerResult;
      const t = ticker.XETHZUSD;
      
      res.json({
        success: true,
        data: {
          last: parseFloat(t.c[0]),
          bid: parseFloat(t.b[0]),
          ask: parseFloat(t.a[0]),
          high: parseFloat(t.h[1]),
          low: parseFloat(t.l[1]),
          volume: parseFloat(t.v[1]),
          pair: 'ETH/USD'
        },
        exchange: 'kraken'
      });
    }
  } catch (error) {
    console.error('Price error:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// POST /api/buy
router.post('/buy', async (req, res) => {
  try {
    const exchange = getExchange();
    const { amountUSD, amountETH, orderType = 'market', limitPrice } = req.body;
    
    // Support both USD amount and ETH amount
    let targetAmountUSD = amountUSD;
    let targetAmountETH = amountETH;
    
    if (exchange === 'binance') {
      if (amountETH) {
        // Calculate USD equivalent for limit orders
        if (orderType === 'limit' && limitPrice) {
          const result = await binanceUSService.buyETHAmount(amountETH, limitPrice);
          res.json(result);
        } else {
          const result = await binanceUSService.buyETHAmount(amountETH);
          res.json(result);
        }
      } else {
        const result = await binanceUSService.buyETH(amountUSD, orderType === 'limit' ? limitPrice : null);
        res.json(result);
      }
    } else {
      const kraken = getKrakenClient();
      
      const tickerResult = await kraken.api('Ticker', { pair: 'XETHZUSD' });
      const ticker = tickerResult.result || tickerResult;
      const price = orderType === 'limit' ? limitPrice : parseFloat(ticker.XETHZUSD.a[0]);
      const feeRate = 0.0026;
      const ethAmount = (amountUSD / price) * (1 - feeRate);
      
      const orderResult = await kraken.api('AddOrder', {
        pair: 'XETHZUSD',
        type: 'buy',
        volume: ethAmount.toFixed(8),
        ordertype: orderType,
        price: orderType === 'limit' ? limitPrice : undefined
      });
      const order = orderResult.result || orderResult;
      
      res.json({
        success: true,
        data: {
          type: 'buy',
          amountUSD,
          ethAmount: ethAmount.toFixed(6),
          price,
          fee: (amountUSD * feeRate).toFixed(2),
          orderIds: order.txid,
          description: order.descr,
          exchange: 'kraken'
        }
      });
    }
  } catch (error) {
    console.error('Buy error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /api/sell
router.post('/sell', async (req, res) => {
  try {
    const exchange = getExchange();
    const { amountETH, orderType = 'market', limitPrice } = req.body;
    
    if (!amountETH || amountETH <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }
    
    if (exchange === 'binance') {
      if (orderType === 'limit' && limitPrice) {
        // Place limit order
        const result = await binanceUSService.sellETHLimit(amountETH, limitPrice);
        res.json(result);
      } else {
        // Place market order
        const result = await binanceUSService.sellETH(amountETH);
        res.json(result);
      }
    } else {
      const kraken = getKrakenClient();
      
      const tickerResult = await kraken.api('Ticker', { pair: 'XETHZUSD' });
      const ticker = tickerResult.result || tickerResult;
      const price = orderType === 'limit' ? limitPrice : parseFloat(ticker.XETHZUSD.b[0]);
      const feeRate = 0.0026;
      const usdReturn = (amountETH * price) * (1 - feeRate);
      
      const orderResult = await kraken.api('AddOrder', {
        pair: 'XETHZUSD',
        type: 'sell',
        volume: amountETH.toFixed(8),
        ordertype: orderType,
        price: orderType === 'limit' ? limitPrice : undefined
      });
      const order = orderResult.result || orderResult;
      
      res.json({
        success: true,
        data: {
          type: 'sell',
          amountETH: amountETH.toFixed(6),
          usdReturn: usdReturn.toFixed(2),
          price,
          fee: (usdReturn * feeRate).toFixed(2),
          orderIds: order.txid,
          description: order.descr,
          exchange: 'kraken'
        }
      });
    }
  } catch (error) {
    console.error('Sell error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /api/sell-btc
router.post('/sell-btc', async (req, res) => {
  try {
    const exchange = getExchange();
    const { amountBTC, orderType = 'market', limitPrice } = req.body;
    
    if (!amountBTC || amountBTC <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }
    
    if (exchange === 'binance') {
      if (orderType === 'limit' && limitPrice) {
        const result = await binanceUSService.sellAssetLimit('BTC', amountBTC, limitPrice);
        res.json(result);
      } else {
        const result = await binanceUSService.sellAsset('BTC', amountBTC);
        res.json(result);
      }
    } else {
      const kraken = getKrakenClient();
      
      const tickerResult = await kraken.api('Ticker', { pair: 'XXBTZUSD' });
      const ticker = tickerResult.result || tickerResult;
      const price = parseFloat(ticker.XXBTZUSD.b[0]);
      const feeRate = 0.0026;
      const usdReturn = (amountBTC * price) * (1 - feeRate);
      
      const orderResult = await kraken.api('AddOrder', {
        pair: 'XXBTZUSD',
        type: 'sell',
        volume: amountBTC.toFixed(8)
      });
      const order = orderResult.result || orderResult;
      
      res.json({
        success: true,
        data: {
          type: 'sell',
          asset: 'BTC',
          amountBTC: amountBTC.toFixed(6),
          usdReturn: usdReturn.toFixed(2),
          price,
          fee: (usdReturn * feeRate).toFixed(2),
          orderIds: order.txid,
          description: order.descr,
          exchange: 'kraken'
        }
      });
    }
  } catch (error) {
    console.error('Sell BTC error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /api/sell-ltc
router.post('/sell-ltc', async (req, res) => {
  try {
    const exchange = getExchange();
    const { amountLTC, orderType = 'market', limitPrice } = req.body;
    
    if (!amountLTC || amountLTC <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }
    
    if (exchange === 'binance') {
      if (orderType === 'limit' && limitPrice) {
        const result = await binanceUSService.sellAssetLimit('LTC', amountLTC, limitPrice);
        res.json(result);
      } else {
        const result = await binanceUSService.sellAsset('LTC', amountLTC);
        res.json(result);
      }
    } else {
      const kraken = getKrakenClient();
      
      const tickerResult = await kraken.api('Ticker', { pair: 'XLTCZUSD' });
      const ticker = tickerResult.result || tickerResult;
      const price = parseFloat(ticker.XLTCZUSD.b[0]);
      const feeRate = 0.0026;
      const usdReturn = (amountLTC * price) * (1 - feeRate);
      
      const orderResult = await kraken.api('AddOrder', {
        pair: 'XLTCZUSD',
        type: 'sell',
        volume: amountLTC.toFixed(8)
      });
      const order = orderResult.result || orderResult;
      
      res.json({
        success: true,
        data: {
          type: 'sell',
          asset: 'LTC',
          amountLTC: amountLTC.toFixed(6),
          usdReturn: usdReturn.toFixed(2),
          price,
          fee: (usdReturn * feeRate).toFixed(2),
          orderIds: order.txid,
          description: order.descr,
          exchange: 'kraken'
        }
      });
    }
  } catch (error) {
    console.error('Sell LTC error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

// GET /api/orders - Get open orders
router.get('/orders', async (req, res) => {
  try {
    const exchange = getExchange();
    
    if (exchange === 'binance') {
      // Check cache first (30 second cache)
      const now = Date.now();
      if (apiCache.orders && (now - apiCache.ordersTime) < CACHE_TTL.orders) {
        console.log('📦 Returning cached open orders (30s cache)');
        return res.json({ success: true, data: apiCache.orders, exchange: 'binance' });
      }
      
      // Rate limit before making request
      await binanceUSService.rateLimitDelay();
      
      // Get open orders from Binance.US
      console.log('📡 Fetching fresh open orders from API...');
      const openOrders = await binanceUSService.request('/api/v3/openOrders');
      
      // Convert to consistent format
      const formattedOrders = {};
      openOrders.forEach(order => {
        formattedOrders[order.orderId] = {
          orderId: order.orderId,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          price: order.price,
          origQty: order.origQty,
          executedQty: order.executedQty,
          status: order.status,
          time: order.time
        };
      });
      
      // Cache the result
      apiCache.orders = formattedOrders;
      apiCache.ordersTime = now;
      console.log('✅ Open orders cached for 30 seconds');
      
      res.json({ success: true, data: formattedOrders, exchange: 'binance' });
    } else {
      const kraken = getKrakenClient();
      const ordersResult = await kraken.api('OpenOrders');
      const orders = ordersResult.result || ordersResult;
      res.json({ success: true, data: orders.open || [], exchange: 'kraken' });
    }
  } catch (error) {
    console.error('Orders error:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// POST /api/cancel-order - Cancel an order
router.post('/cancel-order', async (req, res) => {
  try {
    const exchange = getExchange();
    const { symbol, orderId } = req.body;
    
    if (exchange === 'binance') {
      const result = await binanceUSService.request('/api/v3/order', {
        symbol,
        orderId,
        origClientOrderId: orderId
      }, 'DELETE');
      
      res.json({ success: true, data: result });
    } else {
      res.json({ success: false, error: 'Cancel not implemented for this exchange' });
    }
  } catch (error) {
    console.error('Cancel order error:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// GET /api/order-history - Get order history
router.get('/order-history', async (req, res) => {
  try {
    const exchange = getExchange();
    
    if (exchange === 'binance') {
      // Check cache first (60 second cache)
      const now = Date.now();
      if (apiCache.orderHistory && (now - apiCache.orderHistoryTime) < CACHE_TTL.orderHistory) {
        console.log('📦 Returning cached order history (60s cache)');
        return res.json({ success: true, data: apiCache.orderHistory, exchange: 'binance' });
      }
      
      // Rate limit before making request
      await binanceUSService.rateLimitDelay();
      
      // Fetch actual order history from Binance.US for ETHUSD
      console.log('📡 Fetching fresh order history from API...');
      const history = await binanceUSService.request('/api/v3/allOrders', { 
        symbol: 'ETHUSD',
        limit: 50 
      });
      
      // Cache the result
      apiCache.orderHistory = history;
      apiCache.orderHistoryTime = now;
      console.log('✅ Order history cached for 60 seconds');
      
      res.json({ success: true, data: history, exchange: 'binance' });
    } else {
      res.json({ success: true, data: [], exchange: 'kraken' });
    }
  } catch (error) {
    console.error('Order history error:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// GET /api/fees
router.get('/fees', (req, res) => {
  const exchange = getExchange();
  
  if (exchange === 'binance') {
    res.json({
      success: true,
      data: {
        maker: 0.001,
        taker: 0.001,
        note: 'Binance.US: 0.1% flat fee',
        exchange: 'binance'
      }
    });
  } else {
    res.json({
      success: true,
      data: {
        maker: 0.0016,
        taker: 0.0026,
        note: 'Kraken: Tiered fee structure',
        exchange: 'kraken'
      }
    });
  }
});

// GET /api/test
router.get('/test', async (req, res) => {
  try {
    const exchange = getExchange();
    
    if (exchange === 'binance') {
      const result = await binanceUSService.testConnection();
      res.json({ 
        ...result,
        exchange: 'binance',
        keyLoaded: !!process.env.BINANCE_API_KEY,
        secretLoaded: !!process.env.BINANCE_API_SECRET
      });
    } else {
      const kraken = getKrakenClient();
      const balance = await kraken.api('Balance');
      res.json({ 
        success: true, 
        message: 'Kraken API working!',
        balances: balance,
        exchange: 'kraken',
        keyLoaded: !!process.env.KRAKEN_API_KEY,
        secretLoaded: !!process.env.KRAKEN_API_SECRET
      });
    }
  } catch (error) {
    res.json({ 
      success: false, 
      error: error.message,
      keyLoaded: true,
      secretLoaded: true
    });
  }
});

// GET /api/trading-status
router.get('/trading-status', async (req, res) => {
  try {
    const exchange = getExchange();
    
    if (exchange === 'binance') {
      const result = await binanceUSService.checkTradingEnabled();
      res.json({
        ...result,
        exchange: 'binance'
      });
    } else {
      const kraken = getKrakenClient();
      await kraken.api('AddOrder', {
        pair: 'XETHZUSD',
        type: 'buy',
        volume: '0.0001',
        ordertype: 'market',
        validate: true
      });
      
      res.json({
        success: true,
        tradingEnabled: true,
        message: 'Trading is enabled! ✅',
        exchange: 'kraken'
      });
    }
  } catch (error) {
    const isValidationPending = error.message.includes('User Locked') || 
                                error.message.includes('validation') ||
                                error.message.includes('permissions');
    
    res.json({
      success: false,
      tradingEnabled: false,
      error: error.message,
      validationPending: isValidationPending,
      message: isValidationPending ? 'API key validation in progress ⏳' : 'Trading disabled ❌',
      exchange: getExchange()
    });
  }
});

// GET /api/config - Get current API config (masked)
router.get('/config', (req, res) => {
  const exchange = getExchange();
  const apiKey = exchange === 'binance' ? 
    process.env.BINANCE_API_KEY : 
    process.env.KRAKEN_API_KEY;
  
  const maskedKey = apiKey ? 
    `${apiKey.substring(0, 20)}...${apiKey.substring(apiKey.length - 10)}` : 
    '';
  
  res.json({
    success: true,
    exchange,
    apiKey: maskedKey,
    keyConfigured: !!apiKey
  });
});

// POST /api/config - Update API configuration
router.post('/config', async (req, res) => {
  const fs = require('fs').promises;
  const path = require('path');
  const exchange = getExchange();
  const { apiKey, apiSecret } = req.body;
  
  try {
    const envPath = path.join(__dirname, '../.env');
    let envContent = await fs.readFile(envPath, 'utf8');
    
    const keyVar = exchange === 'binance' ? 'BINANCE_API_KEY' : 'KRAKEN_API_KEY';
    const secretVar = exchange === 'binance' ? 'BINANCE_API_SECRET' : 'KRAKEN_API_SECRET';
    
    if (apiKey) {
      envContent = envContent.replace(
        new RegExp(`^${keyVar}=.*$`, 'm'),
        `${keyVar}=${apiKey}`
      );
    }
    
    if (apiSecret) {
      envContent = envContent.replace(
        new RegExp(`^${secretVar}=.*$`, 'm'),
        `${secretVar}=${apiSecret}`
      );
    }
    
    await fs.writeFile(envPath, envContent, 'utf8');
    
    res.json({
      success: true,
      message: 'Configuration saved. Server restart may be required for changes to take effect.',
      exchange,
      keyUpdated: !!apiKey,
      secretUpdated: !!apiSecret
    });
  } catch (error) {
    console.error('Config save error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Backup Special Trades to file
// POST /api/save-pending-order - Save pending limit order to file
router.post('/save-pending-order', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const { orderId, ethAmount, limitPrice, targetPrice, targetProfitPct, targetProfitDollar } = req.body;
    
    // Validate required fields
    if (!orderId || !ethAmount || !limitPrice) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: orderId, ethAmount, limitPrice' 
      });
    }
    
    // Load existing pending orders
    const pendingFile = path.join(__dirname, '../pending-orders.json');
    let pendingData = { pending: [] };
    
    if (fs.existsSync(pendingFile)) {
      pendingData = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    }
    
    // Create new pending order
    const newOrder = {
      orderId: parseInt(orderId),
      type: 'buy_limit',
      asset: 'ETH',
      limitPrice: parseFloat(limitPrice),
      buyAmount: parseFloat(ethAmount),
      targetPrice: parseFloat(targetPrice),
      targetProfit: parseFloat(targetProfitDollar),
      targetProfitPct: parseFloat(targetProfitPct),
      status: 'NEW',
      createTime: new Date().toISOString()
    };
    
    // Add to pending list
    pendingData.pending.push(newOrder);
    
    // Save to file
    fs.writeFileSync(pendingFile, JSON.stringify(pendingData, null, 2));
    
    console.log('✅ Pending order saved to file:', newOrder.orderId);
    res.json({ success: true, orderId: newOrder.orderId });
    
  } catch (err) {
    console.error('❌ Error saving pending order:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/backup-special-trades', async (req, res) => {
  const fs = require('fs').promises;
  const path = require('path');
  const { trades } = req.body;
  
  try {
    const backupPath = path.join(__dirname, '../special-trades-backup.json');
    await fs.writeFile(backupPath, JSON.stringify(trades, null, 2), 'utf8');
    console.log('✅ Special trades backed up:', trades.length, 'trades');
    res.json({ success: true, message: 'Backup saved' });
  } catch (error) {
    console.error('Error backing up special trades:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Restore Special Trades from backup
router.get('/backup-special-trades', async (req, res) => {
  const fs = require('fs').promises;
  const path = require('path');
  
  try {
    const backupPath = path.join(__dirname, '../special-trades-backup.json');
    const data = await fs.readFile(backupPath, 'utf8');
    const trades = JSON.parse(data);
    
    // Handle both old format (array) and new format (object with active/completed)
    let activeTrades = [];
    let completedTrades = [];
    
    if (Array.isArray(trades)) {
      // Old format - filter by status
      activeTrades = trades.filter(t => t.status === 'active');
      completedTrades = trades.filter(t => t.status === 'completed');
    } else {
      // New format - has active and completed arrays
      activeTrades = trades.active || [];
      completedTrades = trades.completed || [];
    }
    
    console.log('📦 Restored special trades:', activeTrades.length, 'active,', completedTrades.length, 'completed');
    console.log('📦 Active order IDs:', activeTrades.map(t=>t.sellOrderId));
    
    res.json({ 
      success: true, 
      data: {
        active: activeTrades,
        completed: completedTrades
      }
    });
  } catch (error) {
    // No backup exists yet - that's OK
    res.json({ success: false, data: { active: [], completed: [] } });
  }
});

module.exports = router;

// ============================================
// PENDING ORDERS API - Backend Storage
// ============================================

// GET /api/pending-orders - Fetch all pending orders
router.get('/pending-orders', async (req, res) => {
  const fs = require('fs').promises;
  const path = require('path');
  
  try {
    const pendingPath = path.join(__dirname, '../pending-orders.json');
    let data = { pending: [] };
    
    try {
      const fileData = await fs.readFile(pendingPath, 'utf8');
      data = JSON.parse(fileData);
    } catch (e) {
      // File doesn't exist yet, that's OK
    }
    
    res.json({ success: true, data: data.pending || [] });
  } catch (error) {
    console.error('Error fetching pending orders:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/pending-orders - Add a pending order
router.post('/pending-orders', async (req, res) => {
  const fs = require('fs').promises;
  const path = require('path');
  const { order } = req.body;
  
  if (!order) {
    return res.status(400).json({ success: false, error: 'Order data required' });
  }
  
  try {
    const pendingPath = path.join(__dirname, '../pending-orders.json');
    let data = { pending: [] };
    
    try {
      const fileData = await fs.readFile(pendingPath, 'utf8');
      data = JSON.parse(fileData);
    } catch (e) {
      // File doesn't exist yet
    }
    
    if (!data.pending) data.pending = [];
    data.pending.unshift(order);
    
    await fs.writeFile(pendingPath, JSON.stringify(data, null, 2), 'utf8');
    console.log('✅ Pending order saved:', order.orderId, '@ $' + order.limitPrice);
    
    res.json({ success: true, message: 'Pending order saved', data: order });
  } catch (error) {
    console.error('Error saving pending order:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/pending-orders/:orderId - Remove a pending order
router.delete('/pending-orders/:orderId', async (req, res) => {
  const fs = require('fs').promises;
  const path = require('path');
  const { orderId } = req.params;
  
  try {
    const pendingPath = path.join(__dirname, '../pending-orders.json');
    let data = { pending: [] };
    
    try {
      const fileData = await fs.readFile(pendingPath, 'utf8');
      data = JSON.parse(fileData);
    } catch (e) {
      return res.json({ success: true, message: 'No pending orders' });
    }
    
    const initialLength = data.pending.length;
    data.pending = data.pending.filter(o => o.orderId != orderId);
    
    if (data.pending.length < initialLength) {
      await fs.writeFile(pendingPath, JSON.stringify(data, null, 2), 'utf8');
      console.log('✅ Pending order removed:', orderId);
    }
    
    res.json({ success: true, removed: initialLength - data.pending.length });
  } catch (error) {
    console.error('Error removing pending order:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/pending-orders/:orderId - Update a pending order (e.g., convert to active)
router.put('/pending-orders/:orderId', async (req, res) => {
  const fs = require('fs').promises;
  const path = require('path');
  const { orderId } = req.params;
  const { updates } = req.body;
  
  try {
    const pendingPath = path.join(__dirname, '../pending-orders.json');
    let data = { pending: [] };
    
    try {
      const fileData = await fs.readFile(pendingPath, 'utf8');
      data = JSON.parse(fileData);
    } catch (e) {
      return res.status(404).json({ success: false, error: 'No pending orders' });
    }
    
    const order = data.pending.find(o => o.orderId == orderId);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    
    // Update the order
    Object.assign(order, updates);
    
    await fs.writeFile(pendingPath, JSON.stringify(data, null, 2), 'utf8');
    console.log('✅ Pending order updated:', orderId);
    
    res.json({ success: true, data: order });
  } catch (error) {
    console.error('Error updating pending order:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

