#!/bin/bash
# ------------------------------------------------------------------
# Deploys the R2 Storage Platform (Next.js control plane) on a Linux VPS.
# Installs under /opt/r2platform with its own env, SQLite DB, and systemd
# unit, plus the multi-tenant nginx site and initial host map.
#
# Run from the repo root on the VPS:
#   chmod +x deploy/platform-deploy.sh
#   PLATFORM_DOMAIN=r2platform.com \
#   OPERATOR_EMAIL=ops@r2platform.com \
#   OPERATOR_PASSWORD='a-strong-password' \
#   sudo bash deploy/platform-deploy.sh
#
# Re-runnable: secrets are persisted in /etc/r2platform/env and kept across
# redeploys unless overridden on the command line.
# ------------------------------------------------------------------

set -e
cd "$(dirname "$0")/.."

PLATFORM_USER="${PLATFORM_USER:-r2platform}"
PLATFORM_DIR="/opt/r2platform"
PLATFORM_DATA="/var/lib/r2platform"
PLATFORM_ENV="/etc/r2platform/env"
TENANT_STORAGE_BASE="${TENANT_STORAGE_BASE:-/srv/r2storage/tenants}"
NGINX_MAP="/etc/nginx/r2storage-map.conf"

# --- Persisted env is the default; explicit CLI vars win -----------------
if [ -f "$PLATFORM_ENV" ]; then
    set -a; . "$PLATFORM_ENV"; set +a
fi
PLATFORM_DOMAIN="${PLATFORM_DOMAIN:-r2platform.com}"
OPERATOR_EMAIL="${OPERATOR_EMAIL:-ops@${PLATFORM_DOMAIN}}"

echo "🚀 Deploying R2 Storage Platform (control plane, port 4000)..."

# 1. Node 20 + Docker + nginx
if ! command -v node &> /dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
    echo "📦 Installing Node 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
if ! command -v docker &> /dev/null; then
    echo "🐳 Installing Docker (needed to run tenant containers)..."
    curl -fsSL https://get.docker.com | bash -
fi
if ! command -v nginx &> /dev/null; then
    echo "🌐 Installing nginx..."
    apt-get install -y nginx
fi

# 2. Copy the control plane into place (never the tenant DB, blobs, or .env)
echo "📋 Copying platform to $PLATFORM_DIR ..."
mkdir -p "$PLATFORM_DIR"
if command -v rsync &> /dev/null; then
    rsync -a --delete \
        --exclude '.git' \
        --exclude 'node_modules' \
        --exclude '.next' \
        --exclude '.codegraph' \
        --exclude '.env' \
        --exclude 'data' \
        --exclude '*.db' \
        --exclude '.DS_Store' \
        ./ "$PLATFORM_DIR/"
else
    cp -r ./ "$PLATFORM_DIR/"
fi

# 3. Install deps, apply schema, seed plans, build
echo "⚡ Building control plane..."
(cd "$PLATFORM_DIR/platform" && npm install --no-fund --no-audit)
export DATABASE_URL="file:${PLATFORM_DATA}/r2platform.db"
(cd "$PLATFORM_DIR/platform" && npx prisma db push && npx prisma generate && npx tsx prisma/seed.ts && npm run build)

# 4. Data dirs
echo "🛠  Preparing data directories..."
mkdir -p "$PLATFORM_DATA" "$TENANT_STORAGE_BASE"

# 5. Operator password hash (only if no hash was supplied/persisted)
if [ -z "$OPERATOR_PASSWORD_HASH" ]; then
    if [ -n "${OPERATOR_PASSWORD:-}" ]; then
        OPERATOR_PASSWORD_HASH="$(node -e "console.log(require('bcryptjs').hashSync(process.argv[1],12))" "$OPERATOR_PASSWORD")"
    else
        echo "❌ Set OPERATOR_PASSWORD (or pass OPERATOR_PASSWORD_HASH) for the operator login." >&2
        exit 1
    fi
fi

# 6. Secrets generated once and persisted
[ -n "$PLATFORM_MASTER_KEY" ]   || PLATFORM_MASTER_KEY="$(openssl rand -hex 32)"
[ -n "$METER_KEY" ]             || METER_KEY="$(openssl rand -hex 32)"

