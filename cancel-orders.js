const axios = require('axios');
const crypto = require('crypto');

const API_KEY = 'oC4o63DvvDkMVpHP5GLU533LuZ00dV0Ofz004xjbJ8y3ZabkW2L2Gw47sYPKB6XX';
const API_SECRET = 'ptAMhj3zkGRzYx4aq62A0drX6cn3VSbNSORrUbGz616n0jxxS61dEsWMtgb6BZ8t';
const BASE_URL = 'https://api.binance.us';

async function cancelOrder(orderId) {
  const params = { symbol: 'ETHUSD', orderId, timestamp: Date.now() };
  const queryString = Object.keys(params).sort().map(k => k + '=' + params[k]).join('&');
  const signature = crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
  const url = BASE_URL + '/api/v3/order?' + queryString + '&signature=' + signature;
  
  const response = await axios.delete(url, {
    headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  return response.data;
}

async function main() {
  // First get the open orders
  const ordersRes = await axios.get(BASE_URL + '/api/v3/openOrders?symbol=ETHUSD', {
    headers: { 'X-MBX-APIKEY': API_KEY }
  });
  const orders = ordersRes.data;
  
  console.log('Found', orders.length, 'open orders');
  
  for (const order of orders) {
    try {
      await cancelOrder(order.orderId);
      console.log('Cancelled:', order.orderId, '@', order.price);
    } catch(e) {
      console.log('Error cancelling', order.orderId + ':', e.response?.data?.msg || e.message);
    }
    await new Promise(r => setTimeout(r, 100)); // Rate limit
  }
  console.log('\nDone!');
}

main().catch(console.error);