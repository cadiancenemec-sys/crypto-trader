// Simple, standalone trade loader - COMPACT display with smooth updates
let lastTradesHash = '';

async function loadMyTrades() {
  const activeContainer = document.getElementById('activeSpecialTrades');
  const completedContainer = document.getElementById('completedSpecialTrades');
  
  if (!activeContainer) {
    console.error('activeSpecialTrades container not found!');
    return;
  }
  
  if (activeContainer.innerHTML.includes('Loading...')) {
    // First load, show loading
  }
  
  try {
    // Fetch backup trades
    const res = await fetch('/api/backup-special-trades');
    const data = await res.json();
    
    if (!data.success || !data.data || data.data.length === 0) {
      if (!lastTradesHash) {
        activeContainer.innerHTML = '<div class="loading">No trades</div>';
        if (completedContainer) completedContainer.innerHTML = '<div class="loading">No completed trades</div>';
      }
      return;
    }
    
    const trades = data.data.filter(t => t.buyPrice && t.targetPrice);
    
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
    const activeTrades = [];
    const completedTrades = [];
    
    trades.forEach(t => {
      let sellStatus = 'ACTIVE';
      
      // Check current orders
      if (t.sellOrderId && currentOrders[t.sellOrderId]) {
        const sellOrder = currentOrders[t.sellOrderId];
        sellStatus = sellOrder.status;
      }
      
      // Also check order history
      if (sellStatus !== 'FILLED' && t.sellOrderId) {
        const filledOrder = orderHistory.find(o => o.orderId == t.sellOrderId);
        if (filledOrder && filledOrder.status === 'FILLED') {
          sellStatus = 'FILLED';
        }
      }
      
      if (sellStatus === 'FILLED') {
        completedTrades.push({ ...t, sellStatus });
      } else {
        activeTrades.push({ ...t, sellStatus });
      }
    });
    
    // Create a hash to detect changes
    const currentHash = `${activeTrades.length}-${completedTrades.length}`;
    
    // Only re-render if something changed
    if (currentHash === lastTradesHash && activeContainer.children.length > 0 && !activeContainer.innerHTML.includes('Loading')) {
      return; // No changes, skip re-render
    }
    
    lastTradesHash = currentHash;
    
    // Render active trades
    if (activeTrades.length === 0) {
      activeContainer.innerHTML = '<div class="loading" style="color: #aaa;">No active trades</div>';
    } else {
      const newHtml = renderTrades(activeTrades, false);
      if (activeContainer.innerHTML !== newHtml) {
        activeContainer.innerHTML = newHtml;
      }
    }
    
    // Render completed trades
    if (completedContainer) {
      if (completedTrades.length === 0) {
        const emptyHtml = '<div class="loading" style="color: #aaa;">No completed trades yet</div>';
        if (completedContainer.innerHTML !== emptyHtml) {
          completedContainer.innerHTML = emptyHtml;
        }
      } else {
        const newHtml = renderTrades(completedTrades, true);
        if (completedContainer.innerHTML !== newHtml) {
          completedContainer.innerHTML = newHtml;
        }
      }
    }
    
    console.log('Active:', activeTrades.length, 'Completed:', completedTrades.length);
    
  } catch (e) {
    if (!lastTradesHash) {
      activeContainer.innerHTML = `<div class="error">Error: ${e.message}</div>`;
      if (completedContainer) completedContainer.innerHTML = `<div class="error">Error: ${e.message}</div>`;
    }
    console.error('ERROR:', e.message);
  }
}

// Render trades HTML
function renderTrades(trades, isCompleted) {
  let html = '';
  trades.forEach((t, i) => {
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

// Auto-load after 2 seconds
setTimeout(loadMyTrades, 2000);

// Refresh every 10 seconds to check for filled orders
setInterval(loadMyTrades, 10000);
