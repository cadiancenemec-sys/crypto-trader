// Execute Special Trade - Standalone Function
async function executeSpecialTrade(ev) {
  const ethAmount = document.getElementById('specialEthAmount').value;
  const type = document.getElementById('takeProfitType').value;
  const btn = ev ? ev.target : document.querySelector('button[onclick*="executeSpecialTrade"]');
  const msgDiv = document.getElementById('specialTradeMessage');
  
  // Get order type and limit price
  const orderType = document.getElementById('specialOrderType').value;
  const limitPrice = orderType === 'limit' ? parseFloat(document.getElementById('specialLimitPrice').value) : null;
  
  // DEBUG: Show what was captured
  const debugInfo = `
    <div style="background: rgba(255, 165, 0, 0.2); border: 2px solid #ffa500; padding: 10px; margin: 10px 0; border-radius: 8px; font-family: monospace;">
      <strong style="color: #ffa500;">🔍 DEBUG INFO:</strong><br>
      ETH Amount Field: "${ethAmount}"<br>
      ETH Amount Parsed: ${parseFloat(ethAmount)}<br>
      Order Type: ${orderType}<br>
      Limit Price: ${limitPrice}<br>
      Limit Price Field Value: "${orderType === 'limit' ? document.getElementById('specialLimitPrice').value : 'N/A'}"
    </div>
  `;
  
  console.log('🚀 Execute clicked!', { ethAmount, type, orderType, limitPrice });
  
  if (!ethAmount || ethAmount <= 0) {
    if (msgDiv) msgDiv.innerHTML = '<div class="message error">❌ Please enter a valid ETH amount (not 0 or empty!)' + debugInfo + '</div>';
    else alert('Please enter a valid ETH amount');
    if (btn) btn.disabled = false;
    return;
  }
  
  // Validate limit price if limit order selected
  if (orderType === 'limit' && (!limitPrice || limitPrice <= 0)) {
    if (msgDiv) msgDiv.innerHTML = '<div class="message error">❌ Please enter a valid limit price' + debugInfo + '</div>';
    if (btn) btn.disabled = false;
    return;
  }
  
  // Price will come from buy response
  let currentPrice = 0;
  
  // Disable button
  if (btn) btn.disabled = true;
  
  // STEP 1: Execute the buy order
  console.log('⏳ Step 1/3: Buying ETH...');
  
  try {
    const buyRes = await fetch('/api/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        amountETH: parseFloat(ethAmount),
        orderType: orderType,
        limitPrice: limitPrice
      })
    });
    
    const buyData = await buyRes.json();
    console.log('Buy response:', buyData);
    
    if (!buyData.success) {
      throw new Error(buyData.error || 'Buy order failed');
    }
    
    // Get price from buy response
    currentPrice = parseFloat(buyData.data.price);
    console.log('Buy price:', currentPrice);
    
    // Calculate target price
    let targetPrice;
    if (type === 'percentage') {
      const percent = parseFloat(document.getElementById('takeProfitPercent').value);
      if (!percent || percent <= 0) {
        throw new Error('Please enter a valid percentage');
      }
      targetPrice = currentPrice * (1 + percent / 100);
      console.log('Target (percentage):', targetPrice);
    } else {
      // Dollars in profit mode
      const desiredProfit = parseFloat(document.getElementById('takeProfitPrice').value);
      if (!desiredProfit || desiredProfit <= 0) {
        throw new Error('Please enter a valid profit amount');
      }
      // Calculate target price: buyPrice + (desiredProfit / ethAmount)
      targetPrice = currentPrice + (desiredProfit / parseFloat(ethAmount));
      console.log('Desired Profit:', desiredProfit, '→ Target:', targetPrice);
    }
    
    if (msgDiv) {
      msgDiv.innerHTML = `
        <div class="message success">
          ✅ <strong>Step 1 Complete:</strong> Bought ${buyData.data.ethAmount} ETH @ $${buyData.data.price.toFixed(2)}<br>
          Total Cost: $${buyData.data.amountUSD} | Fee: $${buyData.data.fee}<br>
          ⏳ Waiting for blockchain confirmation...
        </div>
      `;
    }
    
    // STEP 2: For limit orders, save as pending and return immediately
    // For market orders, wait for fill then place take-profit
    if (orderType === 'limit') {
      // Save as pending limit order
      const pctGain = (((targetPrice - limitPrice) / limitPrice) * 100).toFixed(2);
      const pendingTrade = {
        type: 'pending_limit',
        asset: 'ETH',
        buyAmount: parseFloat(ethAmount),
        limitPrice: limitPrice,
        orderId: buyData.data.orderId,
        targetPrice: targetPrice,
        targetProfitPct: pctGain,
        targetProfitDollar: ((targetPrice - limitPrice) * ethAmount).toFixed(2),
        status: 'pending',
        placedTime: new Date().toISOString()
      };
      
      // Save to backend pending-orders.json
      try {
        const saveRes = await fetch('/api/save-pending-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId: buyData.data.orderId,
            ethAmount: ethAmount,
            limitPrice: limitPrice,
            targetPrice: targetPrice,
            targetProfitPct: pctGain,
            targetProfitDollar: pendingTrade.targetProfitDollar
          })
        });
        
        const saveData = await saveRes.json();
        if (saveData.success) {
          console.log('✅ Limit order saved to backend! Order ID:', saveData.orderId);
        } else {
          console.error('❌ Failed to save to backend:', saveData.error);
        }
      } catch (err) {
        console.error('❌ Error calling save-pending-order API:', err);
      }
      
      // Also save to localStorage for frontend display
      let pending = JSON.parse(localStorage.getItem('pendingLimitOrders') || '[]');
      pending.unshift(pendingTrade);
      localStorage.setItem('pendingLimitOrders', JSON.stringify(pending));
      
      console.log('✅ Limit order saved! Total pending:', pending.length);
      console.log('📋 Pending orders:', pending.map(p => `${p.buyAmount} ETH @ $${p.limitPrice}`));
      
      if (msgDiv) {
        msgDiv.innerHTML = `
          <div class="message success">
            ✅ <strong>Limit Order Placed!</strong><br>
            📊 Order: ${buyData.data.ethAmount} ETH @ $${limitPrice.toFixed(2)}<br>
            🎯 Take-profit will be placed at $${targetPrice.toFixed(2)} when order fills<br>
            ⏳ Status: Pending (waiting for price to reach $${limitPrice.toFixed(2)})<br>
            💰 Potential Profit: ${pctGain}% ($${pendingTrade.targetProfitDollar})<br>
            <br>
            📋 Added to "Pending Limit Orders" section<br>
            🚀 You can place more orders now!
          </div>
        `;
      }
      
      if (btn) {
        btn.innerHTML = '✅ Order Placed!';
        setTimeout(() => {
          btn.disabled = false;
          btn.innerHTML = '🚀 Execute Special Trade';
        }, 3000);
      }
      
      // Reload pending orders display
      console.log('🔄 Reloading pending orders display...');
      setTimeout(() => {
        if (typeof loadPendingOrders === 'function') {
          console.log('✅ Calling loadPendingOrders()');
          loadPendingOrders();
        } else {
          console.error('❌ loadPendingOrders function not found!');
        }
      }, 500);
      
      return; // Return immediately - don't wait for fill!
    }
    
    // For market orders: wait for fill
    console.log('⏳ Step 2/3: Waiting for market order to fill...');
    
    const sellRes = await fetch('/api/sell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amountETH: parseFloat(ethAmount),
        orderType: 'limit',
        limitPrice: targetPrice
      })
    });
    
    const sellData = await sellRes.json();
    
    if (sellData.success) {
      if (msgDiv) {
        msgDiv.innerHTML += `
          <div class="message success">
            ✅ <strong>Step 3 Complete:</strong> Take Profit Order Placed!<br>
            🎯 Will sell ALL ${ethAmount} ETH when price reaches $${targetPrice.toFixed(2)}<br>
            💰 Potential Profit: $${((targetPrice - currentPrice) * ethAmount).toFixed(2)}<br>
            <br>
            🎉 <strong>Special Trade Complete!</strong>
          </div>
        `;
      }
      
      // Save to localStorage
      const specialTrade = {
        type: 'special_trade',
        asset: 'ETH',
        buyAmount: parseFloat(ethAmount),
        buyPrice: buyData.data.price,
        buyFee: buyData.data.fee,
        buyTime: new Date().toISOString(),
        targetPrice: targetPrice,
        targetProfit: ((targetPrice - currentPrice) * ethAmount).toFixed(2),
        status: 'active',
        sellOrderId: sellData.data.orderId
      };
      
      let trades = JSON.parse(localStorage.getItem('specialTrades') || '[]');
      trades.unshift(specialTrade);
      localStorage.setItem('specialTrades', JSON.stringify(trades));
      
      console.log('✅ Trade saved! Total trades:', trades.length);
      
      // Also save to backup file via API
      try {
        await fetch('/api/backup-special-trades', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trades })
        });
        console.log('✅ Backup saved!');
      } catch (e) {
        console.log('⚠️ Backup skipped:', e.message);
      }
      
      // Force reload trades display
      console.log('🔄 Reloading trades display...');
      setTimeout(() => {
        if (typeof loadMyTrades === 'function') {
          loadMyTrades();
          console.log('✅ Display reloaded!');
        }
      }, 500);
      
      if (btn) {
        btn.innerHTML = '✅ Trade Complete!';
        setTimeout(() => {
          btn.disabled = false;
          btn.innerHTML = '🚀 Execute Special Trade';
        }, 3000);
      }
      
    } else {
      throw new Error(`Take profit order failed: ${sellData.error}`);
    }
    
  } catch (error) {
    console.error('Special trade error:', error);
    if (msgDiv) {
      msgDiv.innerHTML = `<div class="message error">❌ Error: ${error.message}</div>`;
    } else {
      alert('Error: ' + error.message);
    }
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '🚀 Execute Special Trade';
    }
  }
}

