// Don's Special Trades - One-Click Automated Trading

function calculateSpecialCost() {
  const ethAmount = parseFloat(document.getElementById('specialEthAmount').value);
  const costInput = document.getElementById('specialCostEstimate');
  const priceDisplay = document.getElementById('currentPriceDisplay');
  
  priceDisplay.textContent = currentPrice.toFixed(2);
  
  if (ethAmount && currentPrice > 0) {
    const cost = ethAmount * currentPrice;
    costInput.value = `$${cost.toFixed(2)}`;
  } else {
    costInput.value = '$0.00';
  }
}

function toggleTakeProfitInput() {
  const type = document.getElementById('takeProfitType').value;
  const percentGroup = document.getElementById('takeProfitPercentageGroup');
  const priceGroup = document.getElementById('takeProfitPriceGroup');
  
  if (type === 'percentage') {
    percentGroup.style.display = 'flex';
    priceGroup.style.display = 'none';
  } else {
    percentGroup.style.display = 'none';
    priceGroup.style.display = 'flex';
  }
}

async function executeSpecialTrade() {
  const ethAmount = document.getElementById('specialEthAmount').value;
  const type = document.getElementById('takeProfitType').value;
  const btn = document.querySelector('.btn-buy[onclick="executeSpecialTrade()"]');
  const msgDiv = document.getElementById('specialTradeMessage');
  
  if (!ethAmount || ethAmount <= 0) {
    msgDiv.innerHTML = '<div class="message error">Please enter a valid ETH amount</div>';
    return;
  }

  let targetPrice;
  if (type === 'percentage') {
    const percent = parseFloat(document.getElementById('takeProfitPercent').value);
    if (!percent || percent <= 0) {
      msgDiv.innerHTML = '<div class="message error">Please enter a valid percentage</div>';
      return;
    }
    targetPrice = currentPrice * (1 + percent / 100);
  } else {
    targetPrice = parseFloat(document.getElementById('takeProfitPrice').value);
    if (!targetPrice || targetPrice <= 0) {
      msgDiv.innerHTML = '<div class="message error">Please enter a valid target price</div>';
      return;
    }
  }

  btn.disabled = true;
  btn.innerHTML = '⏳ Step 1/3: Buying ETH...';

  try {
    // STEP 1: Execute the buy order
    const buyRes = await fetch(`${API_BASE}/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountETH: parseFloat(ethAmount) })
    });
    
    const buyData = await buyRes.json();
    
    if (!buyData.success) {
      throw new Error(buyData.error || 'Buy order failed');
    }

    btn.innerHTML = `⏳ Step 2/3: Purchase Complete - Waiting for Confirmation...`;
    
    msgDiv.innerHTML = `
      <div class="message success">
        ✅ <strong>Step 1 Complete:</strong> Bought ${buyData.data.ethAmount} ETH @ $${buyData.data.price.toFixed(2)}<br>
        Total Cost: $${buyData.data.amountUSD} | Fee: $${buyData.data.fee}<br>
        ⏳ Waiting for blockchain confirmation...
      </div>
    `;

    // STEP 2: Wait for order confirmation (poll until status is FILLED)
    const confirmed = await waitForOrderConfirmation(buyData.data.orderId);
    
    if (!confirmed) {
      throw new Error('Order confirmation timeout');
    }

    btn.innerHTML = `⏳ Step 3/3: Placing Take Profit Order...`;
    
    msgDiv.innerHTML += `
      <div class="message success">
        ✅ <strong>Step 2 Complete:</strong> Order confirmed on blockchain!<br>
        🎯 Setting take-profit at $${targetPrice.toFixed(2)}...
      </div>
    `;

    // STEP 3: Place the take-profit limit order for FULL amount
    const sellRes = await fetch(`${API_BASE}/sell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amountETH: parseFloat(ethAmount), // FULL amount - no partial sells
        orderType: 'limit',
        limitPrice: targetPrice
      })
    });
    
    const sellData = await sellRes.json();
    
    if (sellData.success) {
      msgDiv.innerHTML += `
        <div class="message success">
          ✅ <strong>Step 3 Complete:</strong> Take Profit Order Placed!<br>
          🎯 Will sell ALL ${ethAmount} ETH when price reaches $${targetPrice.toFixed(2)}<br>
          💰 Potential Profit: $${((targetPrice - currentPrice) * ethAmount).toFixed(2)}<br>
          <br>
          🎉 <strong>Special Trade Complete!</strong>
        </div>
      `;
      
      // Save to active special trades
      const specialTrade = {
        type: 'special_trade',
        asset: 'ETH',
        buyAmount: parseFloat(ethAmount),
        buyPrice: buyData.data.price,
        buyTime: new Date().toISOString(),
        targetPrice: targetPrice,
        targetProfit: ((targetPrice - currentPrice) * ethAmount).toFixed(2),
        status: 'active',
        sellOrderId: sellData.data.orderId
      };
      
      saveSpecialTrade(specialTrade);
      loadActiveSpecialTrades();
      
      btn.innerHTML = '✅ Trade Complete!';
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = '🚀 Execute Special Trade';
      }, 3000);
      
      // Refresh portfolio
      setTimeout(loadPortfolio, 2000);
      
    } else {
      throw new Error(`Take profit order failed: ${sellData.error}`);
    }
    
  } catch (error) {
    msgDiv.innerHTML = `<div class="message error">❌ Error: ${error.message}</div>`;
    btn.disabled = false;
    btn.innerHTML = '🚀 Execute Special Trade';
  }
}

