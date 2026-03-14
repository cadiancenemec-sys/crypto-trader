/**
 * DCA Grid Trading Bot Engine
 * 
 * Handles the core trading logic for DCA/grid strategies
 */

const trading = require('./trading-wrapper');
const tradingDb = require('./trading-db');

// Bot state
let isRunning = false;
let tickInterval = null;
let wsClients = [];

// Track pending orders per strategy
const strategyOrders = new Map();

// Initialize bot
function init(wss) {
  wsClients = wss;
  console.log('[DCA Bot] Initialized');
}

// Start the bot
function start(intervalMs = 5000) {
  if (isRunning) return;
  
  isRunning = true;
  tickInterval = setInterval(tick, intervalMs);
  console.log(`[DCA Bot] Started (tick every ${intervalMs}ms)`);
}

// Stop the bot
function stop() {
  isRunning = false;
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  console.log('[DCA Bot] Stopped');
}

// Main bot loop
async function tick() {
  if (!isRunning) return;
  
  const strategies = tradingDb.getActiveStrategies();
  
  for (const strategy of strategies) {
    try {
      // Check if autoEnd is enabled and no trades are pending
      if (strategy.autoEnd) {
        const gridSteps = strategy.gridSteps || [];
        const openBuys = gridSteps.filter(s => s.status === 'open_buy');
        const pendingSells = gridSteps.filter(s => s.status === 'pending_sell');
        
        if (openBuys.length === 0 && pendingSells.length === 0) {
          tradingDb.updateStrategy(strategy.id, { status: 'completed' });
          console.log(`[DCA Bot] Strategy ${strategy.id} marked as completed (auto-end, no pending trades)`);
          continue; // Skip processing this strategy
        }
      }
      
      await processStrategy(strategy);
    } catch (e) {
      console.error(`[DCA Bot] Error processing strategy ${strategy.id}:`, e.message);
    }
  }
}

// Process a single strategy
async function processStrategy(strategy) {
  const symbol = strategy.symbol;
  const currentPrice = await trading.getPrice(symbol);
  
  // Get all orders for this strategy's symbol (including filled)
  const allOrders = trading.getAllOrders(symbol);
  const buyOrders = allOrders.filter(o => o.side === 'BUY');
  const sellOrders = allOrders.filter(o => o.side === 'SELL');
  const openOrders = allOrders.filter(o => o.status === 'NEW');
  
  // 1. Check for filled orders and handle them
  await processFills(strategy, buyOrders, sellOrders);
  
  // 2. Re-fetch strategy to get updated budget after fills
  const updatedStrategy = tradingDb.getStrategy(strategy.id);
  
  // 3. Re-fetch open orders after processing fills
  const currentOrders = trading.getAllOrders(symbol);
  const openBuyOrders = currentOrders.filter(o => o.side === 'BUY' && o.status === 'NEW');
  
  // Place more buys if we can afford them (based on available cash, regardless of pending sells)
  if (openBuyOrders.length < updatedStrategy.gridLevels) {
    await placeBuyOrders(updatedStrategy, currentPrice, openBuyOrders);
  }
  
  // 3. Check emergency drop protection
  if (strategy.emergencyDropEnabled && sellOrders.length > 0) {
    await checkEmergencyDrop(strategy, sellOrders, currentPrice);
  }
  
  // Broadcast status
  broadcastStrategyUpdate(strategy);
}

