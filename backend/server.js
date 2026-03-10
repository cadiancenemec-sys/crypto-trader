/**
 * Kraken Trading Platform - Backend Server
 * Ultra-low fee ETH trading (0.16% - 0.26%)
 */

// Load dotenv explicitly BEFORE anything else
const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.join(__dirname, '.env') });

console.log('='.repeat(60));
console.log('SERVER STARTING...');
console.log('='.repeat(60));
console.log('KRAKEN_API_KEY loaded:', process.env.KRAKEN_API_KEY ? 'YES ✅' : 'NO ❌');
console.log('KRAKEN_API_SECRET loaded:', process.env.KRAKEN_API_SECRET ? 'YES ✅' : 'NO ❌');
console.log('KRAKEN_API_KEY value:', process.env.KRAKEN_API_KEY ? process.env.KRAKEN_API_KEY.substring(0, 20) + '...' : 'N/A');
console.log('='.repeat(60));

const express = require('express');
const cors = require('cors');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3003;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// API Routes
app.use('/api', apiRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    exchange: 'Kraken',
    fee: '0.16% - 0.26%',
    timestamp: new Date().toISOString()
  });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🟢 Kraken Trading Platform Started!');
  console.log('='.repeat(50));
  console.log(`📡 Server: http://0.0.0.0:${PORT}`);
  console.log(`💰 Exchange: Kraken`);
  console.log(`📉 Fees: 0.16% - 0.26% (Industry Lowest!)`);
  console.log(`🔗 API: http://localhost:${PORT}/api`);
  console.log(`🔑 API Key: ${process.env.KRAKEN_API_KEY ? 'Loaded ✅' : 'MISSING ❌'}`);
  console.log('='.repeat(50));
  console.log('');
});
