# DCA Trading Bot - Complete Implementation Prompt

## Overview
Build a DCA (Dollar Cost Averaging) crypto trading bot with a web frontend. The bot should support two modes:
- **Development mode (port 3003)**: Mock prices and mock trading
- **Production mode (port 3004)**: Live Binance US prices and real trading

## Architecture

### Technology Stack
- Node.js with Express
- SQLite for persistence
- WebSocket for real-time updates
- Vanilla HTML/JS frontend (single file)
- Binance US API for live trading

### Key Files Structure
```
backend/
  src/
    index.js        - Main server (Express + WebSocket)
    routes/dca.js   - REST API endpoints
    dca-bot.js      - Trading logic (grid strategy)
    trading-wrapper.js - Binance API wrapper
    trading-db.js   - SQLite database operations
    mock-exchange/  - Mock trading for dev mode
    api/            - Binance API client
frontend/
  dca-trading.html - Single-page trading interface
```

## Core Features

### 1. Environment Management
- Use `USE_MOCK=false` environment variable to switch between dev/prod
- Dev: USE_MOCK=true (default), uses mockExchange
- Prod: USE_MOCK=false, uses real Binance US

### 2. Trading Pairs
- **DEV**: ETHUSDT, BTCUSDT, LTCUSDT (Tether pairs)
- **PROD**: ETHUSD, BTCUSD, LTCUSD (USD pairs - important for fiat accounts!)

### 3. DCA Grid Strategy
Each strategy has:
- `symbol`: Trading pair (e.g., ETHUSD)
- `tradeAmount`: Quantity per order (e.g., 0.005 ETH)
- `totalBudget`: Total budget allocated (e.g., $50)
- `profitTarget`: % profit target per trade (e.g., 0.5%)
- `gridLevels`: Number of buy orders (e.g., 7)
- `gridSpacing`: $ difference between levels (e.g., $3)
- `startPrice`: Starting price for grid

The bot places limit buy orders at `startPrice - (level * spacing)` for each level.
When a buy fills, it places a sell at `buyPrice * (1 + profitTarget/100)`.

### 4. API Endpoints

**Environment**
- `GET /api/dca/status` - Returns `{mode: 'development'|'production', useMock: boolean}`

**Strategies**
- `GET /api/dca/strategies` - List all strategies with stats
- `POST /api/dca/strategies` - Create new strategy
- `GET /api/dca/strategies/:id` - Get single strategy
- `DELETE /api/dca/strategies/:id` - Delete strategy
- `PUT /api/dca/strategies/:id` - Update strategy

**Prices**
- `GET /api/dca/prices` - Get current prices (mock in dev, live Binance in prod)
  ```json
  {"prices": {"ETHUSD": 2073.18, "BTCUSD": 70600, "LTCUSD": 54.24}, "source": "binance"}
  ```

**Orders**
- `GET /api/dca/orders` - Get open orders (from gridSteps in prod, mockExchange in dev)

**Account**
- `GET /api/dca/account` - Get account balance from Binance

**Bot Status**
- `GET /api/dca/bot/status` - Get bot running status

### 5. Frontend Features

**Header Ticker**
- Shows live prices for BTC, ETH, LTC
- Updates every 3 seconds and via WebSocket

**Strategy Form**
- Symbol dropdown (USD pairs in prod, USDT in dev)
- Trade amount, total budget, profit target
- Grid levels and spacing
- Start price (auto-fills current price)

**Strategy List**
- Shows active/paused strategies with:
  - Symbol, status, open orders count
  - Available cash, total assets
  - Progress indicators

**Orders Display**
- Shows all open buy orders with:
  - Price level, quantity, order ID (real Binance ID in prod)

**Environment Indicator**
- Dev: Green "MOCK TRADING" with simulation controls
- Prod: Red "PRODUCTION" warning with live Binance US

### 6. WebSocket Messages

**Server → Client**
- `init`: Initial state on connect
- `price`: Price update
- `order_update`: Order status change
- `strategy_update`: Strategy change

### 7. Key Implementation Details

**Binance US Integration**
- Use `/api/v3/account` for balance
- Use `/api/v3/order/limit` for limit orders
- Use USD pairs (not USDT) for fiat accounts

**Price Fetching**
- Cache prices in memory
- Update every 5 seconds
- Use in both HTTP endpoint and WebSocket

**Order Tracking**
- Store order info in gridSteps array
- Status values: `available`, `open_buy`, `filled_buy`, `pending_sell`, `completed`
- Store Binance orderId for tracking

