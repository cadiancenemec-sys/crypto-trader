# DCA Grid Trading Bot - Design Document

## Overview

An automated Dollar Cost Averaging (DCA) / Grid Trading system that continuously buys crypto at lowering price levels and sells at a profit, cycling indefinitely until stopped or target is reached.

---

## Strategy Logic

### Configuration Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `symbol` | Trading pair | ETHUSDT |
| `tradeAmount` | Amount per order (in base currency) | 0.01 ETH |
| `totalBudget` | Total budget allocated | $500 |
| `profitTarget` | Target profit % (including fees) | 1% |
| `gridLevels` | Number of buy order levels | 2 |
| `gridSpacing` | Price difference between levels | $5 |
| `startPrice` | Starting reference price | $2,000 |

### Order Generation Example

**Given:**
- Symbol: ETHUSDT
- Current price: $2,500
- Trade amount: 0.01 ETH
- Grid levels: 2
- Grid spacing: $5
- Profit target: 1%

**Buy Orders Created:**
```
Order 1: Buy 0.01 ETH @ $2,000
Order 2: Buy 0.01 ETH @ $1,995
```

**When Buy Fills:**
- Create sell order at: Buy Price × 1.01 (1% profit)
- Example: If bought @ $2,000, sell @ $2,020

**On Sell Completion:**
1. Mark trade as complete
2. Record in `completed_trades` table with profit
3. Recreate the original buy order to continue cycle

---

## Database Schema

### Table: trading_strategies

Active trading configurations (the list you control).

```sql
CREATE TABLE trading_strategies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,           -- ETHUSDT, BTCUSDT, etc.
  trade_amount REAL NOT NULL,     -- 0.01
  total_budget REAL NOT NULL,      -- 500.00 (USD)
  profit_target REAL NOT NULL,     -- 1.0 (percent)
  grid_levels INTEGER DEFAULT 2,   -- number of buy levels
  grid_spacing REAL DEFAULT 5,    -- $ between each level
  start_price REAL,                -- reference price for initial grid
  status TEXT DEFAULT 'active',    -- active, paused, completed, stopped
  auto_end BOOLEAN DEFAULT FALSE,  -- stop when budget depleted?
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Table: pending_orders

Current open orders for all strategies.

```sql
CREATE TABLE pending_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL,
  order_id TEXT NOT NULL,          -- exchange order ID
  side TEXT NOT NULL,              -- BUY or SELL
  symbol TEXT NOT NULL,
  price REAL NOT NULL,
  quantity REAL NOT NULL,
  status TEXT DEFAULT 'open',      -- open, filled, cancelled
  filled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (strategy_id) REFERENCES trading_strategies(id)
);
```

### Table: completed_trades

Historical record of completed buy+sell cycles.

```sql
CREATE TABLE completed_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  buy_price REAL NOT NULL,
  sell_price REAL NOT NULL,
  quantity REAL NOT NULL,
  profit REAL NOT NULL,            -- actual profit in USD
  profit_percent REAL NOT NULL,
  fees REAL DEFAULT 0,
  completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (strategy_id) REFERENCES trading_strategies(id)
);
```

### Table: strategy_stats

Aggregated stats per strategy.

```sql
CREATE TABLE strategy_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER UNIQUE NOT NULL,
  total_trades INTEGER DEFAULT 0,
  total_profit REAL DEFAULT 0,
  total_volume REAL DEFAULT 0,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (strategy_id) REFERENCES trading_strategies(id)
);
```

---

## Web Interface Design

### Main Dashboard

```
┌─────────────────────────────────────────────────────────────┐
│  DCA GRID TRADING                                           │
├─────────────────────────────────────────────────────────────┤
│  [+ Add Strategy]                    Total Profit: $XX.XX   │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Active Strategies (showing 2 of X)                 │   │
│  │                                                     │   │
│  │ [ETHUSDT]  Active   5 trades  $12.50 profit  [▶][■]│   │
│  │ [BTCUSDT]  Paused   0 trades  $0.00 profit   [▶][■] │   │
│  │                                                     │   │
│  │ [Show All] [Hidden: +3]                             │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Completed Trades                         [+ Expand] │   │
│  │                                                     │   │
│  │ ETH  Bought @ $2,000  Sold @ $2,020  +$0.20  ✓     │   │
│  │ BTC  Bought @ $42,000  Sold @ $42,420  +$4.20 ✓    │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Add/Edit Strategy Modal