// Process filled orders
async function processFills(strategy, buyOrders, sellOrders) {
  // Check for filled buy orders -> create sell
  for (const order of buyOrders) {
    if (order.status === 'FILLED' && !order.processed) {
      // Get fresh strategy data for profit target and budget
      const freshStrategy = tradingDb.getStrategy(strategy.id);
      
      const sellPrice = order.price * (1 + freshStrategy.profitTarget / 100);
      const orderCost = order.price * order.quantity;
      
      // Deduct from usable budget (money is now in the position)
      const newUsableBudget = (freshStrategy.usableBudget || freshStrategy.totalBudget) - orderCost;
      tradingDb.updateStrategy(strategy.id, { usableBudget: Math.max(0, newUsableBudget) });
      
      const mockOrder = trading.placeOrder(
        strategy.symbol,
        'SELL',
        order.quantity,
        sellPrice
      );
      
      // Find and update the grid step
      const gridStep = freshStrategy.gridSteps?.find(s => s.buyOrderId === order.orderId);
      if (gridStep) {
        tradingDb.updateGridStep(strategy.id, gridStep.level, {
          status: 'pending_sell',
          sellOrderId: mockOrder.orderId,
          filledAt: new Date().toISOString()
        });
      } else {
        // Fallback: try to find by price if orderId not matched
        const level = Math.round((freshStrategy.startPrice - order.price) / freshStrategy.gridSpacing);
        tradingDb.updateGridStep(strategy.id, level, {
          status: 'pending_sell',
          sellOrderId: mockOrder.orderId,
          filledAt: new Date().toISOString()
        });
      }
      
      // Mark as processed so we don't create duplicate sells
      order.processed = true;
      trading.saveState();
      console.log(`[DCA Bot] Buy filled @ ${order.price} ($${orderCost.toFixed(2)}), usable budget now $${Math.max(0, newUsableBudget).toFixed(2)}`);
      broadcastOrder(mockOrder);
    }
  }
  
  // Check for filled sell orders -> record profit + recreate buy
  for (const order of sellOrders) {
    if (order.status === 'FILLED' && !order.processed) {
      // Get fresh strategy data (in case budget was updated by buy fills)
      const freshStrategy = tradingDb.getStrategy(strategy.id);
      
      // Find the original buy price (find the most recent processed buy order)
      const allOrders = trading.getAllOrders(strategy.symbol);
      const filledBuys = allOrders.filter(o => o.side === 'BUY' && o.status === 'FILLED' && o.processed === true);
      const buyOrder = filledBuys[filledBuys.length - 1];
      
      const buyPrice = buyOrder ? buyOrder.price : order.price / (1 + freshStrategy.profitTarget / 100);
      const buyFee = buyOrder?.fee || 0;
      const sellFee = order.fee || 0;
      const totalFees = buyFee + sellFee;
      
      // Calculate profit with fees
      const grossProfit = (order.price - buyPrice) * order.quantity;
      const profit = grossProfit - totalFees;
      
      // Calculate what we get back from the sell (principal + profit)
      const sellProceeds = order.price * order.quantity;
      
      // Add back to usable budget (principal + profit = what we sold for)
      const currentUsable = freshStrategy.usableBudget || freshStrategy.totalBudget;
      const newUsableBudget = currentUsable + sellProceeds;
      
      // Cap at totalBudget (shouldn't exceed, but just in case)
      const cappedBudget = Math.min(newUsableBudget, freshStrategy.totalBudget);
      
      tradingDb.updateStrategy(strategy.id, { usableBudget: cappedBudget });
      
      // Find and update the grid step to completed, then reset to available for reuse
      const gridStep = freshStrategy.gridSteps?.find(s => s.sellOrderId === order.orderId);
      if (gridStep) {
        tradingDb.updateGridStep(strategy.id, gridStep.level, {
          status: 'completed',
          completedAt: new Date().toISOString()
        });
        // Reset to available so the level can be reused for a new buy order
        setTimeout(() => {
          tradingDb.updateGridStep(strategy.id, gridStep.level, {
            status: 'available',
            orderId: null,
            buyOrderId: null,
            sellOrderId: null,
            filledAt: null,
            completedAt: null
          });
        }, 100);
      }
      
      // Record completed trade
      tradingDb.addCompletedTrade({
        strategyId: strategy.id,
        symbol: strategy.symbol,
        buyPrice,
        sellPrice: order.price,
        quantity: order.quantity,
        profit,
        profitPercent: strategy.profitTarget,
        fees: totalFees
      });
      
      // Mark as processed
      order.processed = true;
      trading.saveState();
      
      console.log(`[DCA Bot] Sell filled @ ${order.price}, profit: $${profit.toFixed(2)}, usable budget now $${cappedBudget.toFixed(2)}`);
      
      // Recreate buy orders UNLESS auto-end is enabled (finish existing trades but don't start new ones)
      if (!freshStrategy.autoEnd) {
        const freshForBuyOrders = tradingDb.getStrategy(strategy.id);
        const price = await trading.getPrice(freshStrategy.symbol);
        await placeBuyOrders(freshForBuyOrders, price, []);
      } else {
        // Auto-end enabled: mark strategy as completed when all trades are done
        // Check gridSteps for any open buys or pending sells
        const updatedStrategy = tradingDb.getStrategy(strategy.id);
        const gridSteps = updatedStrategy.gridSteps || [];
        const openBuys = gridSteps.filter(s => s.status === 'open_buy');
        const pendingSells = gridSteps.filter(s => s.status === 'pending_sell');
        
        if (openBuys.length === 0 && pendingSells.length === 0) {
          // No open trades, mark as completed
          tradingDb.updateStrategy(strategy.id, { status: 'completed' });
          console.log(`[DCA Bot] Strategy ${strategy.id} marked as completed (auto-end)`);
        }
      }
    }
  }
}

