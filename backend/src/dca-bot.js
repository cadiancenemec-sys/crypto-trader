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
let wsClients = null; // Set of WebSocket clients from wss.clients
let sessionStartTime = Date.now();

// Track pending orders per strategy
const strategyOrders = new Map();

// GLOBAL: Track levels being placed across ALL operations (prevents race conditions between tick + safety check)
const placingLevels = new Set();

// Initialize bot
function init(clientsSet) {
  wsClients = clientsSet;
  console.log('[DCA Bot] Initialized');
}

// Start the bot
function start(intervalMs = 5000) {
  if (isRunning) return;
  
  // Clear completed trades on startup - only count profit from trades in THIS session
  const fs = require('fs');
  const path = require('path');
  const dataDir = path.join(__dirname, '../../data-prod');
  const tradesFile = path.join(dataDir, 'completed-trades.json');
  try {
    // DISABLED: Preserve historical trade data
    // if (fs.existsSync(tradesFile)) {
    //   fs.writeFileSync(tradesFile, '[]');
    //   // Also clear in-memory cache
    //   const db = require('./trading-db');
    //   if (db.clearCompletedTrades) {
    //     db.clearCompletedTrades();
    //   }
    //   console.log('[DCA Bot] Cleared completed trades for fresh session');
    // }
    console.log('[DCA Bot] Historical trades preserved (auto-clear disabled)');
  } catch (e) {
    console.log('[DCA Bot] Could not clear trades:', e.message);
  }
  
  // ===== STARTUP VALIDATION: Sync grid with Binance =====
  // This ensures our grid state matches reality on Binance
  // SMART LOGIC: Only cancel truly orphaned orders, preserve active trades
  (async () => {
    try {
      const strategies = tradingDb.getActiveStrategies();
      if (!strategies || strategies.length === 0) {
        console.log('[DCA Startup] No active strategies - skipping validation');
        return;
      }
      
      // Build master set of ALL order IDs across all strategies
      const allGridOrderIds = new Set();
      for (const strategy of strategies) {
        (strategy.gridSteps || [])
          .map(s => s.orderId || s.buyOrderId || s.sellOrderId)
          .filter(id => id)
          .forEach(id => allGridOrderIds.add(id.toString()));
      }
      
      console.log(`[DCA Startup] Master grid order IDs: ${allGridOrderIds.size}`);
      
      for (const strategy of strategies) {
        const symbol = strategy.symbol;
        if (!symbol) {
          console.log(`[DCA Startup] Skipping strategy ${strategy.id} - missing symbol`);
          continue;
        }
        try {
          const allOrders = await trading.getAllOrders(symbol);
          if (!Array.isArray(allOrders)) {
            console.log(`[DCA Startup] No orders for ${symbol}, continuing`);
            continue;
          }
          
          // Build map of actual Binance orders
          const binanceOrderMap = new Map();
          allOrders.forEach(o => binanceOrderMap.set(o.orderId.toString(), o));
          
          // Build set of this strategy's grid order IDs
          const gridOrderIds = new Set(
            (strategy.gridSteps || [])
              .map(s => s.orderId || s.buyOrderId || s.sellOrderId)
              .filter(id => id)
          );
          
          console.log(`[DCA Startup] Validating ${symbol} - Strategy grid: ${gridOrderIds.size}, Binance: ${binanceOrderMap.size}`);
          
          // 1. Cancel Binance orders that aren't in ANY strategy grid (truly orphaned)
          for (const [orderId, order] of binanceOrderMap) {
            if (order.status === 'NEW' && !allGridOrderIds.has(orderId)) {
              console.log(`[DCA Startup] Cancelling truly orphaned order ${orderId} (${order.side} @ ${order.price}) - not in any strategy`);
              try {
                await trading.cancelOrder(symbol, parseInt(orderId));
              } catch (e) {
                console.log(`[DCA Startup] Failed to cancel ${orderId}:`, e.message);
              }
            }
          }
          
          // 2. SYNC: Match Binance orders to grid levels by price (for fresh strategies with empty grid)
          const gridSteps = strategy.gridSteps || [];
          const placedOrders = new Set(); // Track which grid levels we've synced
          
          // Group Binance orders by price to detect duplicates
          const ordersByPrice = new Map();
          for (const [orderId, binanceOrder] of binanceOrderMap) {
            if (binanceOrder.status !== 'NEW') continue;
            const price = parseFloat(binanceOrder.price);
            if (!ordersByPrice.has(price)) {
              ordersByPrice.set(price, []);
            }
            ordersByPrice.get(price).push({ orderId, order: binanceOrder });
          }
          
          // Check for duplicate orders at same price level
          for (const [price, orders] of ordersByPrice) {
            if (orders.length > 1) {
              console.log(`[DCA Startup] ⚠️  Found ${orders.length} orders at $${price} - will cancel duplicates`);
            }
          }
          
          for (const [orderId, binanceOrder] of binanceOrderMap) {
            if (binanceOrder.status !== 'NEW') continue;
            
            // Find matching grid level by price
            const price = parseFloat(binanceOrder.price);
            const matchingStep = gridSteps.find(s => Math.abs(s.price - price) < 0.5);
            
            if (matchingStep && !placedOrders.has(matchingStep.level)) {
              // Check if this order ID matches the grid's tracked ID
              const gridOrderId = matchingStep.orderId || matchingStep.buyOrderId || matchingStep.sellOrderId;
              const isTrackedOrder = (gridOrderId && gridOrderId.toString() === orderId);
              
              if (isTrackedOrder) {
                console.log(`[DCA Startup] Syncing L${matchingStep.level} @ $${price} to tracked Binance order ${orderId} (${binanceOrder.side})`);
                if (binanceOrder.side === 'BUY') {
                  tradingDb.updateGridStep(strategy.id, matchingStep.level, {
                    status: 'open_buy',
                    orderId: parseInt(orderId),
                    buyOrderId: parseInt(orderId),
                    sellOrderId: null
                  });
                } else {
                  tradingDb.updateGridStep(strategy.id, matchingStep.level, {
                    status: 'pending_sell',
                    orderId: parseInt(orderId),
                    buyOrderId: null,
                    sellOrderId: parseInt(orderId)
                  });
                }
                placedOrders.add(matchingStep.level);
              } else {
                // This is a duplicate - grid tracks a different order ID at this level
                console.log(`[DCA Startup] Cancelling duplicate order ${orderId} @ $${price} (grid tracks ${gridOrderId})`);
                try {
                  await trading.cancelOrder(symbol, parseInt(orderId));
                } catch (e) {
                  console.log(`[DCA Startup] Failed to cancel duplicate ${orderId}:`, e.message);
                }
              }
            } else if (!matchingStep) {
              // Order doesn't match any grid level - might be orphaned
              if (!allGridOrderIds.has(orderId)) {
                console.log(`[DCA Startup] Cancelling orphaned order ${orderId} @ $${price} - no matching grid level`);
                try {
                  await trading.cancelOrder(symbol, parseInt(orderId));
                } catch (e) {
                  console.log(`[DCA Startup] Failed to cancel ${orderId}:`, e.message);
                }
              }
            }
          }
          
          // 3. Update grid steps based on actual Binance order status (existing logic for orders with IDs)
          for (const step of strategy.gridSteps || []) {
            const orderId = step.orderId || step.buyOrderId || step.sellOrderId;
            if (!orderId) continue;
            
            const binanceOrder = binanceOrderMap.get(orderId.toString());
            
            // Order exists on Binance - sync status (don't reset!)
            if (binanceOrder) {
              // Check if order was placed BEFORE strategy was created (truly stale)
              const orderTime = parseInt(orderId); // Binance order IDs are timestamp-based
              const strategyTime = new Date(strategy.createdAt).getTime();
              
              // Only cancel if order is from a previous session (order time < strategy creation time)
              if (orderTime < strategyTime) {
                console.log(`[DCA Startup] Grid step L${step.level} order ${orderId} is STALE (from before strategy creation) - cancelling on Binance and resetting`);
                // Cancel the stale order on Binance
                try {
                  await trading.cancelOrder(symbol, parseInt(orderId));
                  console.log(`[DCA Startup] ✓ Cancelled stale order ${orderId} on Binance`);
                } catch (e) {
                  console.log(`[DCA Startup] ✗ Failed to cancel ${orderId}:`, e.message);
                }
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
              
              if (binanceOrder.status === 'FILLED' && step.status !== 'completed') {
                console.log(`[DCA Startup] Grid step L${step.level} order ${orderId} filled - safety check will record trade`);
                // Don't reset - let safety check handle trade recording
              } else if ((binanceOrder.status === 'CANCELED' || binanceOrder.status === 'EXPIRED') && step.status !== 'available') {
                console.log(`[DCA Startup] Grid step L${step.level} order ${orderId} cancelled on Binance - resetting`);
                tradingDb.updateGridStep(strategy.id, step.level, {
                  status: 'available',
                  orderId: null,
                  buyOrderId: null,
                  sellOrderId: null
                });
              } else if (binanceOrder.status === 'NEW' && step.status === 'available') {
                console.log(`[DCA Startup] Grid step L${step.level} order ${orderId} active on Binance - restoring status`);
                // Restore the correct status based on order side
                tradingDb.updateGridStep(strategy.id, step.level, {
                  status: binanceOrder.side === 'BUY' ? 'open_buy' : 'pending_sell'
                });
              }
            }
            
            // Order doesn't exist on Binance AND wasn't in master set - was truly orphaned
            if (!binanceOrder && !allGridOrderIds.has(orderId.toString())) {
              console.log(`[DCA Startup] Grid step L${step.level} had orphaned order ${orderId} - resetting`);
              tradingDb.updateGridStep(strategy.id, step.level, {
                status: 'available',
                orderId: null,
                buyOrderId: null,
                sellOrderId: null
              });
            }
          }
          
          // 3. Don't auto-complete strategies with active orders
          if (strategy.status === 'completed' && gridOrderIds.size > 0) {
            console.log(`[DCA Startup] Strategy ${strategy.id} marked completed but has ${gridOrderIds.size} orders - reactivating`);
            tradingDb.updateStrategy(strategy.id, { status: 'active' });
          }
        } catch (strategyErr) {
          console.error(`[DCA Startup] Error processing strategy ${strategy.id}:`, strategyErr.message);
          // Continue with next strategy
        }
      }
      
      console.log('[DCA Startup] ✅ Grid validation complete - synced with Binance (smart logic)');
    } catch (e) {
      console.error('[DCA Startup] Error validating grid:', e.message);
      console.log('[DCA Startup] Continuing without validation - will sync on first tick');
    }
  })();
  
  isRunning = true;
  tickInterval = setInterval(() => {
    try {
      tick();
    } catch (e) {
      console.error('[DCA Bot] Tick error:', e.message);
    }
  }, intervalMs);
  console.log(`[DCA Bot] Started (tick every ${intervalMs}ms)`);
  
  // Start safety check interval - scans every 10 seconds for missing orders
  setInterval(() => {
    try {
      checkMissingOrders();
    } catch (e) {
      console.error('[DCA Safety] Check error:', e.message);
    }
  }, 10000);
  console.log('[DCA Bot] Safety check started (every 10s)');
}

// Safety check: verify all filled buys have their sell orders placed on Binance
async function checkMissingOrders() {
  if (!isRunning) {
    console.log('[DCA Safety] Bot not running, skipping check');
    return;
  }
  console.log('[DCA Safety] Running safety check...');
  
  const strategies = tradingDb.getActiveStrategies();
  console.log(`[DCA Safety] Found ${strategies?.length || 0} active strategies`);
  
  for (const strategy of strategies) {
    try {
      console.log(`[DCA Safety] Processing strategy ${strategy.id} (${strategy.symbol})`);
      const gridSteps = strategy.gridSteps || [];
      const symbol = strategy.symbol;
      
      // Get all orders from Binance
      const allOrders = await trading.getAllOrders(symbol);
      console.log(`[DCA Safety] Got ${allOrders?.length || 0} orders for ${symbol}`);
      if (!Array.isArray(allOrders) || allOrders.length === 0) {
        console.log('[DCA Safety] No orders, skipping sync');
        continue;
      }
      
      // SYNC PASS: Match Binance orders to grid levels by price (for fresh strategies)
      console.log(`[DCA Safety] Checking ${allOrders.length} Binance orders against ${gridSteps.length} grid steps`);
      const syncedLevels = new Set();
      for (const binanceOrder of allOrders) {
        if (binanceOrder.status !== 'NEW') continue;
        const price = parseFloat(binanceOrder.price);
        const matchingStep = gridSteps.find(s => Math.abs(s.price - price) < 0.5 && !syncedLevels.has(s.level));
        if (matchingStep) {
          console.log(`[DCA Safety] Syncing L${matchingStep.level} @ $${price} to Binance order ${binanceOrder.orderId} (${binanceOrder.side})`);
          if (binanceOrder.side === 'BUY') {
            tradingDb.updateGridStep(strategy.id, matchingStep.level, {
              status: 'open_buy',
              orderId: parseInt(binanceOrder.orderId),
              buyOrderId: parseInt(binanceOrder.orderId),
              sellOrderId: null
            });
          } else {
            tradingDb.updateGridStep(strategy.id, matchingStep.level, {
              status: 'pending_sell',
              orderId: parseInt(binanceOrder.orderId),
              buyOrderId: null,
              sellOrderId: parseInt(binanceOrder.orderId)
            });
          }
          syncedLevels.add(matchingStep.level);
        } else {
          console.log(`[DCA Safety] No match for order ${binanceOrder.orderId} @ $${price}`);
        }
      }
      console.log(`[DCA Safety] Synced ${syncedLevels.size} levels`);
      
      // Check each grid step
      for (const step of gridSteps) {
        // Check for stale open_buy orders that don't exist on Binance anymore
        if (step.status === 'open_buy') {
          const buyOrderId = step.orderId || step.buyOrderId;
          if (buyOrderId) {
            const binanceOrder = allOrders.find(o => o.orderId == buyOrderId);
            if (!binanceOrder) {
              // Order doesn't exist on Binance anymore - reset this grid slot
              console.log(`[DCA Safety] Open buy order ${buyOrderId} not found on Binance, resetting grid step ${step.level}`);
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
          }
        }
        
        // Look for steps that are filled (buy completed) but missing sell order
        if (step.status === 'filled' || (step.status === 'open_buy' && step.filledAt && !step.sellOrderId)) {
          // Check if we have a real orderId for the buy
          const buyOrderId = step.orderId || step.buyOrderId;
          
          // Handle case where buy filled long ago and orderId is lost - use grid price to place sell
          if (!buyOrderId && step.status === 'filled' && step.filledAt) {
            console.log(`[DCA Safety] Filled step ${step.level} has no buyOrderId - placing sell based on grid price...`);
            const sellPrice = Math.round(step.price * (1 + strategy.profitTarget / 100) * 100) / 100;
            try {
              const mockOrder = await trading.placeOrder(
                symbol,
                'SELL',
                strategy.tradeAmount,
                sellPrice
              );
              tradingDb.updateGridStep(strategy.id, step.level, {
                status: 'pending_sell',
                orderId: mockOrder.orderId,
                sellOrderId: mockOrder.orderId
              });
              console.log(`[DCA Safety] ✓ Placed sell order ${mockOrder.orderId} @ ${sellPrice}`);
            } catch (e) {
              console.error(`[DCA Safety] Failed to place sell:`, e.message);
            }
            continue;
          }
          
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
                buyOrderId: buyOrderId,  // Preserve buy order ID
                sellOrderId: mockOrder.orderId,
                fillPrice: binanceOrder.price,  // Save the actual buy fill price
                filledAt: new Date().toISOString()
              });
              console.log(`[DCA Safety] ✓ Created missing sell order ${mockOrder.orderId} @ ${sellPrice} (buy filled @ ${binanceOrder.price})`);
            } else {
              console.error(`[DCA Safety] ✗ Failed to verify sell order on Binance`);
            }
          }
        }
        
        // Check if pending_sell orders still exist on Binance (or were cancelled)
        if (step.status === 'pending_sell') {
          // If sellOrderId is missing, the sell was never placed - reset and let it be placed now
          if (!step.sellOrderId && step.filledAt) {
            console.log(`[DCA Safety] Pending sell at level ${step.level} has no orderId - was never placed! Resetting to place sell now...`);
            tradingDb.updateGridStep(strategy.id, step.level, {
              status: 'filled',  // Reset to filled so the buy fill logic will place the sell
              orderId: null,
              buyOrderId: null,
              sellOrderId: null,
              filledAt: step.filledAt,  // Keep filledAt
              completedAt: null
            });
            continue;
          }
          
          const sellOrder = allOrders.find(o => o.orderId == step.sellOrderId && o.status === 'NEW');
          console.log(`[DCA Safety] L${step.level}: ${step.status}, sellOrderId=${step.sellOrderId}, found=${!!sellOrder}`);
          
          // If the sell order doesn't exist on Binance - it was either cancelled OR FILLED
          if (!sellOrder && step.sellOrderId) {
            // CRITICAL CHECK: Only record trade if this order was placed AFTER strategy creation
            // Prevents recording old Binance orders as trades for new strategies
            const orderAge = Date.now() - parseInt(step.sellOrderId); // orderId contains timestamp
            const strategyAge = Date.now() - new Date(strategy.createdAt).getTime();
            
            // If order is much older than strategy, it's a stale order - don't record as trade
            if (orderAge > strategyAge + 60000) { // Order is >60s older than strategy
              console.log(`[DCA Safety] Sell order ${step.sellOrderId} is stale (older than strategy) - NOT recording trade`);
              // Just reset the grid step without recording trade
              tradingDb.updateGridStep(strategy.id, step.level, {
                status: 'available',
                orderId: null,
                buyOrderId: null,
                sellOrderId: null,
                filledAt: null,
                completedAt: null,
                fillPrice: null
              });
              continue;
            }
            
            // Check if it might have filled (order disappeared from open orders)
            // We know it's filled if we have a buyOrderId and the sell was at profit target
            if (step.buyOrderId) {
              // Order disappeared = likely FILLED! Record the trade.
              console.log(`[DCA Safety] Sell order ${step.sellOrderId} not found - assuming FILLED! Recording trade...`);
              
              // Get the buy price from grid step (fillPrice should be saved when buy filled)
              const buyPrice = step.fillPrice || (step.price / (1 + strategy.profitTarget / 100));
              const profit = (step.price - buyPrice) * strategy.tradeAmount;
              
              tradingDb.addCompletedTrade({
                strategyId: strategy.id,
                symbol: strategy.symbol,
                buyPrice,
                sellPrice: step.price,
                quantity: strategy.tradeAmount,
                profit,
                profitPercent: strategy.profitTarget,
                fees: 0
              });
              
              // Reset to available for next cycle
              tradingDb.updateGridStep(strategy.id, step.level, {
                status: 'available',
                orderId: null,
                buyOrderId: null,
                sellOrderId: null,
                filledAt: null,
                completedAt: null,
                fillPrice: null
              });
              
              console.log(`[DCA Safety] ✓ Trade recorded: $${profit.toFixed(4)} profit`);
            } else {
              // No buyOrderId - order was cancelled, not filled. Reset without recording trade.
              console.log(`[DCA Safety] Sell order ${step.sellOrderId} cancelled (no buy tracking). Resetting...`);
              tradingDb.updateGridStep(strategy.id, step.level, {
                status: 'available',
                orderId: null,
                buyOrderId: null,
                sellOrderId: null
              });
            }
            continue;
          }
          
          // If sell is filled (rare case where we catch it before it disappears), record trade
          if (sellOrder.status === 'FILLED') {
            // Sell completed - reset to available so a new buy can be placed
            tradingDb.updateGridStep(strategy.id, step.level, {
              status: 'available',
              orderId: null,
              buyOrderId: null,
              sellOrderId: null,
              filledAt: null,
              completedAt: null
            });
            console.log(`[DCA Safety] Sell order ${step.sellOrderId} filled, reset to available for next cycle`);
            
            // Record the trade
            const buyPrice = step.fillPrice || (sellOrder.price / (1 + strategy.profitTarget / 100));
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
  
  // Mark already-processed orders from persistent storage
  for (const order of allOrders) {
    if (order.status === 'FILLED' && trading.isOrderProcessed(order.orderId)) {
      order.processed = true;
    }
  }
  
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
          trading.markOrderProcessed(order.orderId);
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
        trading.markOrderProcessed(order.orderId);
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
        trading.markOrderProcessed(order.orderId);
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
        trading.markOrderProcessed(order.orderId);
        continue;
      }
      
      // Get fresh strategy data for profit target and budget
      const freshStrategy = tradingDb.getStrategy(strategy.id);
      
      const sellPrice = Math.round(order.price * (1 + freshStrategy.profitTarget / 100) * 100) / 100;
      const orderCost = order.price * order.quantity;
      
      // Deduct from usable budget (money is now in the position)
      const newUsableBudget = (freshStrategy.usableBudget || freshStrategy.totalBudget) - orderCost;
      tradingDb.updateStrategy(strategy.id, { usableBudget: Math.max(0, newUsableBudget) });
      
      try {
        const mockOrder = await trading.placeOrder(
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
            buyOrderId: order.orderId,  // Preserve buy order ID
            sellOrderId: mockOrder.orderId,
            fillPrice: order.price,  // Save the actual buy fill price
            filledAt: new Date().toISOString()
          });
        } else {
          // Fallback: try to find by price if orderId not matched
          const level = Math.round((freshStrategy.startPrice - order.price) / freshStrategy.gridSpacing);
          tradingDb.updateGridStep(strategy.id, level, {
            status: 'pending_sell',
            orderId: mockOrder.orderId,
            buyOrderId: order.orderId,  // Preserve buy order ID
            sellOrderId: mockOrder.orderId,
            fillPrice: order.price,  // Save the actual buy fill price
            filledAt: new Date().toISOString()
          });
        }
        
        // Mark as processed so we don't create duplicate sells
        order.processed = true;
        trading.markOrderProcessed(order.orderId);
        trading.saveState();
        console.log(`[DCA Bot] Buy filled @ ${order.price} ($${orderCost.toFixed(2)}), usable budget now $${Math.max(0, newUsableBudget).toFixed(2)}`);
        broadcastOrder(mockOrder);
      } catch (e) {
        console.error(`[DCA Bot] Failed to place SELL order after buy filled:`, e.message);
      }
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
      trading.markOrderProcessed(order.orderId);
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
  
  // Calculate committed funds based on GRID status
  const activeGridSteps = strategy.gridSteps || [];
  
  // Open buy cost = grid slots with open buy orders (USD committed)
  const openBuyCost = activeGridSteps
    .filter(s => s.status === 'open_buy' && s.price)
    .reduce((sum, s) => sum + (s.price * amount), 0);
  
  // Filled buy cost = grid slots where buy filled but sell not placed yet (USD in crypto form)
  const filledBuyCost = activeGridSteps
    .filter(s => (s.status === 'filled' || (s.status === 'open_buy' && s.filledAt)) && s.price)
    .reduce((sum, s) => sum + (s.price * amount), 0);
  
  // Available cash = usable budget minus open buys minus filled buys
  // (filled buys = money tied up in crypto, can't use for new buys until sold)
  const availableCash = strategy.usableBudget - openBuyCost - filledBuyCost;
  
  // Calculate order cost (in quote currency, e.g., USD for ETHUSDT)
  const orderCost = amount * currentPrice;
  
  // Check if we have enough available cash to place at least one order
  if (availableCash < orderCost) {
    console.log(`[DCA Bot] Insufficient cash: $${availableCash.toFixed(2)} available ($${openBuyCost.toFixed(2)} open buys + $${filledBuyCost.toFixed(2)} in crypto), need $${orderCost.toFixed(2)} per order`);
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
  
  // Place orders ONE AT A TIME with multiple safeguards against duplicates
  for (const { level, price } of ordersToPlace) {
    // BLOCK: Skip if this level is already being placed (prevents duplicates)
    if (placingLevels.has(level)) {
      console.log(`[DCA Bot] Level ${level} is already being placed (global lock), skipping`);
      continue;
    }
    
    // SAFEGUARD 1: Check our grid - does this level already have an order ID?
    const gridStep = gridSteps.find(s => s.level === level);
    if (gridStep && (gridStep.orderId || gridStep.buyOrderId || gridStep.sellOrderId)) {
      console.log(`[DCA Bot] Level ${level} already tracked in grid (${gridStep.orderId || gridStep.buyOrderId}), skipping`);
      continue;
    }
    
    // SAFEGUARD 2: Verify this level doesn't already have an open order on Binance
    const currentOpenOrders = await trading.getAllOrders(symbol);
    const orderSide = isReverse ? 'SELL' : 'BUY';
    const existingAtPrice = currentOpenOrders.filter(o => 
      o.side === orderSide && o.status === 'NEW' && Math.abs(parseFloat(o.price) - price) < 0.5
    );
    
    if (existingAtPrice.length > 0) {
      console.log(`[DCA Bot] Level ${level} already has ${orderSide} order on Binance (${existingAtPrice[0].orderId} @ $${price}), skipping`);
      // Sync with what's actually on Binance
      if (isReverse) {
        tradingDb.updateGridStep(strategy.id, level, {
          status: 'open_sell',
          orderId: existingAtPrice[0].orderId,
          sellOrderId: existingAtPrice[0].orderId
        });
      } else {
        tradingDb.updateGridStep(strategy.id, level, {
          status: 'open_buy',
          orderId: existingAtPrice[0].orderId,
          buyOrderId: existingAtPrice[0].orderId
        });
      }
      continue;
    }
    
    // MARK: Level is now being placed (blocks concurrent attempts)
    placingLevels.add(level);
    console.log(`[DCA Bot] Locked level ${level} (global placingLevels)`);
    
    // Place the order - SELL for reverse, BUY for normal
    try {
      const order = await trading.placeOrder(symbol, orderSide, amount, price);
      console.log(`[DCA Bot] Placed ${orderSide} order: ${amount} ${symbol} @ $${price} (level ${level}), orderId: ${order.orderId}`);
      
      // VERIFY: Wait and check order exists on Binance
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const verifyOrders = await trading.getAllOrders(symbol);
      const verified = verifyOrders.find(o => o.orderId === order.orderId);
      
      if (verified) {
        console.log(`[DCA Bot] ✓ Verified order ${order.orderId} on Binance`);
        if (isReverse) {
          tradingDb.updateGridStep(strategy.id, level, {
            status: 'open_sell',
            orderId: order.orderId,
            buyOrderId: null,  // CLEAR old buy order ID
            sellOrderId: order.orderId
          });
        } else {
          tradingDb.updateGridStep(strategy.id, level, {
            status: 'open_buy',
            orderId: order.orderId,
            buyOrderId: order.orderId,
            sellOrderId: null  // CLEAR old sell order ID
          });
        }
      } else {
        console.error(`[DCA Bot] ✗ Failed to verify order ${order.orderId} on Binance!`);
        placingLevels.delete(level); // Unblock for retry
        continue;
      }
      
      broadcastOrder(order);
      
      // WAIT: Prevent race conditions (1 second between orders)
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // UNMARK: Level placement complete
      placingLevels.delete(level);
      console.log(`[DCA Bot] Unlocked level ${level}`);
    } catch (e) {
      console.error(`[DCA Bot] Failed to place order at level ${level}:`, e.message);
      placingLevels.delete(level); // Unblock for retry
      console.log(`[DCA Bot] Unlocked level ${level} (error path)`);
      // Don't crash - continue to next level
      continue;
    }
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
    console.log(`[DCA Bot] ⚠️ Emergency drop TRIGGERED but NOT IMPLEMENTED! Price: $${currentPrice}, Trigger: $${triggerPrice}`);
    console.log(`[DCA Bot] ⚠️ Emergency drop protection is not yet implemented. Manual intervention may be required.`);
    console.log(`[DCA Bot] Consider disabling emergencyDropEnabled in strategy settings until this feature is implemented.`);
  }
}

// Broadcast to WebSocket clients
function broadcastToAll(data) {
  if (!wsClients) return;
  
  const msg = JSON.stringify(data);
  // wsClients is a Set from wss.clients
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