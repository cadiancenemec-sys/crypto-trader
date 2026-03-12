// Simple, standalone trade loader - COMPACT display with smooth updates
let lastTradesHash = '';
let isLoading = false;

async function loadMyTrades() {
  // Prevent concurrent loads
  if (isLoading) {
    console.log('Load already in progress, skipping...');
    return;
  }
  isLoading = true;
  
  const activeContainer = document.getElementById('activeSpecialTrades');
  const completedContainer = document.getElementById('completedSpecialTrades');
  
  if (!activeContainer) {
    console.error('activeSpecialTrades container not found!');
    isLoading = false;
    return;
  }
  
  if (activeContainer.innerHTML.includes('Loading...')) {
    // First load, show loading
  }
  
  try {
    // FIRST: Check if any pending limit orders have filled
    await checkAndConvertFilledPendingOrders();
    
    // Fetch backup trades
    const res = await fetch('/api/backup-special-trades');
    const data = await res.json();
    
    console.log('📥 RAW API RESPONSE:', {activeCount:data.data?.active?.length, ids:data.data?.active?.map(t=>t.sellOrderId)});
    
    console.log('📥 RAW API RESPONSE:', JSON.stringify(data));
    console.log('📥 data.data.active:', data.data?.active);
    console.log('📥 data.data.active length:', data.data?.active?.length);
    console.log('📥 data.data.active IDs:', data.data?.active?.map(t=>t.sellOrderId));
    
    // Handle new structure with active/completed arrays
    let trades = [];
    if (data.data && data.data.active) {
      trades = data.data.active.slice();
      console.log('✅ Using data.data.active, count:', trades.length);
    } else if (data.data && Array.isArray(data.data)) {
      trades = data.data.filter(t => t.status === 'active');
      console.log('✅ Using data.data filter, count:', trades.length);
    }
    
    console.log('After extraction - trades count:', trades.length, 'IDs:', trades.map(t=>t.sellOrderId));
    
    let completedTrades = [];
    if (data.data && data.data.completed) {
      completedTrades = data.data.completed;
    } else if (data.data && Array.isArray(data.data)) {
      completedTrades = data.data.filter(t => t.status === 'completed');
    }
    
    // Sort completed trades by completion date (newest first)
    completedTrades.sort((a, b) => {
      const aTime = a.completedAt || a.sellTime || a.fillTime || 0;
      const bTime = b.completedAt || b.sellTime || b.fillTime || 0;
      return new Date(bTime) - new Date(aTime);
    });
    console.log('📦 Completed trades sorted by date (newest first):', completedTrades.length);
    
    console.log('📦 Loaded trades:', trades.length, 'active,', completedTrades.length, 'completed');
    console.log('Active order IDs:', trades.map(t=>t.sellOrderId));
    
    if (!trades || trades.length === 0) {
      if (!lastTradesHash) {
        activeContainer.innerHTML = '<div class="loading">No active trades</div>';
      }
      isLoading = false;
      return;
    }
    
    // Fetch current orders to check status
    let currentOrders = {};
    let orderHistory = [];
    try {
      const ordersRes = await fetch('/api/orders');
      const ordersData = await ordersRes.json();
      if (ordersData.success && ordersData.data) {
        currentOrders = ordersData.data;
      }
      
      const historyRes = await fetch('/api/order-history');
      const historyData = await historyRes.json();
      if (historyData.success && historyData.data) {
        orderHistory = historyData.data;
      }
    } catch (e) {
      console.log('Error fetching orders:', e.message);
    }
    
    // Separate active and completed trades
    // Check order history to see if any sell orders have filled
    const updatedActiveTrades = [];
    const updatedCompletedTrades = [...completedTrades];
    
    trades.forEach(t => {
      // Check if sell order has filled
      const filledOrder = orderHistory.find(o => o.orderId == t.sellOrderId);
      
      if (filledOrder && filledOrder.status === 'FILLED') {
        // Trade is complete - move to completed
        updatedCompletedTrades.unshift({
          ...t,
          status: 'completed',
          fillTime: Date.now(),
          sellPrice: filledOrder.price,
          sellFee: filledOrder.fee || 0
        });
        console.log('✅ Trade completed! Order', t.sellOrderId, 'filled at', filledOrder.price);
      } else {
        // Still active
        updatedActiveTrades.push(t);
      }
    });
    
    // Deduplicate active trades by sellOrderId
    const seen = new Set();
    const dedupedActiveTrades = updatedActiveTrades.filter(t => {
      if (seen.has(t.sellOrderId)) return false;
      seen.add(t.sellOrderId);
      return true;
    });
    
    // If any trades completed, update the backup
    if (updatedCompletedTrades.length > completedTrades.length) {
      console.log('📦 Updating backup with', updatedCompletedTrades.length, 'completed trades');
      fetch('/api/backup-special-trades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          active: dedupedActiveTrades,
          completed: updatedCompletedTrades
        })
      }).catch(e => console.log('⚠️ Backup update skipped:', e.message));
    }
    
    console.log('Before render - Active count:', dedupedActiveTrades.length, 'IDs:', dedupedActiveTrades.map(t=>t.sellOrderId));
    console.log('Completed count:', updatedCompletedTrades.length);
    
    // Create a hash to detect changes
    const currentHash = `${dedupedActiveTrades.length}-${updatedCompletedTrades.length}`;
    
    // Only re-render if something changed
    if (currentHash === lastTradesHash && activeContainer.children.length > 0 && !activeContainer.innerHTML.includes('Loading')) {
      return;
    }
    
    lastTradesHash = currentHash;
    
    // Render active trades
    console.log('Before clear - container has', activeContainer.children.length, 'children');
    activeContainer.innerHTML = '';
    
    if (dedupedActiveTrades.length === 0) {
      activeContainer.innerHTML = '<div class="loading" style="color: #aaa;">No active trades</div>';
    } else {
      try {
        const html = renderTrades(dedupedActiveTrades, false);
        activeContainer.innerHTML = html;
        console.log('✅ Rendered', dedupedActiveTrades.length, 'active trades');
      } catch (e) {
        console.error('RENDER ERROR:', e.message);
        activeContainer.innerHTML = '<div class="error">Render error: ' + e.message + '</div>';
      }
    }
    
    // Render completed trades
    if (completedContainer) {
      completedContainer.innerHTML = '';
      if (updatedCompletedTrades.length === 0) {
        completedContainer.innerHTML = '<div class="loading" style="color: #aaa;">No completed trades yet</div>';
      } else {
        completedContainer.innerHTML = renderTrades(updatedCompletedTrades, true);
      }
    }
    
    console.log('✅ Rendered - Active:', activeTrades.length, 'Completed:', completedTrades.length);
    
    isLoading = false;
    
  } catch (e) {
    if (!lastTradesHash) {
      activeContainer.innerHTML = `<div class="error">Error: ${e.message}</div>`;
      if (completedContainer) completedContainer.innerHTML = `<div class="error">Error: ${e.message}</div>`;
    }
    console.error('ERROR:', e.message);
    isLoading = false;
  }
}