// Place buy orders at grid levels
async function placeBuyOrders(strategy, currentPrice, existingBuyOrders) {
  // Skip if auto-end is enabled (no new trades, just finish existing)
  if (strategy.autoEnd) {
    console.log(`[DCA Bot] Auto-end enabled for strategy ${strategy.id}, skipping new buy orders`);
    return;
  }
  
  const symbol = strategy.symbol;
  const spacing = strategy.gridSpacing;
  const levels = strategy.gridLevels;
  const amount = strategy.tradeAmount;
  
  // Get all orders to calculate what's committed
  const allOrders = trading.getAllOrders(symbol);
  
  // Calculate cost of already-open (NEW) buy orders
  const openBuyCost = allOrders
    .filter(o => o.side === 'BUY' && o.status === 'NEW')
    .reduce((sum, o) => sum + (o.price * o.quantity), 0);
  
  // Calculate cost of filled buys and sells (net committed)
  const filledBuyCost = allOrders
    .filter(o => o.side === 'BUY' && o.status === 'FILLED')
    .reduce((sum, o) => sum + (o.price * o.quantity), 0);
  
  const filledSellValue = allOrders
    .filter(o => o.side === 'SELL' && o.status === 'FILLED')
    .reduce((sum, o) => sum + (o.price * o.quantity), 0);
  
  // Net committed = filled buys - filled sells (money tied up in positions)
  const netCommitted = filledBuyCost - filledSellValue;
  
  // Available cash = total budget minus open buys minus net committed
  const availableCash = strategy.totalBudget - openBuyCost - netCommitted;
  
  // Calculate order cost (in quote currency, e.g., USD for ETHUSDT)
  const orderCost = amount * currentPrice;
  
  // Check if we have enough available cash to place at least one order
  if (availableCash < orderCost) {
    console.log(`[DCA Bot] Insufficient cash: $${availableCash.toFixed(2)} available ($${openBuyCost.toFixed(2)} open + $${netCommitted.toFixed(2)} committed), need $${orderCost.toFixed(2)} per order`);
    return;
  }
  
  // Calculate max orders we can afford with available cash
  const maxOrdersByBudget = Math.floor(availableCash / orderCost);
  const maxOrders = Math.min(levels, maxOrdersByBudget);
  
  console.log(`[DCA Bot] Cash: $${availableCash.toFixed(2)} / $${strategy.totalBudget}, can afford ${maxOrders} of ${levels} levels`);
  
  // Get the base price - use startPrice if set, otherwise current price
  const startPrice = strategy.startPrice || currentPrice;
  
  // Use gridSteps from strategy to determine which levels are available
  const gridSteps = strategy.gridSteps || [];
  
  // Determine which levels are "busy" (not available)
  // A level is busy if it has an open buy, or a filled buy awaiting sell, or a pending sell
  // BUT: if status is "open_buy" with no orderId, it means order was never actually placed - treat as available
  const busyLevels = new Set();
  for (const step of gridSteps) {
    if (step.status === 'open_buy') {
      // If there's no orderId, the order was never actually placed on Binance - treat as available
      if (step.orderId || step.buyOrderId) {
        busyLevels.add(step.level);
      }
      // else: not actually busy, will try to place order
    } else if (step.status === 'filled_buy' || step.status === 'pending_sell') {
      busyLevels.add(step.level);
    }
  }
  
  // Place orders at grid levels (startPrice, startPrice - spacing, startPrice - 2*spacing, etc.)
  // But skip any levels that are busy
  const ordersToPlace = [];
  for (let level = 0; level < levels; level++) {
    // Skip busy levels
    if (busyLevels.has(level)) {
      continue;
    }
    
    const targetPrice = startPrice - (level * spacing);
    
    // Only place if price is reasonable (not too far below current)
    if (targetPrice >= currentPrice * 0.5) {
      ordersToPlace.push({ level, price: targetPrice });
    }
    
    // Stop if we've placed enough
    if (ordersToPlace.length >= maxOrders) {
      break;
    }
  }
  
  // Place the orders and update grid steps
  for (const { level, price } of ordersToPlace) {
    const order = await trading.placeOrder(symbol, 'BUY', amount, price);
    console.log(`[DCA Bot] Placed buy order: ${amount} ${symbol} @ $${price} (level ${level})`);
    
    // Update grid step to track this order
    tradingDb.updateGridStep(strategy.id, level, {
      status: 'open_buy',
      orderId: order.orderId,
      buyOrderId: order.orderId
    });
    
    broadcastOrder(order);
  }
}