echo "✍️  Writing $PLATFORM_ENV (chmod 600)..."
mkdir -p /etc/r2platform
printf '%s\n' \
    "NODE_ENV=production" \
    "PORT=4000" \
    "HOSTNAME=127.0.0.1" \
    "PLATFORM_DOMAIN=${PLATFORM_DOMAIN}" \
    "PLATFORM_BASE_URL=${PLATFORM_BASE_URL:-https://panel.${PLATFORM_DOMAIN}}" \
    "PLATFORM_MASTER_KEY=${PLATFORM_MASTER_KEY}" \
    "SESSION_TTL_HOURS=${SESSION_TTL_HOURS:-168}" \
    "DATABASE_URL=file:${PLATFORM_DATA}/r2platform.db" \
    "CF_API_TOKEN=${CF_API_TOKEN:-}" \
    "CF_ZONE_ID=${CF_ZONE_ID:-}" \
    "CF_FALLBACK_ORIGIN=${CF_FALLBACK_ORIGIN:-origin.${PLATFORM_DOMAIN}}" \
    "SMTP_HOST=${SMTP_HOST:-}" \
    "SMTP_PORT=${SMTP_PORT:-587}" \
    "SMTP_USER=${SMTP_USER:-}" \
    "SMTP_PASS=${SMTP_PASS:-}" \
    "SMTP_FROM=${SMTP_FROM:-R2 Storage <no-reply@${PLATFORM_DOMAIN}>}" \
    "STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY:-}" \
    "STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET:-}" \
    "STRIPE_PRICE_PRO=${STRIPE_PRICE_PRO:-}" \
    "TENANT_STORAGE_BASE=${TENANT_STORAGE_BASE}" \
    "R2_IMAGE=${R2_IMAGE:-r2storage:latest}" \
    "NGINX_MAP_FILE=${NGINX_MAP}" \
    "NGINX_RELOAD=${NGINX_RELOAD:-true}" \
    "TENANT_PORT_MIN=${TENANT_PORT_MIN:-41001}" \
    "TENANT_PORT_MAX=${TENANT_PORT_MAX:-41499}" \
    "MAX_INSTANCES_PER_CUSTOMER=${MAX_INSTANCES_PER_CUSTOMER:-1}" \
    "MAX_ACTIVE_INSTANCES=${MAX_ACTIVE_INSTANCES:-50}" \
    "OPERATOR_EMAIL=${OPERATOR_EMAIL}" \
    "OPERATOR_PASSWORD_HASH=${OPERATOR_PASSWORD_HASH}" \
    "METER_KEY=${METER_KEY}" \
    "METERING_INTERVAL_MS=${METERING_INTERVAL_MS:-3600000}" \
    > "$PLATFORM_ENV"
chmod 600 "$PLATFORM_ENV"

# 7. systemd
echo "⚙️  Installing systemd service..."
cp deploy/r2platform.service /etc/systemd/system/r2platform.service
systemctl daemon-reload
systemctl enable --now r2platform
systemctl restart r2platform

# 8. Health check (wait up to 60s)
echo "🧪 Checking control plane health..."
OK=""
for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:4000/api/health" >/dev/null 2>&1; then OK=1; break; fi
    sleep 1
done
if [ -z "$OK" ]; then
    echo "❌ Control plane did not become healthy. Check: journalctl -u r2platform -e" >&2
    exit 1
fi
echo "✅ Control plane is healthy."

# 9. Multi-tenant nginx site + initial host map (panel/origin -> 4000)
echo "🌐 Installing multi-tenant nginx site..."
cp deploy/nginx-multitenant.conf /etc/nginx/sites-available/r2storage-multitenant
sed -i "s/__DOMAIN__/$PLATFORM_DOMAIN/g" /etc/nginx/sites-available/r2storage-multitenant
if [ ! -e /etc/nginx/sites-enabled/r2storage-multitenant ]; then
    ln -s /etc/nginx/sites-available/r2storage-multitenant /etc/nginx/sites-enabled/r2storage-multitenant
fi
printf 'map $host $r2_tenant_port {\n    default 0;\n    "~^(%s|www\\.%s|panel\\.%s|origin\\.%s)$" 4000;\n}\n' \
    "$PLATFORM_DOMAIN" "$PLATFORM_DOMAIN" "$PLATFORM_DOMAIN" "$PLATFORM_DOMAIN" > "$NGINX_MAP"
nginx -t && systemctl reload nginx

# 10. Build the tenant image so provisioning works immediately
echo "🐳 Building tenant image..."
(cd "$PLATFORM_DIR" && docker build -t "$R2_IMAGE" -f backend/Dockerfile .)

echo ""
echo "✅ R2 Storage Platform deployed."
echo "🌐 Control plane: https://panel.$PLATFORM_DOMAIN"
echo "🔑 Operator login: $OPERATOR_EMAIL"
echo "🔐 METER_KEY: $METER_KEY"
echo "💾 Platform DB (backup): $PLATFORM_DATA"
echo ""
echo "🧾 Remaining to do on your side:"
echo "  1. Cloudflare origin cert covering $PLATFORM_DOMAIN + *.$PLATFORM_DOMAIN"
echo "     at /etc/ssl/cloudflare/$PLATFORM_DOMAIN.{pem,key}, SSL/TLS = Full (strict)."
echo "  2. DNS (proxied): panel.$PLATFORM_DOMAIN, origin.$PLATFORM_DOMAIN -> this VPS IP."
echo "     Each customer points their own subdomain/wildcard at the same IP."
echo "  3. Set CF_API_TOKEN/CF_ZONE_ID for SSL-for-SaaS auto custom hostnames;"
echo "     SMTP_* for real verification emails; STRIPE_* to enable billing."
echo "     Edit $PLATFORM_ENV and: systemctl restart r2platform"
echo "  4. Run the suite after deploy:"
echo "     PLATFORM_URL=https://panel.$PLATFORM_DOMAIN OPERATOR_EMAIL=$OPERATOR_EMAIL \\"
echo "       METER_KEY=$METER_KEY bash scripts/platform-smoke.sh"
echo ""
echo "🔁 Restart: systemctl restart r2platform | nginx: systemctl reload nginx"
