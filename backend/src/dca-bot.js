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
  
  // Start safety check interval - scans every 10 seconds for missing orders
  setInterval(checkMissingOrders, 10000);
  console.log('[DCA Bot] Safety check started (every 10s)');
}

// Safety check: verify all filled buys have their sell orders placed on Binance
async function checkMissingOrders() {
  if (!isRunning) return;
  
  const strategies = tradingDb.getActiveStrategies();
  
  for (const strategy of strategies) {
    try {
      const gridSteps = strategy.gridSteps || [];
      const symbol = strategy.symbol;
      
      // Get all orders from Binance
      const allOrders = await trading.getAllOrders(symbol);
      if (!Array.isArray(allOrders)) continue;
      
      // Check each grid step
      for (const step of gridSteps) {
        // Look for steps that are filled (buy completed) but missing sell order
        if (step.status === 'filled' || (step.status === 'open_buy' && step.filledAt && !step.sellOrderId)) {
          // Check if we have a real orderId for the buy
          const buyOrderId = step.orderId || step.buyOrderId;
          if (!buyOrderId) continue;
          
          // Find this order on Binance to see its actual status
          const binanceOrder = allOrders.find(o => o.orderId == buyOrderId);
          
          if (binanceOrder && binanceOrder.status === 'FILLED' && !step.sellOrderId) {
            // Buy is filled but no sell order exists! Create it now.
            console.log(`[DCA Safety] Buy order ${buyOrderId} filled but no sell found! Creating sell now...`);
            
            const sellPrice = Math.round(binanceOrder.price * (1 + strategy.profitTarget / 100) * 100) / 100;
            const mockOrder = await trading.placeOrder(
              symbol,
              'SELL',
              binanceOrder.origQty || binanceOrder.quantity,
              sellPrice
            );
            
            // Verify it was placed
            await new Promise(resolve => setTimeout(resolve, 500));
            const verifyOrders = await trading.getAllOrders(symbol);
            const verified = verifyOrders.find(o => o.orderId === mockOrder.orderId);
            
            if (verified) {
              tradingDb.updateGridStep(strategy.id, step.level, {
                status: 'pending_sell',
                orderId: mockOrder.orderId,
                sellOrderId: mockOrder.orderId
              });
              console.log(`[DCA Safety] ✓ Created missing sell order ${mockOrder.orderId} @ ${sellPrice}`);
            } else {
              console.error(`[DCA Safety] ✗ Failed to verify sell order on Binance`);
            }
          }
        }
        
        // Check if pending_sell orders still exist on Binance (or were cancelled)
        if (step.status === 'pending_sell' && step.sellOrderId) {
          const sellOrder = allOrders.find(o => o.orderId == step.sellOrderId);
          
          // If the sell order doesn't exist on Binance (was cancelled or never placed), reset the grid step
          if (!sellOrder) {
            console.log(`[DCA Safety] Sell order ${step.sellOrderId} not found on Binance, resetting grid step ${step.level}`);
            tradingDb.updateGridStep(strategy.id, step.level, {
              status: 'available',
              orderId: null,
              buyOrderId: null,
              sellOrderId: null,
              filledAt: null,
              completedAt: null
            });
            continue;
          }
          
          // If sell is filled, mark as completed
          if (sellOrder.status === 'FILLED') {
            // Sell completed - update to completed
            tradingDb.updateGridStep(strategy.id, step.level, {
              status: 'completed',
              completedAt: new Date().toISOString()
            });
            console.log(`[DCA Safety] Sell order ${step.sellOrderId} confirmed filled, marking completed`);
            
            // Record the trade
            const filledBuy = allOrders.find(o => o.side === 'BUY' && o.status === 'FILLED' && Math.abs(parseFloat(o.price) - (sellOrder.price / (1 + strategy.profitTarget / 100))) < 1);
            const buyPrice = filledBuy ? parseFloat(filledBuy.price) : 0;
            const profit = (sellOrder.price - buyPrice) * (sellOrder.origQty || sellOrder.quantity);
            
            tradingDb.addCompletedTrade({
              strategyId: strategy.id,
              symbol: strategy.symbol,
              buyPrice,
              sellPrice: sellOrder.price,
              quantity: sellOrder.origQty || sellOrder.quantity,
              profit,
              profitPercent: strategy.profitTarget,
              fees: 0
            });
            
            // Reset to available for reuse
            setTimeout(() => {
              tradingDb.updateGridStep(strategy.id, step.level, {
                status: 'available',
                orderId: null,
                buyOrderId: null,
                sellOrderId: null,
                filledAt: null,
                completedAt: null
              });
            }, 100);
          }
        }
      }
    } catch (e) {
      console.error(`[DCA Safety] Error checking strategy ${strategy.id}:`, e.message);
    }
  }
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
      // Check if autoEnd is enabled and cancel only BUY orders (let sells complete)
      if (strategy.autoEnd) {
        const gridSteps = strategy.gridSteps || [];
        const openBuys = gridSteps.filter(s => s.status === 'open_buy');
        const pendingSells = gridSteps.filter(s => s.status === 'pending_sell');
        
        // If autoEnd is on, cancel only BUY orders - let sells finish!
        if (openBuys.length > 0) {
          console.log(`[DCA Bot] Auto-end enabled for strategy ${strategy.id}, cancelling ${openBuys.length} buy orders (letting ${pendingSells.length} sells complete)`);
          
          // Cancel only open buys
          for (const step of openBuys) {
            if (step.orderId || step.buyOrderId) {
              const orderId = step.orderId || step.buyOrderId;
              // Verify cancellation on Binance before removing from local state
              const result = await trading.cancelOrderWithVerification(strategy.symbol, orderId);
              if (result.success) {
                tradingDb.updateGridStep(strategy.id, step.level, {
                  status: 'available',
                  orderId: null,
                  buyOrderId: null
                });
              } else {
                console.error(`[DCA Bot] Failed to cancel order ${orderId} on Binance:`, result.error);
              }
            }
          }
          
          console.log(`[DCA Bot] Cancelled buy orders for strategy ${strategy.id}, sells will complete`);
        }
        
        // Now check if there are no more pending trades
        if (openBuys.length === 0 && pendingSells.length === 0) {
          tradingDb.updateStrategy(strategy.id, { status: 'completed' });
          console.log(`[DCA Bot] Strategy ${strategy.id} marked as completed (auto-end)`);
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
  let allOrders = await trading.getAllOrders(symbol);
  console.log(`[DCA Bot] getAllOrders returned:`, typeof allOrders, Array.isArray(allOrders) ? 'IS array' : 'not array');
  
  // Force convert to real array
  if (!Array.isArray(allOrders)) {
    allOrders = Array.from(allOrders);
    console.log(`[DCA Bot] Forced convert to array, length:`, allOrders.length);
  }
  
  const buyOrders = allOrders.filter(o => o.side === 'BUY');
  const sellOrders = allOrders.filter(o => o.side === 'SELL');
  const openOrders = allOrders.filter(o => o.status === 'NEW');
  
  // Debug: log order statuses
  const filledCount = allOrders.filter(o => o.status === 'FILLED').length;
  console.log(`[DCA Bot] Orders: ${openOrders.length} NEW, ${filledCount} FILLED (total: ${allOrders.length})`);
  
  // 1. Check for filled orders and handle them
  await processFills(strategy, buyOrders, sellOrders);
  
  // 2. Re-fetch strategy to get updated budget after fills
  const updatedStrategy = tradingDb.getStrategy(strategy.id);
  
  // Skip placing new buy orders if autoEnd is enabled - let existing sells complete
  if (updatedStrategy.autoEnd) {
    console.log(`[DCA Bot] Auto-end enabled for strategy ${strategy.id}, skipping new buy orders`);
    broadcastStrategyUpdate(strategy);
    return;
  }
  
  // 3. Re-fetch open orders after processing fills
  const currentOrders = await trading.getAllOrders(symbol);
  
  // For reverse mode (sell_buy), check for open SELL orders; for normal mode, check for BUY orders
  const isReverse = (strategy.strategyType || 'buy_sell') === 'sell_buy';
  const targetSide = isReverse ? 'SELL' : 'BUY';
  const openTargetOrders = currentOrders.filter(o => o.side === targetSide && o.status === 'NEW');
  
  // Place more orders if we have fewer than grid levels
  if (openTargetOrders.length < updatedStrategy.gridLevels) {
    await placeBuyOrders(updatedStrategy, currentPrice, openTargetOrders);
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
  const isReverse = (strategy.strategyType || 'buy_sell') === 'sell_buy';
  
  if (isReverse) {
    // REVERSE MODE: Sell first, then buy back (take profit in cash)
    // Check for filled SELL orders -> create BUY (take profit)
    for (const order of sellOrders) {
      if (order.status === 'FILLED' && !order.processed) {
        if (!order.quantity || !order.price) {
          console.log(`[DCA Bot] Skipping corrupted order`);
          order.processed = true;
          continue;
        }
        
        const freshStrategy = tradingDb.getStrategy(strategy.id);
        
        // Track cash from sell - this is what we'll use to buy back
        // and keep the difference as profit
        const sellProceeds = order.price * order.quantity;
        
        // Update strategy with sell proceeds (cash available to buy back)
        const currentCash = freshStrategy.usableBudget || 0;
        const newCash = currentCash + sellProceeds;
        tradingDb.updateStrategy(strategy.id, { usableBudget: newCash });
        
        // Buy at LOWER price - but only enough to get back original quantity
        // The profit stays as cash
        const originalQty = order.quantity;
        const buyPrice = order.price * (1 - freshStrategy.profitTarget / 100);
        const costToBuyBack = buyPrice * originalQty;
        
        const mockOrder = trading.placeOrder(
          strategy.symbol,
          'BUY',
          originalQty,
          buyPrice
        );
        
        // Calculate expected profit (will be realized when buy fills)
        const expectedProfit = sellProceeds - costToBuyBack;
        
        // Find and update the grid step
        const gridStep = freshStrategy.gridSteps?.find(s => s.sellOrderId === order.orderId);
        if (gridStep) {
          tradingDb.updateGridStep(strategy.id, gridStep.level, {
            status: 'pending_buy',
            buyOrderId: mockOrder.orderId,
            filledAt: new Date().toISOString(),
            sellProceeds: sellProceeds,
            expectedProfit: expectedProfit
          });
        }
        
        order.processed = true;
        trading.saveState();
        console.log(`[DCA Bot] Reverse: Sell filled @ ${order.price} ($${sellProceeds.toFixed(2)}), cash: $${newCash.toFixed(2)}, placing buy @ $${buyPrice.toFixed(2)}`);
        broadcastOrder(mockOrder);
      }
    }
    
    // Check for filled BUY orders (in reverse mode this completes the cycle)
    for (const order of buyOrders) {
      if (order.status === 'FILLED' && !order.processed) {
        const freshStrategy = tradingDb.getStrategy(strategy.id);
        
        // Get the sell proceeds from the grid step
        const gridStep = freshStrategy.gridSteps?.find(s => s.buyOrderId === order.orderId);
        const sellProceeds = gridStep?.sellProceeds || (order.price * order.quantity * (1 + freshStrategy.profitTarget / 100));
        const costToBuyBack = order.price * order.quantity;
        
        // Profit = what we sold at - what we bought back at
        const profit = sellProceeds - costToBuyBack;
        
        // Deduct the buy cost from usable budget (cash spent)
        const currentCash = freshStrategy.usableBudget || 0;
        const newCash = currentCash - costToBuyBack;
        tradingDb.updateStrategy(strategy.id, { usableBudget: Math.max(0, newCash) });
        
        console.log(`[DCA Bot] Reverse: Buy filled @ ${order.price} ($${costToBuyBack.toFixed(2)}), profit: $${profit.toFixed(2)} (cash), remaining cash: $${newCash.toFixed(2)}`);
        
        // Find and mark grid step as completed
        if (gridStep) {
          tradingDb.updateGridStep(strategy.id, gridStep.level, {
            status: 'completed',
            completedAt: new Date().toISOString()
          });
          
          // Record the trade
          tradingDb.addCompletedTrade({
            strategyId: strategy.id,
            symbol: strategy.symbol,
            buyPrice: order.price,
            sellPrice: sellProceeds / order.quantity,
            quantity: order.quantity,
            profit: profit,
            profitPercent: freshStrategy.profitTarget,
            fees: 0
          });
          
          // Reset to available so it can be reused (place new sell order)
          setTimeout(() => {
            tradingDb.updateGridStep(strategy.id, gridStep.level, {
              status: 'available_sell',
              orderId: null,
              sellOrderId: null,
              buyOrderId: null,
              filledAt: null,
              completedAt: null,
              sellProceeds: null,
              expectedProfit: null
            });
          }, 100);
        }
        
        order.processed = true;
        trading.saveState();
      }
    }
  } else {
    // NORMAL MODE: Buy first, then sell
    
  // Check for filled buy orders -> create sell
  for (const order of buyOrders) {
    if (order.status === 'FILLED' && !order.processed) {
      // Skip if order is missing quantity (corrupted data)
      if (!order.quantity || !order.price) {
        console.log(`[DCA Bot] Skipping corrupted order (missing quantity or price)`);
        order.processed = true;
        continue;
      }
      
      // Get fresh strategy data for profit target and budget
      const freshStrategy = tradingDb.getStrategy(strategy.id);
      
      const sellPrice = Math.round(order.price * (1 + freshStrategy.profitTarget / 100) * 100) / 100;
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
          orderId: mockOrder.orderId,
          sellOrderId: mockOrder.orderId,
          filledAt: new Date().toISOString()
        });
      } else {
        // Fallback: try to find by price if orderId not matched
        const level = Math.round((freshStrategy.startPrice - order.price) / freshStrategy.gridSpacing);
        tradingDb.updateGridStep(strategy.id, level, {
          status: 'pending_sell',
          orderId: mockOrder.orderId,
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
      let allOrders = await trading.getAllOrders(strategy.symbol);
      if (!Array.isArray(allOrders)) {
        allOrders = Array.from(allOrders);
      }
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
  } // End of normal mode else block
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
  const allOrders = await trading.getAllOrders(symbol);
  
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
  // A level is busy if it has an open buy/sell, or a filled buy awaiting sell, or a pending sell/buy
  // BUT: if status is "open_buy" or "open_sell" with no orderId, it means order was never actually placed - treat as available
  const busyLevels = new Set();
  for (const step of gridSteps) {
    if (step.status === 'open_buy') {
      // If there's no orderId, the order was never actually placed on Binance - treat as available
      if (step.orderId || step.buyOrderId) {
        busyLevels.add(step.level);
      }
      // else: not actually busy, will try to place order
    } else if (step.status === 'open_sell') {
      if (step.orderId || step.sellOrderId) {
        busyLevels.add(step.level);
      }
    } else if (step.status === 'filled_buy' || step.status === 'pending_sell' || step.status === 'pending_buy') {
      busyLevels.add(step.level);
    }
  }
  
  // Place orders at grid levels (startPrice, startPrice - spacing, startPrice - 2*spacing, etc.)
  // But skip any levels that are busy
  const ordersToPlace = [];
  const strategyType = strategy.strategyType || 'buy_sell';
  const isReverse = strategyType === 'sell_buy';
  
  // For sell_buy mode, grid goes UP from start price (sell high first)
  // For buy_sell mode, grid goes DOWN from start price (buy low first)
  for (let level = 0; level < levels; level++) {
    // Skip busy levels
    if (busyLevels.has(level)) {
      continue;
    }
    
    // Calculate price based on strategy type
    const targetPrice = isReverse 
      ? startPrice + (level * spacing)  // sell_buy: prices go UP
      : startPrice - (level * spacing); // buy_sell: prices go DOWN
    
    // Only place if price is reasonable
    if (isReverse) {
      // For reverse: sell high, so only if price is above current
      if (targetPrice <= currentPrice * 1.5) {
        ordersToPlace.push({ level, price: targetPrice });
      }
    } else {
      // For normal: buy low, so only if price is not too far below
      if (targetPrice >= currentPrice * 0.5) {
        ordersToPlace.push({ level, price: targetPrice });
      }
    }
    
    // Stop if we've placed enough
    if (ordersToPlace.length >= maxOrders) {
      break;
    }
  }
  
  // Place orders ONE AT A TIME and verify each one before placing next
  // This prevents duplicate orders if something goes wrong
  for (const { level, price } of ordersToPlace) {
    // First, verify this level doesn't already have an open order on Binance
    const currentOpenOrders = await trading.getAllOrders(symbol);
    const orderSide = isReverse ? 'SELL' : 'BUY';
    const existingAtLevel = currentOpenOrders.filter(o => 
      o.side === orderSide && o.status === 'NEW' && Math.abs(parseFloat(o.price) - price) < 1
    );
    
    if (existingAtLevel.length > 0) {
      console.log(`[DCA Bot] Level ${level} already has ${orderSide} order on Binance (${existingAtLevel[0].orderId}), skipping`);
      // Sync with what's actually on Binance
      if (isReverse) {
        tradingDb.updateGridStep(strategy.id, level, {
          status: 'open_sell',
          orderId: existingAtLevel[0].orderId,
          sellOrderId: existingAtLevel[0].orderId
        });
      } else {
        tradingDb.updateGridStep(strategy.id, level, {
          status: 'open_buy',
          orderId: existingAtLevel[0].orderId,
          buyOrderId: existingAtLevel[0].orderId
        });
      }
      continue;
    }
    
    // Place the order - SELL for reverse, BUY for normal
    const order = await trading.placeOrder(symbol, orderSide, amount, price);
    console.log(`[DCA Bot] Placed ${orderSide} order: ${amount} ${symbol} @ $${price} (level ${level}), orderId: ${order.orderId}`);
    
    // CRITICAL: Verify order actually exists on Binance before continuing
    await new Promise(resolve => setTimeout(resolve, 500)); // Brief pause
    
    // Re-fetch to verify
    const verifyOrders = await trading.getAllOrders(symbol);
    const verified = verifyOrders.find(o => o.orderId === order.orderId);
    
    if (verified) {
      console.log(`[DCA Bot] ✓ Verified order ${order.orderId} on Binance`);
      if (isReverse) {
        tradingDb.updateGridStep(strategy.id, level, {
          status: 'open_sell',
          orderId: order.orderId,
          sellOrderId: order.orderId
        });
      } else {
        tradingDb.updateGridStep(strategy.id, level, {
          status: 'open_buy',
          orderId: order.orderId,
          buyOrderId: order.orderId
        });
      }
    } else {
      console.error(`[DCA Bot] ✗ Failed to verify order ${order.orderId} on Binance!`);
      // Mark as available so it can be retried on next tick
      continue;
    }
    
    broadcastOrder(order);
    
    // Wait between orders to avoid rate limiting and ensure proper tracking
    await new Promise(resolve => setTimeout(resolve, 300));
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

async function broadcastStrategyUpdate(strategy) {
  const stats = tradingDb.getStrategyStats(strategy.id);
  const openOrders = await trading.getOpenOrders(strategy.symbol);
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
    activeStrategies: tradingDb.getActiveStrategies().length
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