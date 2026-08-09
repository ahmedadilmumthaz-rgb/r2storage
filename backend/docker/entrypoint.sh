#!/bin/sh
# r2storage tenant container entrypoint.
# Applies the Prisma schema to the SQLite DB on the mounted volume (idempotent —
# safe to run on every boot), then starts the backend as PID 1.
set -e

if [ ! -d /var/lib/r2storage ]; then
  echo "[entrypoint] ERROR: /var/lib/r2storage volume not mounted" >&2
  exit 1
fi

echo "[entrypoint] applying database schema..."
npx prisma db push --skip-generate --accept-data-loss

echo "[entrypoint] starting r2storage..."
exec node dist/index.js