// Render trades HTML
function renderTrades(trades, isCompleted) {
  console.log('🎨 renderTrades called with', trades.length, 'items, IDs:', trades.map(t=>t.sellOrderId));
  let html = '';
  trades.forEach((t, i) => {
    console.log('  - Rendering item', i, 'ID:', t.sellOrderId);
    const totalCost = (t.buyAmount * t.buyPrice).toFixed(2);
    const buyFee = parseFloat(t.buyFee || 0);
    const potentialProfit = ((t.targetPrice - t.buyPrice) * t.buyAmount).toFixed(2);
    const roi = ((potentialProfit / parseFloat(totalCost)) * 100).toFixed(2);
    
    html += `
      <div style="background: rgba(${isCompleted ? '0, 255, 136' : '92, 39, 250'}, 0.1); border-left: 4px solid ${isCompleted ? '#00ff88' : '#5c27fa'}; border-radius: 6px; padding: 12px 15px; margin-bottom: 8px; font-size: 0.9em;">
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 15px; align-items: center;">
          <!-- Trade Info -->
          <div>
            <div style="font-weight: bold; color: ${isCompleted ? '#00ff88' : '#5c27fa'}; margin-bottom: 4px;">
              ${isCompleted ? '✅' : '🎯'} Trade #${trades.length - i}
            </div>
            <div style="color: #aaa; font-size: 0.85em;">${new Date(t.buyTime).toLocaleDateString()}</div>
            ${isCompleted ? '<div style="color: #00ff88; font-size: 0.75em; margin-top: 3px;">COMPLETED</div>' : ''}
          </div>
          
          <!-- BUY -->
          <div style="border-left: 1px solid rgba(255,255,255,0.1); padding-left: 15px;">
            <div style="color: #00ff88; font-weight: bold; margin-bottom: 3px;">🟢 BUY</div>
            <div style="color: #fff;">${t.buyAmount} ETH @ $${parseFloat(t.buyPrice).toFixed(2)}</div>
            <div style="color: #aaa; font-size: 0.85em;">Fee: $${buyFee.toFixed(4)}</div>
          </div>
          
          <!-- TAKE PROFIT -->
          <div style="border-left: 1px solid rgba(255,255,255,0.1); padding-left: 15px;">
            <div style="color: #ffa502; font-weight: bold; margin-bottom: 3px;">🎯 TARGET</div>
            <div style="color: #fff;">$${parseFloat(t.targetPrice).toFixed(2)}</div>
            <div style="color: #aaa; font-size: 0.85em;">${((t.targetPrice - t.buyPrice) / t.buyPrice * 100).toFixed(2)}% gain</div>
          </div>
          
          <!-- PROFIT -->
          <div style="border-left: 1px solid rgba(255,255,255,0.1); padding-left: 15px; text-align: right;">
            <div style="color: #00ff88; font-weight: bold; font-size: 1.1em;">$${potentialProfit}</div>
            <div style="color: #aaa; font-size: 0.85em;">ROI: ${roi}%</div>
            <div style="margin-top: 5px;">
              <span class="status-badge" style="background: ${isCompleted ? 'rgba(0, 255, 136, 0.2)' : 'rgba(255, 165, 2, 0.2)'}; color: ${isCompleted ? '#00ff88' : '#ffa502'}; font-size: 0.75em;">
                ${isCompleted ? '✅ FILLED' : '⏳ ACTIVE'}
              </span>
            </div>
          </div>
        </div>
      </div>
    `;
  });
  return html;
}

