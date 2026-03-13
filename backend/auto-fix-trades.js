// Auto-fix trades: Move unfilled "active" trades back to pending
// Run this every 10 minutes to keep data in sync with Binance.US

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Load .env
require('dotenv').config({ path: path.join(__dirname, '.env') });

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';

function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(__dirname, 'auto-fix.log'), line + '\n');
}

function makeRequest(apiPath, method = 'GET', data = {}) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now();
    const params = { timestamp };
    if (data) Object.assign(params, data);
    
    const queryString = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    const signature = crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
    
    const options = {
      hostname: 'api.binance.us',
      path: `${apiPath}?${queryString}&signature=${signature}`,
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

async function autoFixTrades() {
  log('🔍 Auto-fixing trades...');
  
  const backupPath = path.join(__dirname, 'special-trades-backup.json');
  const pendingPath = path.join(__dirname, 'pending-orders.json');
  
  let backupData = { active: [], completed: [] };
  let pendingData = { pending: [] };
  
  try {
    backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    pendingData = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  } catch (e) {
    log('⚠️ Error reading files: ' + e.message);
    return;
  }
  
  // Fetch all orders from Binance.US to check which are actually filled
  let orderHistory = [];
  try {
    orderHistory = await makeRequest('/api/v3/allOrders', 'GET', { symbol: 'ETHUSD', limit: 100 });
    if (!Array.isArray(orderHistory)) {
      log('❌ Invalid API response');
      return;
    }
  } catch (e) {
    log('❌ API error: ' + e.message);
    return;
  }
  
  const activeToMove = [];
  const activeToKeep = [];
  
  for (const trade of backupData.active || []) {
    // Check if this trade has a sell order (means it's truly active)
    if (trade.sellOrderId) {
      activeToKeep.push(trade);
      continue;
    }
    
    // No sell order - check if the buy order filled
    const buyOrder = orderHistory.find(o => o.orderId && o.orderId.toString() === trade.buyOrderId?.toString());
    
    if (buyOrder && buyOrder.status === 'FILLED') {
      // Buy filled but no sell order - this is a problem, should have sell order
      log(`⚠️ Trade filled but no sell order: ${trade.buyAmount} ETH @ ${trade.buyPrice}`);
      activeToKeep.push(trade); // Keep it, monitor will place sell order
    } else {
      // Buy not filled - move back to pending
      activeToMove.push(trade);
      log(`📋 Moving unfilled trade to pending: ${trade.buyAmount} ETH @ ${trade.buyPrice}`);
    }
  }
  
  if (activeToMove.length === 0) {
    log('✅ All active trades are valid');
    return;
  }
  
  // Move unfilled trades to pending
  activeToMove.forEach(trade => {
    pendingData.pending.push({
      orderId: 'pending_' + Date.now() + Math.random().toString(36).substr(2, 5),
      type: 'buy_limit',
      asset: 'ETH',
      limitPrice: trade.buyPrice,
      buyAmount: trade.buyAmount,
      targetPrice: trade.targetPrice,
      targetProfit: trade.targetProfit,
      targetProfitPct: trade.targetProfitPct,
      status: 'NEW',
      createTime: trade.buyTime || new Date().toISOString()
    });
  });
  
  // Update files
  backupData.active = activeToKeep;
  fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));
  fs.writeFileSync(pendingPath, JSON.stringify(pendingData, null, 2));
  
  log(`✅ Fixed ${activeToMove.length} trades`);
  log(`   Active: ${activeToKeep.length} (was ${backupData.active.length + activeToMove.length})`);
  log(`   Pending: ${pendingData.pending.length} (was ${pendingData.pending.length - activeToMove.length})`);
}

// Run immediately
autoFixTrades();

// Then run every 10 minutes
setInterval(autoFixTrades, 10 * 60 * 1000);

log('✅ Auto-fix started - checking every 10 minutes');
