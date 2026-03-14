const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', '..', '..', 'data', 'crypto-bot.db');

// Ensure data directory exists
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db = null;
let SQL = null;

// Initialize database
async function initDb() {
  SQL = await initSqlJs();
  
  // Try to load existing DB
  let data = null;
  if (fs.existsSync(dbPath)) {
    data = fs.readFileSync(dbPath);
  }
  
  db = new SQL.Database(data);
  
  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL,
      total REAL,
      status TEXT DEFAULT 'pending',
      filled_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT UNIQUE,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL,
      stop_price REAL,
      time_in_force TEXT,
      status TEXT DEFAULT 'open',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      interval TEXT NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      timestamp DATETIME NOT NULL,
      UNIQUE(symbol, interval, timestamp)
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Save to file
  saveDb();
  
  return db;
}

// Save database to file
function saveDb() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

// Helper functions - use getters to access db when available
const dbHelpers = {
  // Config
  getConfig: (key) => {
    if (!db) return null;
    const result = db.exec(`SELECT value FROM config WHERE key = '${key}'`);
    return result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : null;
  },
  
  setConfig: (key, value) => {
    if (!db) return;
    db.run(`INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('${key}', '${value}', datetime('now'))`);
    saveDb();
  },

  // Trades
  createTrade: (trade) => {
    if (!db) return;
    db.run(`
      INSERT INTO trades (order_id, symbol, side, quantity, price, total, status)
      VALUES ('${trade.order_id}', '${trade.symbol}', '${trade.side}', ${trade.quantity}, ${trade.price}, ${trade.total}, '${trade.status || 'pending'}')
    `);
    saveDb();
  },

  getTrades: (symbol, limit = 100) => {
    if (!db) return [];
    const result = db.exec(`SELECT * FROM trades WHERE symbol = '${symbol}' ORDER BY created_at DESC LIMIT ${limit}`);
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0], order_id: row[1], symbol: row[2], side: row[3],
      quantity: row[4], price: row[5], total: row[6], status: row[7],
      filled_at: row[8], created_at: row[9]
    }));
  },

  updateTradeStatus: (orderId, status, filledAt) => {
    if (!db) return;
    db.run(`UPDATE trades SET status = '${status}', filled_at = '${filledAt}' WHERE order_id = '${orderId}'`);
    saveDb();
  },

  // Orders
  createOrder: (order) => {
    if (!db) return;
    db.run(`
      INSERT OR REPLACE INTO orders (order_id, symbol, side, type, quantity, price, stop_price, time_in_force, status, updated_at)
      VALUES ('${order.order_id}', '${order.symbol}', '${order.side}', '${order.type}', ${order.quantity}, ${order.price}, ${order.stop_price || 'NULL'}, '${order.time_in_force || 'GTC'}', '${order.status || 'open'}', datetime('now'))
    `);
    saveDb();
  },

  getOpenOrders: (symbol) => {
    if (!db) return [];
    const result = db.exec(`SELECT * FROM orders WHERE symbol = '${symbol}' AND status = 'open' ORDER BY created_at DESC`);
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0], order_id: row[1], symbol: row[2], side: row[3], type: row[4],
      quantity: row[5], price: row[6], stop_price: row[7], time_in_force: row[8],
      status: row[9], created_at: row[10], updated_at: row[11]
    }));
  },

  updateOrderStatus: (orderId, status) => {
    if (!db) return;
    db.run(`UPDATE orders SET status = '${status}', updated_at = datetime('now') WHERE order_id = '${orderId}'`);
    saveDb();
  },

  // Price history
  insertPriceCandle: (candle) => {
    if (!db) return;
    db.run(`
      INSERT OR REPLACE INTO price_history (symbol, interval, open, high, low, close, volume, timestamp)
      VALUES ('${candle.symbol}', '${candle.interval}', ${candle.open}, ${candle.high}, ${candle.low}, ${candle.close}, ${candle.volume}, '${candle.timestamp}')
    `);
    saveDb();
  },

  getPriceHistory: (symbol, interval, limit = 100) => {
    if (!db) return [];
    const result = db.exec(`SELECT * FROM price_history WHERE symbol = '${symbol}' AND interval = '${interval}' ORDER BY timestamp DESC LIMIT ${limit}`);
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0], symbol: row[1], interval: row[2], open: row[3], high: row[4],
      low: row[5], close: row[6], volume: row[7], timestamp: row[8]
    }));
  },

  // Audit log
  log: (action, details) => {
    if (!db) {
      console.log(`[AUDIT ${action}] ${details}`);
      return;
    }
    const safeDetails = details ? details.replace(/'/g, "''") : '';
    db.run(`INSERT INTO audit_log (action, details) VALUES ('${action}', '${safeDetails}')`);
    saveDb();
  },
  
  // Get DB status
  isReady: () => db !== null
};

module.exports = { initDb, dbHelpers, saveDb };