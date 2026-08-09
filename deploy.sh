#!/bin/bash
# ------------------------------------------------------------------
# Native deployment script for R2 Storage Platform on a Linux VPS.
# Node.js (systemd) + nginx, using the existing Cloudflare origin cert.
#
# Run from the repo root on the VPS:
#   chmod +x deploy.sh && ./deploy.sh
# ------------------------------------------------------------------

set -e
cd "$(dirname "$0")"

R2_USER="${R2_USER:-r2storage}"
R2_DIR="/opt/r2storage"
R2_DATA="/var/lib/r2storage"
R2_ENV="/etc/r2storage/env"

# Optional flags:  ./deploy.sh --smoke --backups
#   --smoke    run the full smoke suite (throwaway instance, prod untouched)
#   --backups  install the daily backup cron job
RUN_SMOKE=0
INSTALL_BACKUPS=0
for arg in "$@"; do
    case "$arg" in
        --smoke) RUN_SMOKE=1 ;;
        --backups) INSTALL_BACKUPS=1 ;;
    esac
done

echo "🚀 Deploying R2 Storage Platform (native, nginx)..."

# 0. Reload a previously persisted env (keeps ADMIN_SECRET across redeploys),
#    but a BASE_DOMAIN passed on the CLI wins over the persisted one.
BASE_DOMAIN_ARG="${BASE_DOMAIN:-}"
if [ -f "$R2_ENV" ]; then
    set -a; . "$R2_ENV"; set +a
fi
BASE_DOMAIN="${BASE_DOMAIN_ARG:-${BASE_DOMAIN:-ahmedadil.me}}"

# 1. Ensure Node 20 LTS
if ! command -v node &> /dev/null; then
    echo "📦 Installing Node 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
    sudo apt-get install -y nodejs
else
    NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
        echo "⚠️  Node $NODE_MAJOR found — installing Node 20 LTS..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
        sudo apt-get install -y nodejs
    fi
fi

# 2. Copy the application into place
echo "📋 Copying application to $R2_DIR ..."
sudo mkdir -p "$R2_DIR"
if command -v rsync &> /dev/null; then
    sudo rsync -a --delete \
        --exclude '.git' \
        --exclude 'node_modules' \
        --exclude 'dist' \
        --exclude '.codegraph' \
        --exclude '.env' \
        --exclude 'data' \
        --exclude '*.db' \
        --exclude '.DS_Store' \
        ./ "$R2_DIR/"
else
    sudo cp -r ./ "$R2_DIR/"
fi
# Let the current user build; ownership is handed to the service user later
sudo chown -R "$(id -un)" "$R2_DIR"

# 3. Install dependencies and build backend + frontend
echo "⚡ Building backend and frontend..."
(cd "$R2_DIR/backend" && npm install --no-fund --no-audit && npm run build)
(cd "$R2_DIR/frontend" && npm install --no-fund --no-audit && npm run build)

# Serve the dashboard from the backend (same layout the container used)
mkdir -p "$R2_DIR/backend/dist/public"
cp -R "$R2_DIR/frontend/dist/." "$R2_DIR/backend/dist/public/"

# 3b. Optional: full smoke suite against a throwaway instance (isolated DB +
#     storage dir + port — never touches the production service).
if [ "$RUN_SMOKE" = "1" ]; then
    echo "🧪 Running smoke suite..."
    (cd "$R2_DIR" && bash scripts/smoke.sh)
    echo "✅ Smoke suite passed."
fi

# 4. Data directory + dedicated service user
echo "🛠  Preparing data directory and service user..."
sudo mkdir -p "$R2_DATA/storage_blobs"
if ! id -u "$R2_USER" &> /dev/null; then
    sudo useradd --system --home "$R2_DIR" --shell /usr/sbin/nologin "$R2_USER"
fi
# Hand ownership of the app + data to the service user (keeps the build dirs readable)
sudo chown -R "$R2_USER:$R2_USER" "$R2_DIR" "$R2_DATA"

# 5. Admin secret (generated once, persisted)
if [ -z "$ADMIN_SECRET" ]; then
    ADMIN_SECRET=$(openssl rand -hex 32)
    echo ""
    echo "🔐 Generated a new ADMIN_SECRET. Save this — you need it to log into the dashboard:"
    echo ""
    echo "    ADMIN_SECRET=$ADMIN_SECRET"
    echo ""
fi

sudo mkdir -p /etc/r2storage
printf 'PORT=4000\nHOST=127.0.0.1\nDATABASE_URL=file:%s/storage.db\nSTORAGE_DIR=%s/storage_blobs\nADMIN_SECRET=%s\nBASE_DOMAIN=%s\n' \
    "$R2_DATA" "$R2_DATA" "$ADMIN_SECRET" "$BASE_DOMAIN" | sudo tee "$R2_ENV" >/dev/null
sudo chmod 600 "$R2_ENV"

# 6. Install and start the systemd service
echo "⚙️  Installing systemd service..."
sudo cp deploy/r2storage.service /etc/systemd/system/r2storage.service
sudo systemctl daemon-reload
sudo systemctl enable --now r2storage
sudo systemctl restart r2storage

# 6b. Health check (wait up to 30s for the app to come up)
echo "🧪 Checking backend health..."
OK=""
for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:4000/health" >/dev/null 2>&1; then OK=1; break; fi
    sleep 1
done
if [ -z "$OK" ]; then
    echo "❌ Backend did not become healthy. Check: journalctl -u r2storage -e"
    exit 1
fi
echo "✅ Backend is healthy."

# 7. Install the nginx site
if ! command -v nginx &> /dev/null; then
    echo "🌐 Installing nginx..."
    sudo apt-get install -y nginx
fi
echo "🌐 Installing nginx site (Base domain: $BASE_DOMAIN)..."
sudo cp deploy/nginx-r2storage.conf /etc/nginx/sites-available/r2storage
sudo sed -i "s/__DOMAIN__/$BASE_DOMAIN/g" /etc/nginx/sites-available/r2storage
if [ ! -e /etc/nginx/sites-enabled/r2storage ]; then
    sudo ln -s /etc/nginx/sites-available/r2storage /etc/nginx/sites-enabled/r2storage
fi
sudo nginx -t
sudo systemctl reload nginx

# 8. Optional: daily backup cron
if [ "$INSTALL_BACKUPS" = "1" ]; then
    echo "📦 Installing backup cron..."
    sudo bash deploy/backup-cron.sh "$R2_DATA"
fi

echo ""
echo "✅ R2 Storage Platform deployed natively."
echo "🌐 Dashboard: https://panel.$BASE_DOMAIN    CDN: https://cdn.$BASE_DOMAIN"
echo "💾 Data (backup this folder): $R2_DATA"
echo ""
echo "🧾 Remaining to do on your side:"
echo "  1. Cloudflare origin cert covering $BASE_DOMAIN + *.$BASE_DOMAIN"
echo "     at /etc/ssl/cloudflare/$BASE_DOMAIN.{pem,key} (or edit the nginx site)."
echo "  2. DNS A records (proxied): cdn.$BASE_DOMAIN and panel.$BASE_DOMAIN -> this VPS IP."
echo "  3. Cloudflare SSL/TLS mode: Full (strict)."
echo ""
echo "🔁 Restart app: systemctl restart r2storage | nginx: systemctl reload nginx"
