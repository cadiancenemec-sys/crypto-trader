#!/bin/bash
# Production environment startup script
# Runs on port 3004 with clean/empty database

cd "$(dirname "$0")/backend/src"

export PORT=3004
export DB_PATH='../../data-prod/crypto-bot.db'
export DATA_DIR='../../data-prod'
export NODE_ENV=production

# Clear previous prod data for fresh start
rm -f ../../data-prod/*.json ../../data-prod/*.db 2>/dev/null

# Create empty initial files
echo '[]' > ../../data-prod/strategies.json
echo '[]' > ../../data-prod/completed-trades.json
echo '{}' > ../../data-prod/mock-exchange-state.json

echo "Starting Production environment on port $PORT"
node index.js