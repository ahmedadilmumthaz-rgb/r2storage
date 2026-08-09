#!/usr/bin/env bash
#
# tenant-run.sh — create/start one per-tenant r2storage container.
#
# Each tenant gets an isolated container with its own SQLite DB + blob volume,
# its own admin secret / base domain, a loopback-published port (never exposed
# publicly — nginx routes by Host header), and resource limits. Idempotent:
# re-running with the same TENANT_ID removes and recreates the container.
#
# Usage:
#   TENANT_ID=<id> DOMAIN=<customer-domain> PORT=<41001-41499> \
#     [ADMIN_SECRET=<secret>] [STORAGE_BASE=/srv/r2storage/tenants] \
#     [STORAGE_QUOTA_BYTES=<bytes>] \
#     bash deploy/tenant-run.sh
#
# Prints the container id. Env is validated with 'set -eu' — all required
# variables must be set (provisioning scripts set them).

set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${R2_IMAGE:-r2storage:latest}"

: "${TENANT_ID:?TENANT_ID is required}"
: "${DOMAIN:?DOMAIN is required}"
: "${PORT:?PORT is required}"
STORAGE_BASE="${STORAGE_BASE:-/srv/r2storage/tenants}"

# Generate a strong admin secret unless one was supplied.
if [ -z "${ADMIN_SECRET:-}" ]; then
  ADMIN_SECRET="$(openssl rand -hex 32)"
fi

# Validate the published port is inside the reserved tenant range.
if [ "$PORT" -lt 41001 ] || [ "$PORT" -gt 41499 ]; then
  echo "error: PORT must be within 41001-41499" >&2
  exit 1
fi

NAME="r2storage-$TENANT_ID"
VOL="$STORAGE_BASE/$TENANT_ID/data"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "== building image $IMAGE =="
  docker build -t "$IMAGE" -f "$ROOT/backend/Dockerfile" "$ROOT"
fi

mkdir -p "$VOL"

# Match the volume dir's owner to the container's runtime user (uid 10001).
# Requires root; on dev machines (rootless) this is skipped and relies on the
# Docker Desktop bind-mount mapping.
if [ "$(id -u)" = "0" ]; then
  chown -R 10001:10001 "$VOL"
fi

# Optional storage quota in bytes (0 = unlimited).
STORAGE_QUOTA_BYTES="${STORAGE_QUOTA_BYTES:-0}"

# Recreate idempotently (remove leftover container, ignore missing).
docker rm -f "$NAME" >/dev/null 2>&1 || true

echo "== starting $NAME (domain=$DOMAIN port=$PORT quota=$STORAGE_QUOTA_BYTES) =="
docker run -d \
  --name "$NAME" \
  --hostname "$NAME" \
  --restart unless-stopped \
  --memory 1g \
  --cpus 1 \
  --pids-limit 256 \
  --read-only \
  --tmpfs /tmp:size=128m \
  -p "127.0.0.1:$PORT:4000" \
  -v "$VOL:/var/lib/r2storage" \
  -e PORT=4000 \
  -e HOST=0.0.0.0 \
  -e NODE_ENV=production \
  -e HOME=/tmp \
  -e npm_config_cache=/tmp/npm-cache \
  -e DATABASE_URL="file:/var/lib/r2storage/storage.db" \
  -e STORAGE_DIR="/var/lib/r2storage/storage_blobs" \
  -e ADMIN_SECRET="$ADMIN_SECRET" \
  -e BASE_DOMAIN="$DOMAIN" \
  -e STORAGE_QUOTA_BYTES="$STORAGE_QUOTA_BYTES" \
  "$IMAGE" \
  >/dev/null

echo "== container started: $NAME =="
echo "== admin secret: $ADMIN_SECRET =="
docker ps --filter "name=$NAME" --format '{{.ID}}'