// Check emergency drop protection
async function checkEmergencyDrop(strategy, sellOrders, currentPrice) {
  // Find the lowest pending sell's buy price
  // We need to track this - for now, use a simple heuristic
  
  // Check if price dropped significantly
  const threshold = 1 + (strategy.emergencyDropPercent / 100);
  const lowestSell = sellOrders.reduce((min, o) => o.price < min ? o.price : min, Infinity);
  const triggerPrice = lowestSell / threshold;
  
  if (currentPrice < triggerPrice) {
    console.log(`[DCA Bot] Emergency drop triggered! Price: $${currentPrice}, Trigger: $${triggerPrice}`);
    // TODO: Implement the reverse profit logic
    // For now, just log it
  }
}

// Broadcast to WebSocket clients
function broadcastToAll(data) {
  const msg = JSON.stringify(data);
  wsClients.forEach(ws => {
    if (ws.readyState === ws.OPEN) {
      ws.send(msg);
    }
  });
}

function broadcastStrategyUpdate(strategy) {
  const stats = tradingDb.getStrategyStats(strategy.id);
  const openOrders = trading.getOpenOrders(strategy.symbol);
  const trades = tradingDb.getAllCompletedTrades(strategy.id).slice(-5);
  
  broadcastToAll({
    type: 'strategy_update',
    data: {
      ...strategy,
      stats,
      openOrders: openOrders.length,
      recentTrades: trades
    }
  });
}

function broadcastOrder(order) {
  broadcastToAll({
    type: 'order_update',
    data: order
  });
}

// Get bot status
function getStatus() {
  return {
    running: isRunning,
    activeStrategies: tradingDb.getActiveStrategies().length,
    openOrders: trading.getOpenOrders().length
  };
}

module.exports = {
  init,
  start,
  stop,
  tick,
  getStatus,
  placeBuyOrders
};