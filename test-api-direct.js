require('dotenv').config();
const https = require('https');
const crypto = require('crypto');
const querystring = require('querystring');

const API_KEY = process.env.KRAKEN_API_KEY;
const API_SECRET = process.env.KRAKEN_API_SECRET;

console.log('Testing Kraken API directly...\n');
console.log('Key:', API_KEY ? '✅' : '❌');
console.log('Secret:', API_SECRET ? '✅' : '❌');
console.log('');

const nonce = Date.now().toString();
const postData = querystring.stringify({ nonce });

const secret = Buffer.from(API_SECRET, 'base64');
const hash = crypto.createHash('sha256');
const hmac = crypto.createHmac('sha512', secret);
const hashDigest = hash.update(nonce + postData).digest('binary');
const hmacDigest = hmac.update('/0/private/Balance' + hashDigest, 'binary').digest('base64');

console.log('Nonce:', nonce);
console.log('Signature:', hmacDigest.substring(0, 50) + '...\n');

const req = https.request('https://api.kraken.com/0/private/Balance', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'API-Key': API_KEY,
    'API-Sign': hmacDigest,
    'Content-Length': Buffer.byteLength(postData)
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      console.log('Status:', res.statusCode);
      console.log('Response:', JSON.stringify(json, null, 2));
      
      if (json.error && json.error.length > 0) {
        console.log('\n❌ Error:', json.error[0]);
      } else {
        console.log('\n✅ SUCCESS! Balances:', json.result);
      }
    } catch (e) {
      console.log('Parse error:', e.message);
      console.log('Raw response:', data);
    }
  });
});

req.on('error', (e) => {
  console.log('Request error:', e.message);
});

req.write(postData);
req.end();
