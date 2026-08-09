#!/bin/bash
# ------------------------------------------------------------------
# Installs a daily backup cron job for R2 Storage Platform data.
# Data lives in /var/lib/r2storage (SQLite DB + all object blobs).
#
# Usage (from the repo root on the VPS):
#   sudo bash deploy/backup-cron.sh [data_dir]
# ------------------------------------------------------------------
set -e

R2_DATA="${1:-/var/lib/r2storage}"
BACKUP_DIR="/var/backups/r2storage"
BIN="/usr/local/sbin/r2storage-backup.sh"

echo "📦 Setting up daily backups for $R2_DATA -> $BACKUP_DIR"

sudo mkdir -p "$BACKUP_DIR"

sudo tee "$BIN" >/dev/null <<EOF
#!/bin/bash
set -e
mkdir -p "$BACKUP_DIR"
tar czf "$BACKUP_DIR/r2storage-\$(date +%F).tar.gz" "$R2_DATA"
find "$BACKUP_DIR" -name 'r2storage-*.tar.gz' -mtime +14 -delete
EOF
sudo chmod 700 "$BIN"

# Idempotent: remove any previous install line, then append ours.
( sudo crontab -l 2>/dev/null | grep -v 'r2storage-backup.sh' ; echo "0 3 * * * $BIN" ) | sudo crontab -

echo "✅ Installed backup cron: $BIN (daily 03:00, 14-day retention)"
echo "   Test now: sudo $BIN"
echo "   Restore:  tar xzf /var/backups/r2storage/r2storage-*.tar.gz -C /"
