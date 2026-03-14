# Crypto Bot - Design Document

## Overview
Automated cryptocurrency trading bot with real-time monitoring and trade execution capabilities.

## Architecture

### Core Components

#### 1. Core Backend (`backend/`)
- **Main Process**: Long-running Node.js process with internal timers
- **Responsibilities**:
  - Trade strategy execution
  - Timer management for scheduled tasks
  - Coordinating all modules
  - Trade logic and decision making
- **Run mode**: Background service/daemon

#### 2. API Adapter (`api-adapter/`)
- **Responsibilities**:
  - Exchange API connections (Coinbase, Binance, etc.)
  - Rate limiting (respect API quotas)
  - Order execution (market, limit, stop-loss)
  - Fetching price data, balances, order books
- **Communication**: Internal function calls or IPC to backend

#### 3. WebSocket Server (`ws-server/`)
- **Responsibilities**:
  - Real-time bidirectional communication
  - Push trade updates to frontend
  - Receive commands from frontend (manual trades, config changes)
  - Optional: Bridge to external APIs if decoupled
- **Port**: Configurable (default: 8080)

#### 4. Database (`db/`)
- **Technology**: SQLite
- **Rationale**: More robust than JSON, atomic writes, queryable history
- **Tables**:
  - `trades` - executed trades
  - `orders` - pending/open orders
  - `config` - bot configuration
  - `price_history` - OHLCV data for analytics
  - `audit_log` - all actions for debugging

#### 5. Frontend (`frontend/`)
- **Type**: Web dashboard
- **Connection**: WebSocket for real-time updates
- **Features**:
  - Live trade monitoring
  - Pending orders view
  - Manual trade execution
  - Historical trade analysis
  - Configuration management

### Data Flow

```
Exchange API ←→ API Adapter ←→ Core Backend ←→ SQLite DB
                                      ↓
                              WebSocket Server → Frontend Dashboard
```

## Tech Stack Recommendation

- **Backend**: Node.js (JavaScript/TypeScript)
- **Database**: SQLite (via better-sqlite3 or sql.js)
- **WebSocket**: ws (Node.js) or Socket.io
- **Frontend**: React, Vue, or plain HTML/JS with WebSocket client
- **Exchange APIs**: ccxt library (unified crypto exchange API)

## Configuration

All config via `config.json` or environment variables:
- API keys for exchanges
- Trade parameters (max position, stop-loss %, etc.)
- WebSocket port
- Database path

## Security Considerations

- Store API keys encrypted or in environment variables (not in repo)
- Implement API key read-only mode for monitoring-only deployments
- Audit log all trade decisions and executions