```
┌─────────────────────────────────────┐
│  Add Trading Strategy               │
├─────────────────────────────────────┤
│  Symbol:          [ETHUSDT ▼]       │
│                                     │
│  Trade Amount:    [0.01   ] ETH     │
│  Total Budget:   [500    ] USD     │
│  Profit Target:  [1      ] %       │
│                                     │
│  Grid Levels:    [2  ]              │
│  Grid Spacing:   [5    ] USD       │
│                                     │
│  Start Price:    [2500  ] USD       │
│                                     │
│  ☐ Auto-end when budget depleted    │
│                                     │
│          [Cancel]  [Start]          │
└─────────────────────────────────────┘
```

### Strategy Detail View (when clicked)

```
┌─────────────────────────────────────────────────────────────┐
│  ETHUSDT Strategy                      [← Back] [■ Stop]   │
├─────────────────────────────────────────────────────────────┤
│  Status: Active    Budget: $485.00 / $500.00               │
│  Profit: $12.50    Trades: 5 completed                      │
├─────────────────────────────────────────────────────────────┤
│  Open Orders (2)                                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ BUY  0.01 ETH @ $2,000           [Cancel]            │   │
│  │ BUY  0.01 ETH @ $1,995           [Cancel]            │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Pending Sells (1)                                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ SELL 0.01 ETH @ $2,020 (from $2,000)  FILLING...     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Recent History                                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ✓ Bought 0.01 ETH @ $2,000          09:15:32       │   │
│  │ ✓ Sold 0.01 ETH @ $2,020  +$0.20    09:16:45       │   │
│  │ ✓ Bought 0.01 ETH @ $1,995          09:18:12       │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## API Endpoints

### Strategies

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/strategies` | List all strategies (with stats) |
| GET | `/api/strategies/:id` | Get single strategy details |
| POST | `/api/strategies` | Create new strategy |
| PUT | `/api/strategies/:id` | Update strategy config |
| DELETE | `/api/strategies/:id` | Delete strategy (cancels orders) |
| POST | `/api/strategies/:id/start` | Start/resume strategy |
| POST | `/api/strategies/:id/stop` | Pause strategy |

### Trades

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/strategies/:id/trades` | Completed trades for strategy |
| GET | `/api/trades` | All completed trades |

### Orders

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/strategies/:id/orders` | Open orders for strategy |

---

## Bot Operation Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    MAIN BOT LOOP                           │
│                    (runs every 10s)                         │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
            ┌──────────────────────────────┐
            │  For each ACTIVE strategy:    │
            └──────────────────────────────┘
                           │
                           ▼
            ┌──────────────────────────────┐
            │  1. Check open orders        │
            │     - Any fills? → process    │
            │     - Cancel if stopped       │
            └──────────────────────────────┘
                           │
                           ▼
            ┌──────────────────────────────┐
            │  2. If no open buy orders:    │
            │     - Generate grid levels    │
            │     - Place limit buy orders  │
            └──────────────────────────────┘
                           │
                           ▼
            ┌──────────────────────────────┐
            │  3. Process filled buys:     │
            │     - Calculate sell price   │
            │     - Place limit sell order │
            └──────────────────────────────┘
                           │
                           ▼
            ┌──────────────────────────────┐
            │  4. Process filled sells:     │
            │     - Record in completed     │
            │     - Update stats            │
            │     - If NOT auto-end:        │
            │       → recreate buy orders   │
            │     - If auto-end & budget    │
            │       depleted → mark done    │
            └──────────────────────────────┘