async function waitForOrderToFill(orderId, pollIntervalMs, maxAttempts) {
  console.log('Waiting for order to fill, orderId:', orderId, 'pollInterval:', pollIntervalMs, 'maxAttempts:', maxAttempts);
  
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    
    try {
      // Check order history for filled status
      const historyRes = await fetch('/api/order-history');
      const historyData = await historyRes.json();
      
      if (historyData.success && historyData.data) {
        const filledOrder = historyData.data.find(o => o.orderId == orderId);
        
        if (filledOrder) {
          console.log('Poll attempt', i+1, '- Order status:', filledOrder.status);
          
          if (filledOrder.status === 'FILLED') {
            console.log('✅ Order FILLED!');
            return true;
          }
          
          if (filledOrder.status === 'CANCELED' || filledOrder.status === 'REJECTED' || filledOrder.status === 'EXPIRED') {
            console.error('❌ Order was cancelled/rejected/expired');
            return false;
          }
          
          console.log('Order still pending, status:', filledOrder.status);
        }
      }
      
    } catch (error) {
      console.log('Polling error:', error.message);
    }
  }
  
  console.log('⏰ Timeout - order did not fill');
  return false;
}

async function waitForOrderConfirmation(orderId, maxAttempts = 30, isLimitOrder = false) {
  console.log('Waiting for confirmation, orderId:', orderId, 'isLimitOrder:', isLimitOrder);
  
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000)); // Poll every 1 second
    
    try {
      // Check open orders first
      const openRes = await fetch('/api/orders');
      const openData = await openRes.json();
      
      if (openData.success && openData.data) {
        const order = openData.data[orderId];
        
        if (order) {
          console.log('Poll attempt', i+1, '- Order status:', order.status);
          
          // For LIMIT orders: return true when order is placed (NEW status)
          if (isLimitOrder && (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED')) {
            console.log('✅ Limit order placed! Waiting for price to reach limit...');
            return true;
          }
          
          // For MARKET orders: wait for FILLED status
          if (!isLimitOrder && order.status === 'FILLED') {
            console.log('✅ Market order filled!');
            return true;
          }
          
          // Check if order was cancelled or rejected
          if (order.status === 'CANCELED' || order.status === 'REJECTED') {
            console.error('❌ Order was cancelled or rejected');
            return false;
          }
        }
      }
      
      // If not in open orders, check order history (might have filled instantly for market orders)
      if (!isLimitOrder) {
        const historyRes = await fetch('/api/order-history');
        const historyData = await historyRes.json();
        
        if (historyData.success && historyData.data) {
          const filledOrder = historyData.data.find(o => o.orderId == orderId);
          if (filledOrder && filledOrder.status === 'FILLED') {
            console.log('✅ Order confirmed in history!');
            return true;
          }
        }
      }
      
    } catch (error) {
      console.log('Polling error:', error.message);
    }
  }
  
  // Timeout - for limit orders, check one more time if order exists
  if (isLimitOrder) {
    try {
      const openRes = await fetch('/api/orders');
      const openData = await openRes.json();
      if (openData.success && openData.data && openData.data[orderId]) {
        console.log('✅ Limit order still active (waiting for price)');
        return true;
      }
    } catch (e) {}
  }
  
  return false;
}

