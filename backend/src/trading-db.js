/**
 * Trading Database Module
 * 
 * Manages trading strategies, orders, and completed trades
 */

const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const STRATEGIES_FILE = path.join(DATA_DIR, 'strategies.json');
const TRADES_FILE = path.join(DATA_DIR, 'completed-trades.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ===== GRID STEP HELPERS =====

function generateGridSteps(startPrice, levels, spacing, strategyType = 'buy_sell') {
  const steps = [];
  for (let i = 0; i < levels; i++) {
    // For buy_sell (normal DCA): grid goes DOWN from start price (buy low)
    // For sell_buy (reverse DCA): grid goes UP from start price (sell high first)
    const price = strategyType === 'sell_buy' 
      ? startPrice + (i * spacing) 
      : startPrice - (i * spacing);
    
    steps.push({
      level: i,
      price: price,
      // For buy_sell: starts with buy orders (open_buy when placed)
      // For sell_buy: starts with sell orders (open_sell when placed)
      status: strategyType === 'sell_buy' ? 'available_sell' : 'available',
      orderId: null,
      buyOrderId: null,
      sellOrderId: null,
      filledAt: null,
      completedAt: null
    });
  }
  return steps;
}

function updateGridStep(strategyId, level, updates) {
  const strategy = strategies.find(s => s.id === strategyId);
  if (!strategy || !strategy.gridSteps) return null;
  
  const stepIndex = strategy.gridSteps.findIndex(s => s.level === level);
  if (stepIndex === -1) return null;
  
  strategy.gridSteps[stepIndex] = {
    ...strategy.gridSteps[stepIndex],
    ...updates
  };
  
  saveJSON(STRATEGIES_FILE, strategies);
  return strategy.gridSteps[stepIndex];
}

function getGridStep(strategyId, level) {
  const strategy = strategies.find(s => s.id === strategyId);
  if (!strategy || !strategy.gridSteps) return null;
  return strategy.gridSteps.find(s => s.level === level);
}

// Load/save helpers
function loadJSON(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    console.error(`[DB] Error loading ${file}:`, e.message);
  }
  return null;
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[DB] Error saving ${file}:`, e.message);
  }
}

// In-memory cache
let strategies = loadJSON(STRATEGIES_FILE) || [];
let completedTrades = loadJSON(TRADES_FILE) || [];
let nextStrategyId = strategies.length > 0 ? Math.max(...strategies.map(s => s.id)) + 1 : 1;

// ===== STRATEGIES =====

function getAllStrategies() {
  return strategies.map(s => ({...s}));
}

function getStrategy(id) {
  return strategies.find(s => s.id === id) || null;
}

function createStrategy(config) {
  const strategy = {
    id: nextStrategyId++,
    symbol: config.symbol,
    strategyType: config.strategyType || 'buy_sell', // 'buy_sell' or 'sell_buy'
    tradeAmount: config.tradeAmount,
    totalBudget: config.totalBudget,
    usableBudget: config.totalBudget, // Track available budget for buys
    profitTarget: config.profitTarget,
    gridLevels: config.gridLevels || 2,
    gridSpacing: config.gridSpacing || 5,
    startPrice: config.startPrice,
    status: 'active',
    autoEnd: config.autoEnd || false,
    emergencyDropEnabled: config.emergencyDropEnabled || false,
    emergencyDropPercent: config.emergencyDropPercent || 5.0,
    emergencyDropMaxOrders: config.emergencyDropMaxOrders || 0,
    emergencyDropActive: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // Grid level tracking - pre-populate all levels
    gridSteps: generateGridSteps(config.startPrice, config.gridLevels, config.gridSpacing, config.strategyType || 'buy_sell')
  };
  
  strategies.push(strategy);
  saveJSON(STRATEGIES_FILE, strategies);
  return strategy;
}

function updateStrategy(id, updates) {
  const index = strategies.findIndex(s => s.id === id);
  if (index === -1) return null;
  
  strategies[index] = {
    ...strategies[index],
    ...updates,
    updatedAt: new Date().toISOString()
  };
  
  saveJSON(STRATEGIES_FILE, strategies);
  return strategies[index];
}

function deleteStrategy(id) {
  const index = strategies.findIndex(s => s.id === id);
  if (index === -1) return false;
  
  strategies.splice(index, 1);
  saveJSON(STRATEGIES_FILE, strategies);
  return true;
}

function getActiveStrategies() {
  return strategies.filter(s => s.status === 'active');
}

// ===== COMPLETED TRADES =====

function getAllCompletedTrades(strategyId = null) {
  if (strategyId) {
    return completedTrades.filter(t => t.strategyId === strategyId);
  }
  return [...completedTrades];
}

function addCompletedTrade(trade) {
  const record = {
    id: completedTrades.length + 1,
    ...trade,
    completedAt: new Date().toISOString()
  };
  completedTrades.push(record);
  saveJSON(TRADES_FILE, completedTrades);
  return record;
}

function getTotalProfit(strategyId = null) {
  const trades = strategyId 
    ? completedTrades.filter(t => t.strategyId === strategyId)
    : completedTrades;
  return trades.reduce((sum, t) => sum + (t.profit || 0), 0);
}

// ===== STRATEGY STATS =====

function getStrategyStats(id) {
  const trades = completedTrades.filter(t => t.strategyId === id);
  return {
    totalTrades: trades.length,
    totalProfit: trades.reduce((sum, t) => sum + (t.profit || 0), 0),
    totalVolume: trades.reduce((sum, t) => sum + (t.quantity * t.buyPrice), 0)
  };
}

module.exports = {
  // Strategies
  getAllStrategies,
  getStrategy,
  createStrategy,
  updateStrategy,
  deleteStrategy,
  getActiveStrategies,
  
  // Completed trades
  getAllCompletedTrades,
  addCompletedTrade,
  getTotalProfit,
  getStrategyStats,
  
  // Grid steps
  generateGridSteps,
  updateGridStep,
  getGridStep
};