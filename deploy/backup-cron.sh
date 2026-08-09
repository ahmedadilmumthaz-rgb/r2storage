#!/bin/bash
# ------------------------------------------------------------------
# Installs a daily backup cron job for an R2 Storage instance.
# Data lives in the instance's data dir (SQLite DB + all object blobs).
#
# Usage (from the repo root on the VPS):
#   sudo bash deploy/backup-cron.sh [data_dir] [name]
#     data_dir  instance data folder (default /var/lib/r2storage)
#     name      instance name (default r2storage); keys the backup script +
#               cron line so multiple instances can each have their own job
# ------------------------------------------------------------------
set -e

R2_DATA="${1:-/var/lib/r2storage}"
NAME="${2:-r2storage}"
BACKUP_DIR="/var/backups/r2storage/$NAME"
BIN="/usr/local/sbin/r2storage-backup-$NAME.sh"

echo "📦 Setting up daily backups for $R2_DATA -> $BACKUP_DIR"

sudo mkdir -p "$BACKUP_DIR"

sudo tee "$BIN" >/dev/null <<EOF
#!/bin/bash
set -e
mkdir -p "$BACKUP_DIR"
tar czf "$BACKUP_DIR/$NAME-\$(date +%F).tar.gz" "$R2_DATA"
find "$BACKUP_DIR" -name '$NAME-*.tar.gz' -mtime +14 -delete
EOF
sudo chmod 700 "$BIN"

# Idempotent: remove any previous install line for THIS instance, then append.
( sudo crontab -l 2>/dev/null | grep -v "r2storage-backup-$NAME.sh" ; echo "0 3 * * * $BIN" ) | sudo crontab -

echo "✅ Installed backup cron: $BIN (daily 03:00, 14-day retention)"
echo "   Test now: sudo $BIN"
echo "   Restore:  tar xzf $BACKUP_DIR/$NAME-*.tar.gz -C /"