// Pending Limit Orders Functions
async function loadPendingOrders() {
  const container = document.getElementById('pendingLimitOrders');
  if (!container) return;
  
  const pending = JSON.parse(localStorage.getItem('pendingLimitOrders') || '[]');
  
  if (pending.length === 0) {
    container.innerHTML = '<div style="color: #aaa; text-align: center; padding: 20px;">No pending limit orders</div>';
    return;
  }
  
  let html = '';
  pending.forEach((trade, idx) => {
    const pctGain = trade.targetProfitPct || (((trade.targetPrice - trade.limitPrice) / trade.limitPrice) * 100).toFixed(2);
    const dollarProfit = trade.targetProfitDollar || ((trade.targetPrice - trade.limitPrice) * trade.buyAmount).toFixed(2);
    html += `
      <div class="trade-card" style="background: rgba(255, 165, 0, 0.1); border-left: 3px solid #ffa500; padding: 15px; margin-bottom: 10px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <strong style="color: #ffa500;">⏳ Pending Order #${idx + 1}</strong><br>
            📊 ${trade.buyAmount} ETH @ $${trade.limitPrice.toFixed(2)}<br>
            🎯 Take-profit: $${trade.targetPrice.toFixed(2)}<br>
            💰 Potential Profit: ${pctGain}% ($${dollarProfit})<br>
            ⏳ Status: ${trade.status.toUpperCase()}
          </div>
          <button onclick="cancelPendingOrder(${idx})" style="background: rgba(255, 69, 58, 0.2); border: 1px solid #ff453a; color: #ff453a; padding: 8px 15px; border-radius: 8px; cursor: pointer;">
            ❌ Cancel
          </button>
        </div>
      </div>
    `;
  });
  
  container.innerHTML = html;
  
  // Check if any pending orders have filled
  checkPendingOrders();
}