async function waitForOrderConfirmation(orderId, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
    
    try {
      const res = await fetch(`${API_BASE}/orders`);
      const data = await res.json();
      
      if (data.success && data.data) {
        const order = data.data[orderId];
        if (order && order.status === 'FILLED') {
          return true;
        }
      }
    } catch (error) {
      console.log('Polling error:', error.message);
    }
  }
  return false; // Timeout
}

function saveSpecialTrade(trade) {
  let trades = JSON.parse(localStorage.getItem('specialTrades') || '[]');
  trades.unshift(trade);
  localStorage.setItem('specialTrades', JSON.stringify(trades));
}

function loadActiveSpecialTrades() {
  const container = document.getElementById('activeSpecialTrades');
  const trades = JSON.parse(localStorage.getItem('specialTrades') || '[]');
  
  if (trades.length === 0) {
    container.innerHTML = '<div class="loading">No active trades</div>';
    return;
  }
  
  container.innerHTML = trades.map((trade, index) => `
    <div style="background: rgba(92, 39, 250, 0.1); border: 1px solid #5c27fa; border-radius: 8px; padding: 15px; margin-bottom: 10px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <strong style="color: #00ff88;">🎯 ${trade.asset} Special Trade</strong><br>
          <small style="color: #aaa;">
            Bought: ${trade.buyAmount} ETH @ $${trade.buyPrice.toFixed(2)}<br>
            Target: $${trade.targetPrice.toFixed(2)} | Potential Profit: $${trade.targetProfit}
          </small>
        </div>
        <div style="text-align: right;">
          <span class="status-badge ${trade.status === 'active' ? 'connected' : 'disconnected'}">
            ${trade.status.toUpperCase()}
          </span><br>
          <small style="color: #aaa;">${new Date(trade.buyTime).toLocaleString()}</small><br>
          ${trade.status === 'active' ? `
            <button onclick="cancelSpecialTrade(${index})" style="margin-top: 5px; background: rgba(255, 71, 87, 0.2); border: 1px solid #ff4757; color: #ff4757; padding: 5px 10px; border-radius: 5px; cursor: pointer;">
              Cancel
            </button>
          ` : ''}
        </div>
      </div>
    </div>
  `).join('');
}

function cancelSpecialTrade(index) {
  let trades = JSON.parse(localStorage.getItem('specialTrades') || '[]');
  trades.splice(index, 1);
  localStorage.setItem('specialTrades', JSON.stringify(trades));
  loadActiveSpecialTrades();
}
