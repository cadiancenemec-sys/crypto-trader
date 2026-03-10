/**
 * Kraken API Configuration
 * Ultra-low fee trading (0.16% - 0.26%)
 */

const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');

class KrakenAPI {
  constructor() {
    // Force reload dotenv from .env file
    require('dotenv').config({ path: __dirname + '/../.env' });
    this.apiKey = process.env.KRAKEN_API_KEY;
    this.apiSecret = process.env.KRAKEN_API_SECRET;
    this.baseUrl = process.env.KRAKEN_BASE_URL || 'https://api.kraken.com';
    console.log('KrakenAPI initialized - Key loaded:', this.apiKey ? 'YES' : 'NO');
  }

  async publicRequest(endpoint, data = {}) {
    return new Promise((resolve, reject) => {
      const url = `${this.baseUrl}/0${endpoint}`;
      const postData = querystring.stringify(data);
      
      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error && json.error.length > 0) reject(new Error(json.error[0]));
            else resolve(json.result);
          } catch (e) { reject(e); }
        });
      });
      
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  async privateRequest(endpoint, data = {}) {
    return new Promise((resolve, reject) => {
      const nonce = Date.now().toString();
      const postData = querystring.stringify({ ...data, nonce });
      
      console.log('API Request:', endpoint);
      console.log('API Key:', this.apiKey ? this.apiKey.substring(0, 20) + '...' : 'MISSING');
      console.log('API Secret:', this.apiSecret ? this.apiSecret.substring(0, 20) + '...' : 'MISSING');
      
      const secret = Buffer.from(this.apiSecret, 'base64');
      const hash = crypto.createHash('sha256');
      const hmac = crypto.createHmac('sha512', secret);
      const hashDigest = hash.update(nonce + postData).digest('binary');
      const hmacDigest = hmac.update(endpoint + hashDigest, 'binary').digest('base64');
      
      const url = `${this.baseUrl}/0${endpoint}`;
      
      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'API-Key': this.apiKey,
          'API-Sign': hmacDigest,
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error && json.error.length > 0) reject(new Error(json.error[0]));
            else resolve(json.result);
          } catch (e) { reject(e); }
        });
      });
      
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  async getBalance() { return await this.privateRequest('/private/Balance'); }
  async getTicker(pair) { return await this.publicRequest('/public/Ticker', { pair }); }
  async getAssetPairs() { return await this.publicRequest('/public/AssetPairs'); }
  async getOpenOrders() { return await this.privateRequest('/private/OpenOrders'); }
  
  async placeOrder(pair, type, volume, orderType = 'market', price = null) {
    const data = { pair, type, volume: volume.toString(), ordertype: orderType };
    if (orderType === 'limit' && price) data.price = price.toString();
    return await this.privateRequest('/private/AddOrder', data);
  }

  async cancelOrder(txid) { return await this.privateRequest('/private/CancelOrder', { txid }); }
  async getServerTime() { return await this.publicRequest('/public/Time'); }
}

module.exports = new KrakenAPI();
