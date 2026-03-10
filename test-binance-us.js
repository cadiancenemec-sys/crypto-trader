#!/usr/bin/env node
/**
 * Binance.US Connection Test
 * Run this directly on your machine to debug API issues
 */

const https = require('https');
const crypto = require('crypto');

// TODO: Replace these with your ACTUAL keys from Binance.US
const API_KEY = 'VodDaXRiqzoZPP9iZo8HqgRPHwniSXkaL7rYpKDIgztHyIWhWAWSYXbIZ3WC3fN5';
const API_SECRET = 'o6Od0yVsyOrJqJM7pheAJSG9E9SzILYCXQUEmAI0Y4fpH9j8RPHDaF1LW2CsJSRJ';

console.log('🔍 Binance.US Connection Test\n');
console.log('API Key:', API_KEY.substring(0, 20) + '...');
console.log('API Secret:', API_SECRET.substring(0, 20) + '...');
console.log('Key Length:', API_KEY.length);
console.log('Secret Length:', API_SECRET.length);
console.log('');

// Step 1: Test public endpoint
console.log('Step 1: Testing public endpoint...');
https.get('https://api.binance.us/api/v3/time', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const { serverTime } = JSON.parse(data);
      console.log('✅ Public endpoint works. Server time:', serverTime);
      console.log('');
      
      // Step 2: Test authenticated endpoint
      console.log('Step 2: Testing authenticated endpoint...');
      const timestamp = serverTime;
      const queryString = 'timestamp=' + timestamp;
      const signature = crypto
        .createHmac('sha256', API_SECRET)
        .update(queryString)
        .digest('hex');
      
      const options = {
        hostname: 'api.binance.us',
        path: '/api/v3/account?' + queryString + '&signature=' + signature,
        method: 'GET',
        headers: {
          'X-MBX-APIKEY': API_KEY
        }
      };
      
      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(responseData);
            
            if (res.statusCode === 200 && !json.code) {
              console.log('✅ SUCCESS! Authenticated endpoint works!');
              console.log('');
              console.log('Your account balances:');
              const balances = json.balances.filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
              balances.forEach(b => {
                console.log(`  ${b.asset}: ${b.free} (free) + ${b.locked} (locked)`);
              });
              process.exit(0);
            } else {
              console.log('❌ API Error:', json.code, '-', json.msg);
              console.log('');
              console.log('Troubleshooting steps:');
              console.log('1. Verify API key is from Binance.US (not Binance.com)');
              console.log('2. Check API key has "Enable Reading" permission');
              console.log('3. Check API key has "Enable Spot & Margin Trading" permission');
              console.log('4. Verify your IP is whitelisted (or remove IP restriction temporarily)');
              console.log('5. Make sure API key type is "Exchange API Key" (not Custodial/Credit Line)');
              console.log('6. Wait 5 minutes after making any changes');
              console.log('');
              console.log('Raw response:', JSON.stringify(json, null, 2));
              process.exit(1);
            }
          } catch (e) {
            console.log('❌ Parse error:', e.message);
            console.log('Raw response:', responseData);
            process.exit(1);
          }
        });
      });
      
      req.on('error', (e) => {
        console.log('❌ Request error:', e.message);
        process.exit(1);
      });
      req.end();
      
    } catch (e) {
      console.log('❌ Failed to parse server time:', e.message);
      process.exit(1);
    }
  });
}).on('error', (e) => {
  console.log('❌ Network error:', e.message);
  process.exit(1);
});
