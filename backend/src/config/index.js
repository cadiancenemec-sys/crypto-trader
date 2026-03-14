require('dotenv').config();

module.exports = {
  // API Configuration
  binance: {
    apiKey: process.env.BINANCE_API_KEY || '',
    apiSecret: process.env.BINANCE_API_SECRET || '',
    baseUrl: 'https://api.binance.us', // US-specific endpoint
  },

  // Server Configuration
  server: {
    port: process.env.PORT || 3003,
    wsPort: process.env.WS_PORT || 8080,
  },

  // Trading Configuration
  trading: {
    defaultSymbol: process.env.DEFAULT_SYMBOL || 'BTCUSD',
    checkIntervalMs: parseInt(process.env.CHECK_INTERVAL_MS) || 60000, // 1 minute
    pendingOrderCheckMs: parseInt(process.env.PENDING_ORDER_CHECK_MS) || 180000, // 3 minutes
  },

  // Database
  db: {
    path: process.env.DB_PATH || '../../data/crypto-bot.db',
  },

  // Logging
  log: {
    level: process.env.LOG_LEVEL || 'info',
  }
};