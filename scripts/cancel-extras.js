#!/usr/bin/env node
// Cancel the extra duplicate orders that aren't tracked in grid

const trading = require('../backend/src/trading-wrapper');
const api = require('../backend/src/api');

async function main() {
  // Load current grid
  const strategies = require('../data-prod/strategies.json');
  const grid = strategies[0]?.gridSteps || [];
  
  // Collect all tracked order IDs from grid
  const trackedOrderIds = new Set();
  grid.forEach(step => {
    if (step.orderId) trackedOrderIds.add(step.orderId.toString());
    if (step.buyOrderId) trackedOrderIds.add(step.buyOrderId.toString());
    if (step.sellOrderId) trackedOrderIds.add(step.sellOrderId.toString());
  });
  
  console.log('Grid tracks', trackedOrderIds.size, 'order IDs');
  
  // Fetch all orders from Binance
  const allOrders = await trading.getAllOrders('ETHUSD');
  const newOrders = allOrders.filter(o => o.status === 'NEW');
  console.log('Binance has', newOrders.length, 'NEW orders');
  
  // Find orders NOT in grid (extras)
  const extras = newOrders.filter(o => !trackedOrderIds.has(o.orderId.toString()));
  console.log('\n⚠️  Found', extras.length, 'extra orders to cancel:');
  extras.forEach(o => {
    console.log(`  - Order ${o.orderId}: ${o.side} @ $${o.price}`);
  });
  
  if (extras.length === 0) {
    console.log('✅ No extras to cancel');
    return;
  }
  
  // Cancel extras
  console.log('\n❌ Cancelling extras...');
  for (const extra of extras) {
    try {
      await api.trading.cancelOrder(extra.orderId, 'ETHUSD');
      console.log(`✓ Cancelled order ${extra.orderId}`);
    } catch (err) {
      console.log(`✗ Failed to cancel ${extra.orderId}: ${err.message}`);
    }
  }
  
  console.log('\n✅ Cleanup complete');
}

main().catch(console.error);
