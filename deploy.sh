#!/bin/bash
# ------------------------------------------------------------------
# Native (baremetal) deployment for R2 Storage on a Linux VPS.
# Node.js (systemd) + nginx, using your existing Cloudflare origin cert.
#
# Each run installs ONE instance, named by INSTANCE, so you can co-locate
# several project instances on a single VPS:
#
#   INSTANCE=project1 BASE_DOMAIN=project1.com PORT=4000 ./deploy.sh
#   INSTANCE=project2 BASE_DOMAIN=project2.com PORT=4001 ./deploy.sh
#
# (Each project needs its own domain: the origin cert must cover
# BASE_DOMAIN + *.BASE_DOMAIN — a Cloudflare origin cert only covers the apex
# plus ONE wildcard level, so cdn.project1.com works but cdn.project1.example.com
# would not be covered by a cert for example.com + *.example.com.)
#
# Or a single shared instance behind one CDN host (one bucket per project):
#
#   BASE_DOMAIN=example.com ./deploy.sh     # cdn./panel./*.example.com
#
# Re-running the same INSTANCE reuses its persisted ADMIN_SECRET/ports and
# upgrades in place. Optional flags: --smoke (throwaway test) --backups (cron).
#
# Run from the repo root on the VPS.
# ------------------------------------------------------------------

set -e
cd "$(dirname "$0")"

# INSTANCE names this deployment; everything else derives from it.
INSTANCE="${INSTANCE:-r2storage}"
R2_USER="${R2_USER:-$INSTANCE}"
R2_DIR="${R2_DIR:-/opt/$INSTANCE}"
R2_DATA="${R2_DATA:-/var/lib/$INSTANCE}"
R2_ENV="${R2_ENV:-/etc/$INSTANCE/env}"

# Optional flags
RUN_SMOKE=0
INSTALL_BACKUPS=0
for arg in "$@"; do
    case "$arg" in
        --smoke) RUN_SMOKE=1 ;;
        --backups) INSTALL_BACKUPS=1 ;;
    esac
done

echo "🚀 Deploying R2 Storage instance '$INSTANCE'..."

# 0. Reload a previously persisted env (keeps ADMIN_SECRET/ports across
#    redeploys), but a BASE_DOMAIN/PORT passed on the CLI wins.
BASE_DOMAIN_ARG="${BASE_DOMAIN:-}"
PORT_ARG="${PORT:-}"
if [ -f "$R2_ENV" ]; then
    set -a; . "$R2_ENV"; set +a
fi
BASE_DOMAIN="${BASE_DOMAIN_ARG:-${BASE_DOMAIN:-ahmedadil.me}}"
PORT="${PORT_ARG:-${PORT:-4000}}"

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
#     storage dir + port — never touches the deployed service).
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

# 5. Admin secret (generated once, persisted per instance)
if [ -z "$ADMIN_SECRET" ]; then
    ADMIN_SECRET=$(openssl rand -hex 32)
    echo ""
    echo "🔐 Generated a new ADMIN_SECRET for instance '$INSTANCE'. Save this — you need it to log into the dashboard:"
    echo ""
    echo "    ADMIN_SECRET=$ADMIN_SECRET"
    echo ""
fi

sudo mkdir -p "/etc/$INSTANCE"
printf 'PORT=%s\nHOST=127.0.0.1\nDATABASE_URL=file:%s/storage.db\nSTORAGE_DIR=%s/storage_blobs\nADMIN_SECRET=%s\nBASE_DOMAIN=%s\n' \
    "$PORT" "$R2_DATA" "$R2_DATA" "$ADMIN_SECRET" "$BASE_DOMAIN" | sudo tee "$R2_ENV" >/dev/null
sudo chmod 600 "$R2_ENV"

# 6. Install and start the systemd service (rendered from the unit template)
echo "⚙️  Installing systemd service '$INSTANCE'..."
sudo sed -e "s|__INSTANCE__|$INSTANCE|g" \
         -e "s|__USER__|$R2_USER|g" \
         -e "s|__DIR__|$R2_DIR|g" \
         -e "s|__ENV__|$R2_ENV|g" \
         -e "s|__DATA__|$R2_DATA|g" \
         deploy/r2storage.service | sudo tee "/etc/systemd/system/$INSTANCE.service" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now "$INSTANCE"
sudo systemctl restart "$INSTANCE"

# 6b. Health check (wait up to 30s for the app to come up)
echo "🧪 Checking instance health on :$PORT..."
OK=""
for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then OK=1; break; fi
    sleep 1
done
if [ -z "$OK" ]; then
    echo "❌ Instance '$INSTANCE' did not become healthy on :$PORT. Check: journalctl -u $INSTANCE -e"
    exit 1
fi
echo "✅ Instance is healthy."

# 7. Install the nginx site (one per instance; upstream keyed by port)
if ! command -v nginx &> /dev/null; then
    echo "🌐 Installing nginx..."
    sudo apt-get install -y nginx
fi
echo "🌐 Installing nginx site for $BASE_DOMAIN (instance '$INSTANCE')..."
sudo cp deploy/nginx-r2storage.conf "/etc/nginx/sites-available/$INSTANCE"
sudo sed -i "s/__DOMAIN__/$BASE_DOMAIN/g; s/__PORT__/$PORT/g" "/etc/nginx/sites-available/$INSTANCE"
if [ ! -e "/etc/nginx/sites-enabled/$INSTANCE" ]; then
    sudo ln -s "/etc/nginx/sites-available/$INSTANCE" "/etc/nginx/sites-enabled/$INSTANCE"
fi
sudo nginx -t
sudo systemctl reload nginx

# 8. Optional: daily backup cron (one per instance data dir)
if [ "$INSTALL_BACKUPS" = "1" ]; then
    echo "📦 Installing backup cron..."
    sudo bash deploy/backup-cron.sh "$R2_DATA" "$INSTANCE"
fi

echo ""
echo "✅ Instance '$INSTANCE' deployed."
echo "🌐 Dashboard: https://panel.$BASE_DOMAIN    CDN: https://cdn.$BASE_DOMAIN"
echo "💾 Data (backup this folder): $R2_DATA"
echo ""
if [ "$INSTANCE" = "r2storage" ]; then
    echo "🧾 Remaining to do on your side:"
    echo "  1. Cloudflare origin cert covering $BASE_DOMAIN + *.$BASE_DOMAIN"
    echo "     at /etc/ssl/cloudflare/$BASE_DOMAIN.{pem,key} (or edit the nginx site)."
    echo "  2. DNS A records (proxied): cdn.$BASE_DOMAIN and panel.$BASE_DOMAIN -> this VPS IP."
    echo "  3. Cloudflare SSL/TLS mode: Full (strict)."
    echo ""
    echo "➡️  More instances on this box: INSTANCE=project2 BASE_DOMAIN=project2.com PORT=4001 ./deploy.sh"
fi
echo "🔁 Restart: systemctl restart $INSTANCE | nginx: systemctl reload nginx"