async function checkPendingOrders() {
  const pending = JSON.parse(localStorage.getItem('pendingLimitOrders') || '[]');
  if (pending.length === 0) return;
  
  const stillPending = [];
  
  for (const trade of pending) {
    try {
      // Check order history for filled status
      const historyRes = await fetch('/api/order-history');
      const historyData = await historyRes.json();
      
      if (historyData.success && historyData.data) {
        const order = historyData.data.find(o => o.orderId == trade.orderId);
        
        if (order) {
          if (order.status === 'FILLED') {
            console.log('✅ Pending order filled! Placing take-profit...');
            // Place take-profit and move to active trades
            await placeTakeProfitForPending(trade, order);
          } else if (order.status === 'CANCELED' || order.status === 'REJECTED' || order.status === 'EXPIRED') {
            console.log('❌ Pending order cancelled/rejected - removing');
            // Don't add to stillPending - remove it
          } else {
            // Still pending
            stillPending.push(trade);
          }
        } else {
          // Order not found - keep it
          stillPending.push(trade);
        }
      }
    } catch (error) {
      console.log('Error checking pending order:', error.message);
      stillPending.push(trade);
    }
  }
  
  // Update localStorage
  localStorage.setItem('pendingLimitOrders', JSON.stringify(stillPending));
  
  // Reload display
  loadPendingOrders();
}

async function placeTakeProfitForPending(trade, filledOrder) {
  try {
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
      // Move to active trades
      const activeTrade = {
        type: 'special_trade',
        asset: 'ETH',
        buyAmount: trade.buyAmount,
        buyPrice: parseFloat(filledOrder.price || trade.limitPrice),
        buyFee: filledOrder.fee || 0,
        buyTime: new Date().toISOString(),
        targetPrice: trade.targetPrice,
        targetProfit: trade.targetProfit,
        status: 'active',
        sellOrderId: sellData.data.orderId
      };
      
      let trades = JSON.parse(localStorage.getItem('specialTrades') || '[]');
      trades.unshift(activeTrade);
      localStorage.setItem('specialTrades', JSON.stringify(trades));
      
      console.log('✅ Pending order converted to active trade!');
      
      // Reload active trades
      if (typeof loadMyTrades === 'function') {
        loadMyTrades();
      }
    }
  } catch (error) {
    console.error('Error placing take-profit for pending:', error.message);
  }
}

function cancelPendingOrder(idx) {
  const pending = JSON.parse(localStorage.getItem('pendingLimitOrders') || '[]');
  if (idx >= 0 && idx < pending.length) {
    const trade = pending[idx];
    // Could call API to cancel the order here
    pending.splice(idx, 1);
    localStorage.setItem('pendingLimitOrders', JSON.stringify(pending));
    loadPendingOrders();
    console.log('✅ Cancelled pending order');
  }
}

// Auto-check pending orders every 30 seconds
setInterval(() => {
  checkPendingOrders();
}, 30000);
