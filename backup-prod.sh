#!/bin/bash
# Production data backup script
# Creates timestamped backup and purges old backups (keeps 5 most recent, deletes >30 days)

BACKUP_DIR="/home/amelia/.openclaw/workspace/crypto-bot"
DATA_DIR="$BACKUP_DIR/data-prod"
BACKUP_PREFIX="$BACKUP_DIR/production backup"

# Create timestamp
TIMESTAMP=$(date +"%Y-%m-%d %H:%M")

# Create new backup directory
mkdir -p "$BACKUP_PREFIX $TIMESTAMP"

# Copy production data files
cp -r "$DATA_DIR/"* "$BACKUP_PREFIX $TIMESTAMP/" 2>/dev/null

echo "Backup created: production backup $TIMESTAMP"

# Purge old backups
# Keep at least 5 backups, only delete if older than 30 days AND would still have 5+ remaining
cd "$BACKUP_DIR"
ALL_BACKUPS=$(ls -td "production backup "*/ 2>/dev/null)
TOTAL=$(echo "$ALL_BACKUPS" | wc -l)
echo "Total backups: $TOTAL"

# Only purge if we have more than 5
if [ $TOTAL -gt 5 ]; then
    # Calculate how many we can safely delete (must keep at least 5)
    SAFE_TO_DELETE=$((TOTAL - 5))
    
    # Get oldest backups and check their age
    COUNT=0
    for dir in $ALL_BACKUPS; do
        DIR_DATE=$(echo "$dir" | sed 's/production backup //' | sed 's/\/$//')
        DIR_EPOCH=$(date -d "$DIR_DATE" +%s 2>/dev/null)
        CURRENT_EPOCH=$(date +%s)
        DAYS_OLD=$(( (CURRENT_EPOCH - DIR_EPOCH) / 86400 ))
        
        # Only delete if: older than 30 days AND we haven't exceeded safe delete count
        if [ $DAYS_OLD -gt 30 ] && [ $COUNT -lt $SAFE_TO_DELETE ]; then
            echo "Deleting old backup: $dir (${DAYS_OLD} days old)"
            rm -rf "$dir"
            COUNT=$((COUNT + 1))
        fi
    done
fi

echo "Backup complete. Current backups:"
ls -td "production backup "*/