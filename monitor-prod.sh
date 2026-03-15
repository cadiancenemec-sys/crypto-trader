#!/bin/bash
# Monitor production bot - restart if not running

LOG_FILE="/home/amelia/.openclaw/workspace/crypto-bot/monitor-prod.log"
BOT_DIR="/home/amelia/.openclaw/workspace/crypto-bot"
PORT=3004
MAX_FAILURES=3
ALERT_FILE="/tmp/bot-alert.txt"
FAILURE_COUNT_FILE="/tmp/bot-failure-count"

# Check if port is in use and responding
if lsof -i :$PORT > /dev/null 2>&1; then
    # Port is in use, check if it's responding
    if curl -s --max-time 5 http://localhost:$PORT/api/dca/status > /dev/null 2>&1; then
        echo "$(date): Bot is running on port $PORT" >> $LOG_FILE
        # Reset failure count on success
        rm -f $FAILURE_COUNT_FILE
        rm -f $ALERT_FILE
        exit 0
    fi
fi

# Bot is not running or not responding
echo "$(date): Bot NOT running on port $PORT, attempting restart..." >> $LOG_FILE

# Kill any existing processes on the port
lsof -ti :$PORT | xargs kill -9 2>/dev/null

sleep 1

# Start the bot
cd $BOT_DIR
bash start-prod.sh >> $LOG_FILE 2>&1 &

# Wait a bit and check if it started
sleep 3

if curl -s --max-time 5 http://localhost:$PORT/api/dca/status > /dev/null 2>&1; then
    echo "$(date): Bot restarted successfully" >> $LOG_FILE
    rm -f $FAILURE_COUNT_FILE
    rm -f $ALERT_FILE
else
    echo "$(date): Bot FAILED to restart!" >> $LOG_FILE
    
    # Track consecutive failures
    FAILURES=$(($(cat $FAILURE_COUNT_FILE 2>/dev/null || echo 0) + 1))
    echo $FAILURES > $FAILURE_COUNT_FILE
    
    echo "$(date): FAILURE #$FAILURES of $MAX_FAILURES" >> $LOG_FILE
    
    # Create alert file after max failures
    if [ $FAILURES -ge $MAX_FAILURES ]; then
        echo "$(date): ALERT - Bot failed to restart $MAX_FAILURES times in a row!" >> $LOG_FILE
        echo "ALERT: Production bot on port $PORT failed to restart $FAILURES times. Check $(hostname):$LOG_FILE" > $ALERT_FILE
    fi
fi