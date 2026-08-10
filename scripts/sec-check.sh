#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TMP=$(mktemp -d /tmp/r2-sec3.XXXXXX)
mkdir -p "$TMP/store"
(cd "$ROOT/backend" && DATABASE_URL="file:$TMP/api.db" npx prisma db push >/dev/null 2>&1) || { echo "db push failed"; exit 1; }
PORT=4197 HOST=127.0.0.1 DATABASE_URL="file:$TMP/api.db" STORAGE_DIR="$TMP/store" \
  ADMIN_SECRET=test-secret-123 BASE_DOMAIN=localhost NODE_ENV=production \
  LOGIN_FAIL_THRESHOLD=2 LOGIN_GLOBAL_THRESHOLD=10 LOGIN_FAILURE_DELAY_MS=1 \
  node "$ROOT/backend/dist/index.js" > "$TMP/s.log" 2>&1 &
SPID=$!
for _ in $(seq 1 40); do curl -sf http://127.0.0.1:4197/health >/dev/null 2>&1 && break; sleep 0.2; done
B=http://127.0.0.1:4197
curl -s -X POST -H "Content-Type: application/json" -H "X-Admin-Secret: test-secret-123" -d '{"name":"bucket1"}' "$B/api/admin/buckets" > /dev/null
curl -s -X POST -H "Content-Type: application/json" -H "X-Admin-Secret: test-secret-123" -d '{"name":"k1","permission":"FULL"}' "$B/api/admin/keys" > "$TMP/key.json"
AK=$(node -p "JSON.parse(require('fs').readFileSync('$TMP/key.json')).accessKeyId")
SK=$(node -p "JSON.parse(require('fs').readFileSync('$TMP/key.json')).secretAccessKey")
echo "x-api-key full access PUT: $(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "x-api-key: $SK" --data-binary 'hello' "$B/s3/bucket1/a.txt")"
echo "bare AKID rejected:        $(curl -s -o /dev/null -w '%{http_code}' -H "x-access-key-id: $AK" "$B/s3/bucket1/a.txt")"
echo "correct id+secret GET:     $(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/bucket1/a.txt")"
echo "presigned 10y clamped to:  $(curl -s -X POST -H "X-Admin-Secret: test-secret-123" -H "Content-Type: application/json" -d '{"key":"a.txt","expiresInSeconds":315360000}' "$B/api/admin/buckets/bucket1/presigned" | node -p "JSON.parse(require('fs').readFileSync(0)).expiresInSeconds")"
echo "presigned negative -> 400: $(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-Admin-Secret: test-secret-123" -H "Content-Type: application/json" -d '{"key":"a.txt","expiresInSeconds":-5}' "$B/api/admin/buckets/bucket1/presigned")"

# --- login brute-force lockout (threshold 2 here) --------------------------------
echo "login bad #1:              $(curl -s -o /dev/null -w '%{http_code}' -H "X-Forwarded-For: 9.9.9.9" -X POST -H "Content-Type: application/json" -d '{"secret":"wrong"}' "$B/api/admin/login")"
echo "login bad #2 (locks IP):   $(curl -s -o /dev/null -w '%{http_code}' -H "X-Forwarded-For: 9.9.9.9" -X POST -H "Content-Type: application/json" -d '{"secret":"wrong"}' "$B/api/admin/login")"
echo "login correct -> locked:   $(curl -s -o /dev/null -w '%{http_code}' -H "X-Forwarded-For: 9.9.9.9" -X POST -H "Content-Type: application/json" -d '{"secret":"test-secret-123"}' "$B/api/admin/login")"
echo "retry-after header:        $(curl -s -D - -o /dev/null -H "X-Forwarded-For: 9.9.9.9" -X POST -H "Content-Type: application/json" -d '{"secret":"test-secret-123"}' "$B/api/admin/login" | grep -i '^retry-after:' | tr -d '\r' || echo 'MISSING')"
echo "header auth per-IP count:  $(curl -s -o /dev/null -w '%{http_code}' -H "X-Forwarded-For: 9.9.9.9" -H "X-Admin-Secret: wrong" "$B/api/admin/overview")"
kill "$SPID" 2>/dev/null; wait "$SPID" 2>/dev/null
rm -rf "$TMP"