// Check if any pending limit orders have filled and convert them to active trades
async function checkAndConvertFilledPendingOrders() {
  try {
    // Fetch pending orders from backend
    const pendingRes = await fetch('/api/pending-orders');
    const pendingData = await pendingRes.json();
    
    if (!pendingData.success || !pendingData.data || pendingData.data.length === 0) {
      return; // No pending orders
    }
    
    const pending = pendingData.data;
    console.log('🔍 Checking', pending.length, 'pending orders for fills...');
    
    const historyRes = await fetch('/api/order-history');
    const historyData = await historyRes.json();
    
    if (!historyData.success || !historyData.data) return;
    
    const ordersToRemove = [];
    
    for (const trade of pending) {
      const filledOrder = historyData.data.find(o => o.orderId == trade.orderId);
      
      if (filledOrder && filledOrder.status === 'FILLED') {
        console.log('✅ Pending order', trade.orderId, 'filled! Placing take-profit...');
        
        // Place take-profit sell order
        const sellRes = await fetch('/api/sell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amountETH: trade.buyAmount,
            orderType: 'limit',
            limitPrice: trade.targetPrice
          })
        });
        
        const sellData = await sellRes.json();
        
        if (sellData.success) {
          // Create active trade
          const activeTrade = {
            type: 'special_trade',
            asset: 'ETH',
            buyAmount: trade.buyAmount,
            buyPrice: parseFloat(filledOrder.price || trade.limitPrice),
            buyFee: parseFloat(filledOrder.fee || 0),
            buyTime: new Date(parseInt(filledOrder.time)).toISOString(),
            targetPrice: trade.targetPrice,
            targetProfit: trade.targetProfitDollar,
            status: 'active',
            sellOrderId: sellData.data.orderId
          };
          
          // Fetch current backup, add this trade, save back
          const backupRes = await fetch('/api/backup-special-trades');
          const backupData = await backupRes.json();
          
          let active = [];
          let completed = [];
          if (backupData.success && backupData.data) {
            active = backupData.data.active || [];
            completed = backupData.data.completed || [];
          }
          
          active.unshift(activeTrade);
          
          await fetch('/api/backup-special-trades', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active, completed })
          });
          
          // Remove from pending orders
          ordersToRemove.push(trade.orderId);
          
          console.log('✅ Converted pending to active trade!');
        } else {
          console.error('❌ Failed to place take-profit:', sellData.error);
        }
      } else if (filledOrder && (filledOrder.status === 'CANCELED' || filledOrder.status === 'REJECTED')) {
        console.log('❌ Pending order', trade.orderId, 'was cancelled/rejected - removing');
        ordersToRemove.push(trade.orderId);
      }
    }
    
    // Remove converted/cancelled orders from pending
    for (const orderId of ordersToRemove) {
      await fetch(`/api/pending-orders/${orderId}`, { method: 'DELETE' });
    }
    
    console.log('📦 Pending orders updated:', ordersToRemove.length, 'removed');
    
  } catch (e) {
    console.error('Error checking pending orders:', e.message);
  }
}

// Auto-load immediately (no delay to prevent double-loading)
loadMyTrades();

// Refresh every 10 seconds to check for filled orders
setInterval(loadMyTrades, 10000);

// Also add a visible countdown timer
let countdown = 10;
const timerDiv = document.createElement('div');
timerDiv.id = 'refreshTimer';
timerDiv.style.cssText = 'position: fixed; bottom: 10px; right: 10px; background: rgba(92, 39, 250, 0.8); color: #fff; padding: 8px 12px; border-radius: 8px; font-size: 12px; font-family: monospace; z-index: 9999;';
document.body.appendChild(timerDiv);

function updateTimer() {
  countdown--;
  if (countdown <= 0) countdown = 10;
  timerDiv.textContent = `🔄 Next refresh: ${countdown}s`;
  if (countdown <= 3) timerDiv.style.background = 'rgba(255, 165, 0, 0.8)';
  else timerDiv.style.background = 'rgba(92, 39, 250, 0.8)';
}

setInterval(updateTimer, 1000);