**Order Processing Persistence** (NEW 2026-03-15)
- `data-prod/processed-orders.json` tracks processed order IDs
- Prevents re-processing same orders on restart
- Functions: `markOrderProcessed()`, `isOrderProcessed()`, `saveState()`

**Profit Tracking** (NEW 2026-03-15)
- `completed-trades.json` cleared on bot startup
- Only tracks profit from CURRENT session
- Function: `clearCompletedTrades()`

**Stale Order Cleanup** (NEW 2026-03-15)
- On startup, cancels Binance orders not in current grid
- Safety check detects stale open_buy orders and resets grid steps
- Prevents orphaned orders from blocking new trades

**Available Cash Calculation**
```
// FIXED (2026-03-15): Use grid status instead of all Binance history
// This prevents stale historical orders from blocking new orders
openBuyCost = gridSteps.filter(s => s.status === 'open_buy').reduce(...)
netCommitted = gridSteps.filter(s => s.status === 'pending_sell').reduce(...)
availableCash = usableBudget - openBuyCost - netCommitted

// OLD (buggy - counted ALL historical Binance orders):
// openBuyCost = allOrders.filter(o => o.side === 'BUY' && o.status === 'NEW')...
// filledBuyCost = allOrders.filter(o => o.side === 'BUY' && o.status === 'FILLED')...
// filledSellValue = allOrders.filter(o => o.side === 'SELL' && o.status === 'FILLED')...
// netCommitted = filledBuyCost - filledSellValue
// availableCash = totalBudget - openBuyCost - netCommitted
```

### 8. Files to Create

**backend/src/index.js**
- Express server on configurable port
- WebSocket server on `/ws`
- Serve static frontend
- Routes for API

**backend/src/routes/dca.js**
- All REST endpoints
- Calculate strategy stats from gridSteps (not mockExchange!)

**backend/src/dca-bot.js**
- Main trading loop (every 5 seconds)
- processStrategy() - process each strategy
- placeBuyOrders() - place limit orders at grid levels
- checkEmergencyDrop() - emergency protection
- **NEW**: `start()` clears completed trades and cancels stale Binance orders on startup
- **NEW**: `checkMissingOrders()` safety check detects stale open_buy orders and resets grid steps

**backend/src/trading-wrapper.js**
- Wrapper around binance API and mockExchange
- getPrice(), getAllOrders(), getOpenOrders(), placeOrder(), cancelOrder()
- Use USD pairs in prod, USDT in dev
- **NEW**: `markOrderProcessed(orderId)` - mark order as processed (persisted to processed-orders.json)
- **NEW**: `isOrderProcessed(orderId)` - check if order was already processed
- **NEW**: `saveState()` / `getState()` - persist processed order IDs

**backend/src/trading-db.js**
- SQLite operations
- createStrategy(), getStrategy(), updateStrategy(), deleteStrategy()
- updateGridStep(), getAllStrategies()
- **NEW**: `clearCompletedTrades()` - clear completed trades (called on startup)

**backend/src/mock-exchange/index.js**
- In-memory mock trading for dev mode
- getPrice(), getAllOrders(), placeOrder(), fillOrder()

**backend/src/api/index.js**
- Binance API client
- Requires API key/secret in environment

**frontend/dca-trading.html**
- Single HTML file with embedded CSS and JS
- Responsive design with dark theme
- WebSocket for real-time updates

## Testing Checklist

1. **Dev mode (port 3003)**
   - [ ] Prices show mock values (~$2500 ETH, $45000 BTC)
   - [ ] Can create strategy with USDT pairs
   - [ ] Orders simulate correctly
   - [ ] Simulation buttons work

2. **Prod mode (port 3004)**
   - [ ] Prices show live Binance values
   - [ ] Can create strategy with USD pairs
   - [ ] Real orders placed on Binance US
   - [ ] Account balance shows correctly
   - [ ] Open orders display with real Binance order IDs
   - [ ] Available cash reflects committed orders

## Important Notes

1. **USD vs USDT**: Binance US fiat accounts use USD (not USDT). The account balance will show USD, not USDT.

2. **Async/Await**: When using Binance API in prod mode, always await async functions. Common mistake: `trading.placeOrder()` is async but was called without await.

3. **Order Tracking**: In prod mode, don't use mockExchange methods - they return empty arrays. Instead, track orders in strategy.gridSteps.

4. **DOM Ready**: Ensure JavaScript runs after DOMContentLoaded to avoid null element errors.

5. **WebSocket Prices**: The WebSocket init message should fetch live prices in prod, not use mockExchange prices.