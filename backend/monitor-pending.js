// Monitor pending orders every 5 minutes
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.BINANCE_US_API_KEY || '';
const API_SECRET = process.env.BINANCE_US_API_SECRET || '';

function makeRequest(apiPath, method = 'GET', data = {}) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now();
    const queryString = method === 'GET' ? 
      Object.keys(data).map(k => k + '=' + data[k]).join('&') : 
      Object.keys(data).map(k => k + '=' + encodeURIComponent(data[k])).join('&');
    const signature = crypto
      .createHmac('sha256', API_SECRET)
      .update(queryString + '&timestamp=' + timestamp)
      .digest('hex');
    
    const options = {
      hostname: 'api.binance.us',
      path: `/sapi/v1${apiPath}?${queryString}&timestamp=${timestamp}&signature=${signature}`,
      method,
      headers: { 'X-MBX-APIKEY': API_KEY }
    };
    
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(body));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function checkPendingOrders() {
  console.log('\n🔍 [' + new Date().toISOString() + '] Checking pending orders...');
  
  const pendingPath = path.join(__dirname, 'pending-orders.json');
  let data = { pending: [] };
  
  try {
    const fileData = fs.readFileSync(pendingPath, 'utf8');
    data = JSON.parse(fileData);
  } catch (e) {
    console.log('⚠️ No pending orders file');
    return;
  }
  
  if (!data.pending || data.pending.length === 0) {
    console.log('✅ No pending orders to check');
    return;
  }
  
  console.log(`📋 Found ${data.pending.length} pending order(s)`);
  
  // Fetch order history
  let orderHistory = [];
  try {
    const history = await makeRequest('/allOrders', 'GET', { symbol: 'ETHUSD', limit: 50 });
    if (Array.isArray(history)) {
      orderHistory = history;
    }
  } catch (e) {
    console.error('❌ Error fetching order history:', e.message);
    return;
  }
  
  const ordersToRemove = [];
  const ordersToAdd = [];
  
  for (const trade of data.pending) {
    const filledOrder = orderHistory.find(o => o.orderId == trade.orderId);
    
    if (!filledOrder) {
      console.log(`  ⏳ Order ${trade.orderId} @ $${trade.limitPrice} - Still pending (not in history yet)`);
      continue;
    }
    
    if (filledOrder.status === 'FILLED') {
      console.log(`  ✅ Order ${trade.orderId} @ $${filledOrder.price} - FILLED!`);
      
      // Place take-profit sell order
      try {
        const sellOrder = await makeRequest('/order', 'POST', {
          symbol: 'ETHUSD',
          side: 'SELL',
          type: 'LIMIT',
          quantity: trade.buyAmount.toString(),
          price: trade.targetPrice.toFixed(2),
          timeInForce: 'GTC'
        });
        
        console.log(`    🎯 Take-profit placed: $${trade.targetPrice} (Order: ${sellOrder.orderId})`);
        
        // Add to active trades
        ordersToAdd.push({
          type: 'special_trade',
          asset: 'ETH',
          buyAmount: trade.buyAmount,
          buyPrice: parseFloat(filledOrder.price),
          buyFee: parseFloat(filledOrder.fee || 0),
          buyTime: new Date(filledOrder.time).toISOString(),
          targetPrice: trade.targetPrice,
          targetProfit: trade.targetProfitDollar,
          status: 'active',
          sellOrderId: sellOrder.orderId
        });
        
        ordersToRemove.push(trade.orderId);
        
      } catch (e) {
        console.error(`    ❌ Failed to place take-profit: ${e.message}`);
      }
      
    } else if (['CANCELED', 'REJECTED', 'EXPIRED'].includes(filledOrder.status)) {
      console.log(`  ❌ Order ${trade.orderId} - ${filledOrder.status}`);
      ordersToRemove.push(trade.orderId);
    } else {
      console.log(`  ⏳ Order ${trade.orderId} @ $${trade.limitPrice} - Status: ${filledOrder.status}`);
    }
  }
  
  // Update pending orders file
  if (ordersToRemove.length > 0) {
    data.pending = data.pending.filter(o => !ordersToRemove.includes(o.orderId));
    fs.writeFileSync(pendingPath, JSON.stringify(data, null, 2));
    console.log(`📦 Removed ${ordersToRemove.length} order(s) from pending`);
  }
  
  // Add to active trades backup
  if (ordersToAdd.length > 0) {
    const backupPath = path.join(__dirname, 'special-trades-backup.json');
    let backupData = { active: [], completed: [] };
    
    try {
      const fileData = fs.readFileSync(backupPath, 'utf8');
      backupData = JSON.parse(fileData);
    } catch (e) {
      // File doesn't exist
    }
    
    if (!backupData.active) backupData.active = [];
    if (!backupData.completed) backupData.completed = [];
    
    ordersToAdd.forEach(trade => backupData.active.unshift(trade));
    fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));
    
    console.log(`✅ Added ${ordersToAdd.length} trade(s) to active special trades`);
    ordersToAdd.forEach(t => {
      console.log(`    🎯 $${t.buyPrice} → $${t.targetPrice} (Sell Order: ${t.sellOrderId})`);
    });
  }
  
  // === PERMANENT FIX: Sync pass for untracked sells ===
  console.log('\n🔄 Running sync pass...');
  try {
    const allOrders = await makeRequest('/api/v3/allOrders', 'GET', { symbol: 'ETHUSD', limit: 100 });
    if (Array.isArray(allOrders)) {
      const sells = allOrders.filter(o => o.side === 'SELL' && o.status === 'NEW');
      let synced = 0;
      for (const sell of sells) {
        const tracked = backupData.active.find(t => t.sellOrderId == sell.orderId);
        if (!tracked) {
          const matchingBuy = data.pending.find(p => 
            Math.abs(parseFloat(p.targetPrice) - parseFloat(sell.price)) < 0.1 &&
            Math.abs(parseFloat(p.buyAmount) - parseFloat(sell.origQty)) < 0.0001
          );
          if (matchingBuy) {
            const buyOrder = allOrders.find(o => o.orderId == matchingBuy.orderId);
            if (buyOrder && buyOrder.status === 'FILLED') {
              console.log(`  ✅ Syncing: ${sell.orderId}`);
              backupData.active.push({
                type: 'special_trade',
                asset: 'ETH',
                buyAmount: matchingBuy.buyAmount,
                buyPrice: parseFloat(buyOrder.price),
                buyFee: parseFloat(buyOrder.fee || 0),
                buyTime: new Date(buyOrder.time).toISOString(),
                targetPrice: matchingBuy.targetPrice,
                targetProfitPct: matchingBuy.targetProfitPct,
                targetProfit: matchingBuy.targetProfit,
                status: 'active',
                sellOrderId: sell.orderId
              });
              ordersToRemove.push(matchingBuy.orderId);
              synced++;
            }
          }
        }
      }
      
      if (synced > 0) {
        fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));
        console.log(`  ✅ Synced ${synced} trade(s)`);
        data.pending = data.pending.filter(o => !ordersToRemove.includes(o.orderId));
        fs.writeFileSync(pendingPath, JSON.stringify(data, null, 2));
        console.log(`  📦 Removed ${ordersToRemove.length} from pending`);
      } else {
        console.log('  ✅ All sells are tracked');
      }
    }
  } catch (e) {
    console.log('  ⚠️ Sync failed:', e.message);
  }
  
  // Summary
  console.log('\n📊 Summary:');
  console.log(`  Pending orders remaining: ${data.pending.length}`);
  console.log(`  Active trades added: ${ordersToAdd.length}`);
  
  if (data.pending.length > 0) {
    console.log('\n⏭️  Will check again in 5 minutes...');
    data.pending.forEach(t => {
      console.log(`    - $${t.limitPrice} → $${t.targetPrice} (${t.targetProfitPct}%)`);
    });
  }
}

// Run immediately
checkPendingOrders();

// Then run every 5 minutes
setInterval(checkPendingOrders, 5 * 60 * 1000);

console.log('✅ Monitor started - checking every 5 minutes');
