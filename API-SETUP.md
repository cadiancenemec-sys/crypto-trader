# 🔑 Kraken API Key Setup

## Current Status
✅ **API Connection:** Working  
✅ **Balance queries:** Working  
✅ **Price data:** Working  
❌ **Trading:** Locked (needs permission update)

## Error: "Trade:User Locked"

Your API key doesn't have trading permissions enabled. This is a security feature.

## 🔧 How to Fix

### Step 1: Go to Kraken API Settings
1. Log into your Kraken account: https://www.kraken.com
2. Go to **Settings** → **API**
3. Find your API key: `l7l4XGYh1dce/Djffwgo/JLpDxHiMI+UW/h6xdIS7jQpz9YO1X1SVSoF`
4. Click **Edit** or **Modify**

### Step 2: Enable Trading Permissions
Make sure these permissions are checked:
- ✅ **Query funds** (already working)
- ✅ **Query open orders & trades**
- ✅ **Create & modify orders** ← **THIS IS MISSING**
- ✅ **Cancel orders**

### Step 3: Save & Wait
- Click **Save Changes**
- Wait 1-2 minutes for changes to propagate
- Test again!

### Step 4: Test Trading
```bash
# Test with $1 buy order
curl -X POST http://localhost:3003/api/buy \
  -H "Content-Type: application/json" \
  -d '{"amountUSD": 1.00}'
```

Expected response:
```json
{
  "success": true,
  "data": {
    "type": "buy",
    "amountUSD": 1.00,
    "ethAmount": "0.000506",
    "price": 1975.67,
    "fee": "0.00",
    "orderIds": ["O12345-ABCDE-67890"]
  }
}
```

## 🎯 Current Portfolio
- **USD Balance:** $1.14
- **ETH Balance:** 0 ETH
- **LTC Balance:** 0.00045 LTC
- **Total Value:** $1.14
- **ETH Price:** $1,975.67

## 📊 Trading Fees
- **Maker:** 0.16% (limit orders)
- **Taker:** 0.26% (market orders)
- **vs Coinbase:** Save 60-85% on fees!

## 🌐 Access Your Trading Dashboard
Open in browser: **http://localhost:3003**

The UI is ready and waiting - just enable trading permissions and you're good to go! 🚀
