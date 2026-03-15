#!/usr/bin/env node
// Cancel duplicate/orphaned orders on Binance that aren't tracked in current grid

const trading = require('../backend/src/trading-wrapper');
const api = require('../backend/src/api');

async function main() {
  console.log('🔍 Fetching all orders from Binance...');
  const allOrders = await trading.getAllOrders('ETHUSD');
  console.log(`Found ${allOrders.length} orders on Binance`);
  
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
  
  console.log(`Grid tracks ${trackedOrderIds.size} order IDs`);
  
  // Find orders NOT in grid
  const orphans = allOrders.filter(o => !trackedOrderIds.has(o.orderId.toString()));
  console.log(`\n⚠️  Found ${orphans.length} orphaned orders:`);
  orphans.forEach(o => {
    console.log(`  - Order ${o.orderId}: ${o.side} @ $${o.price} (${o.status})`);
  });
  
  if (orphans.length === 0) {
    console.log('✅ No orphans to cancel');
    return;
  }
  
  // Cancel orphans
  console.log('\n❌ Cancelling orphans...');
  for (const orphan of orphans) {
    try {
      await api.trading.cancelOrder(orphan.orderId, 'ETHUSD');
      console.log(`✓ Cancelled order ${orphan.orderId}`);
    } catch (err) {
      console.log(`✗ Failed to cancel ${orphan.orderId}: ${err.message}`);
    }
  }
  
  console.log('\n✅ Cleanup complete');
}

main().catch(console.error);
