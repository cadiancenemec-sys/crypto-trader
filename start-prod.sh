#!/bin/bash
# Production environment startup script
# Runs on port 3004 with existing data

cd "$(dirname "$0")"

# Load environment variables from root .env
set -a
source .env
set +a

cd backend/src

export PORT=3004
export USE_MOCK=false
export DB_PATH='../../data-prod/crypto-bot.db'
export DATA_DIR='../../data-prod'
export NODE_ENV=production
export BINANCE_API_KEY
export BINANCE_API_SECRET

# NOTE: Do NOT clear data on restart - the bot tracks orders by orderId
# If you need a fresh start, manually delete files in data-prod/
# rm -f ../../data-prod/*.json ../../data-prod/*.db 2>/dev/null

# Ensure data files exist (if not already present)
[ ! -f ../../data-prod/strategies.json ] && echo '[]' > ../../data-prod/strategies.json
[ ! -f ../../data-prod/completed-trades.json ] && echo '[]' > ../../data-prod/completed-trades.json
[ ! -f ../../data-prod/mock-exchange-state.json ] && echo '{}' > ../../data-prod/mock-exchange-state.json

echo "Starting Production environment on port $PORT"
node index.js