```

---

## Initial Supported Cryptos

| Symbol | Name | Suggested Grid |
|--------|------|-----------------|
| ETHUSDT | Ethereum | $5 spacing |
| BTCUSDT | Bitcoin | $50 spacing |
| LTCUSDT | Litecoin | $2 spacing |

---

## Future Enhancements (Phase 2+)

- [ ] Trailing stop loss
- [ ] Dynamic grid spacing based on volatility
- [ ] Multiple profit targets (scalping)
- [ ] Paper trading mode
- [ ] Email/SMS notifications on trade completion
- [ ] Export trades to CSV
- [ ] Telegram bot integration for alerts

---

## Mock Exchange (Local Testing)

### Purpose
A local mock Binance API server that simulates exchange behavior for testing the bot without using real funds.

### Features
- Simulates all Binance API endpoints
- **Manual price control** — you can set/freeze prices for any symbol
- **Order simulation** — instantly fill, or delay-fill limit orders
- **Error simulation** — test rate limits, API errors
- **State persistence** — remembers open orders across restarts (JSON file)

### Controls (Web UI)

```
┌─────────────────────────────────────────────┐
│  MOCK EXCHANGE CONTROLS              [ON/OFF]│
├─────────────────────────────────────────────┤
│  Current Prices (Live)                      │
│  ETHUSDT: $[2500.00] [Set] [Freeze 🔒]     │
│  BTCUSDT: $[45000.00] [Set] [Freeze 🔒]    │
│  LTCUSDT: $[75.00] [Set] [Freeze 🔒]       │
├─────────────────────────────────────────────┤
│  Price Simulator                            │
│  Symbol: [ETHUSDT ▼]                        │
│  Mode: [📈 Spike ▼]  Amount: $[200]         │
│  Duration: [10 sec]   [Run Simulation]     │
├─────────────────────────────────────────────┤
│  Open Orders (Mock Exchange)                │
│  - No open orders                           │
└─────────────────────────────────────────────┘
```

### Simulation Modes

| Mode | Description |
|------|-------------|
| Spike | Price jumps up by amount, then returns |
| Drop | Price drops by amount, then returns |
| Trend | Continuous movement in one direction |
| Volatile | Random up/down within range |
| Static | Hold at exact price |

### API Endpoints (Mock)

```
GET  /api/mock/price/:symbol      - Get current mock price
POST /api/mock/price/:symbol      - Set mock price
POST /api/mock/simulate           - Run price simulation
GET  /api/mock/orders             - List mock open orders
POST /api/mock/orders/:id/fill    - Force-fill an order
DELETE /api/mock/orders/:id       - Cancel order
```

### Switching Modes

In `.env`:
```
# Use real Binance
EXCHANGE_MODE=production

# Use mock exchange
EXCHANGE_MODE=mock
```

Or toggle via web UI without restart.

---

## Emergency Drop Protection (Reverse Profit Mode)

### Feature Overview

When enabled, this feature allows the bot to "pivot" during significant price drops instead of waiting for the price to recover to your original sell target.

### How It Works

**Trigger Condition:**
- Price drops more than 5% below the lowest pending sell order's buy price
- Feature must be enabled (flag on strategy)

**Example Scenario:**
```
Original setup:
- Buy order filled @ $1,995
- Pending sell order created @ $2,014.95 (1% profit)

Price drops to $1,800 (9.8% below $1,995)

With Emergency Drop Protection ON:
1. Cancel pending sell order ($2,014.95) — remember target
2. Sell ETH at current price ($1,800) — or next grid level ($1,805)
3. When sell completes → create buy order at +1% ($1,818)
4. When buy fills → create sell order at +1% ($1,836.18)
5. When that completes → recreate ORIGINAL pending sell ($2,014.95)
6. Resume normal cycle
```

### Database Extension

```sql
-- Add to trading_strategies table
emergency_drop_enabled BOOLEAN DEFAULT FALSE,
emergency_drop_percent REAL DEFAULT 5.0,  -- trigger threshold %
emergency_drop_max_orders INTEGER DEFAULT 0,  -- 0 = all, or limit (e.g., 5 of 10)
emergency_drop_active BOOLEAN DEFAULT FALSE,  -- is currently in reverse mode
original_sell_price REAL,  -- the cancelled sell we need to recreate
borrowed_quantity REAL,    -- how much ETH is "on loan"
```

### New Fields in Web UI

- Toggle: "Enable Emergency Drop Protection"
- Input: "Drop Threshold %" (default 5%)
- Status indicator: Shows when in "Reverse Profit" mode

### Reverse Profit Mode Flow

```
Price drops > 5% below pending sell's buy price
           │
           ▼
Cancel pending sell order (remember target)
           │
           ▼
Sell ETH at current price (or next grid level)
           │
           ▼
Create "replacement" buy order at +profit%
           │
           ▼
When replacement buy fills → create sell at +profit%
           │
           ▼
When replacement cycle completes
           │
           ▼
Recreate ORIGINAL cancelled sell order
           │
           ▼
Return to normal cycle
```

### Edge Cases

1. **Multiple pending sells**: Use the lowest one as reference
2. **Already in reverse mode**: Don't trigger again until normal
3. **Insufficient balance**: Skip if can't execute the pivot
4. **Manual intervention**: If user cancels the strategy during reverse mode, handle gracefully

---

## Acceptance Criteria

1. ✅ Can create strategy with custom parameters
2. ✅ Can add/remove strategies from visible list
3. ✅ Bot automatically places buy limit orders at grid levels
4. ✅ Bot automatically places sell limit orders when buys fill
5. ✅ Bot records completed trades with profit
6. ✅ Bot recreates buy orders after sells complete (unless stopped)
7. ✅ Can pause/resume individual strategies
8. ✅ Can stop strategy and cancel all open orders
9. ✅ Auto-end works when budget depleted (if enabled)
10. ✅ Multiple strategies can run simultaneously