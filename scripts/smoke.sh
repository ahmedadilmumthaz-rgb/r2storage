#!/usr/bin/env bash
#
# R2 Storage smoke test — boots a throwaway backend instance (temp DB + storage
# dir + free port) and exercises the full surface: session auth, admin API, S3
# PUT/GET/HEAD/list, multipart upload, presigned URLs, public buckets, logout,
# and rate limiting. Requires a built backend (npm run build) and `curl` + `node`.
#
# Usage:  bash scripts/smoke.sh            (or: npm test)
# Env:    SMOKE_PORT  override the test port (default picks a free one)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
DIST="$BACKEND/dist/index.js"

PASS=0
FAIL=0
declare -a FAILURES=()

if [ ! -f "$DIST" ]; then
  echo "✗ backend not built — run: cd backend && npm run build"
  exit 1
fi

PORT="${SMOKE_PORT:-4199}"
ADMIN_SECRET="${ADMIN_SECRET:-smoke-test-secret}"
SMOKE_URL="${SMOKE_URL:-}"

TMP="$(mktemp -d /tmp/r2-smoke.XXXXXX)"
STORE="$TMP/store"
DB="$TMP/smoke.db"
LOG="$TMP/server.log"
COOKIES="$TMP/cookies.txt"
mkdir -p "$STORE"

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  if [ "$FAIL" -gt 0 ]; then
    echo "  artifacts kept in $TMP (server.log, db, store) for debugging"
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

B="http://127.0.0.1:$PORT"
if [ -n "$SMOKE_URL" ]; then
  B="$SMOKE_URL"
fi

# --- helpers ----------------------------------------------------------------
check() { # check <description> <expected> <actual>
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  ok   $desc"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$desc (expected $expected, got $actual)")
    echo "  FAIL $desc — expected $expected, got $actual"
  fi
}

status_of() { # status_of <curl args...>
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

json_field() { # json_field <json> <field>
  printf '%s' "$1" | node -p "JSON.parse(require('fs').readFileSync(0)).$2 ?? ''"
}

# --- start the throwaway server ---------------------------------------------
if [ -z "$SMOKE_URL" ]; then
echo "== applying schema (prisma db push) =="
(
  cd "$BACKEND"
  DATABASE_URL="file:$DB" npx prisma db push >/dev/null 2>&1
)
[ -f "$DB" ] || { echo "✗ prisma db push failed"; exit 1; }
echo "  schema applied"

echo "== booting throwaway instance on :$PORT =="
(
  cd "$BACKEND"
  exec env PORT="$PORT" HOST=127.0.0.1 DATABASE_URL="file:$DB" STORAGE_DIR="$STORE" \
    ADMIN_SECRET="$ADMIN_SECRET" BASE_DOMAIN=localhost NODE_ENV=production \
    node dist/index.js >"$LOG" 2>&1
) &
SERVER_PID=$!

for _ in $(seq 1 50); do
  if curl -sf "$B/health" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
[ -n "$(curl -sf "$B/health" 2>/dev/null)" ] || { echo "✗ server did not become healthy"; tail -5 "$LOG"; exit 1; }
echo "  healthy"
else
echo "== using existing server at $B =="
fi

# --- auth / sessions ----------------------------------------------------------
echo "== session auth =="
R=$(curl -s "$B/api/admin/session")
check "session unauthenticated by default" "false" "$(json_field "$R" authenticated)"

check "login with wrong secret -> 401" "401" "$(status_of -X POST -H "Content-Type: application/json" -d '{"secret":"wrong"}' "$B/api/admin/login")"

R=$(curl -s -c "$COOKIES" -X POST -H "Content-Type: application/json" -d "{\"secret\":\"$ADMIN_SECRET\"}" "$B/api/admin/login")
check "login with correct secret" "true" "$(json_field "$R" ok)"

R=$(curl -s -b "$COOKIES" "$B/api/admin/session")
check "session authenticated after login" "true" "$(json_field "$R" authenticated)"

check "overview with cookie -> 200" "200" "$(status_of -b "$COOKIES" "$B/api/admin/overview")"
check "overview without cookie/header -> 401" "401" "$(status_of "$B/api/admin/overview")"
check "overview with X-Admin-Secret header -> 200" "200" "$(status_of -H "X-Admin-Secret: $ADMIN_SECRET" "$B/api/admin/overview")"

R=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$B/api/admin/usage")
check "usage starts at 0 bytes" "0" "$(json_field "$R" storageBytes)"
check "usage rejects bad since" "400" "$(status_of -H "X-Admin-Secret: $ADMIN_SECRET" "$B/api/admin/usage?since=not-a-date")"

# --- admin API: bucket + key ---------------------------------------------------
echo "== admin API =="
BUCKET_CODE="$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIES" -X POST -H "Content-Type: application/json" -d '{"name":"smoke"}' "$B/api/admin/buckets")"
check "create bucket" "201" "$BUCKET_CODE"

R=$(curl -s -b "$COOKIES" -X POST -H "Content-Type: application/json" -d '{"name":"smoke","permission":"FULL","bucketFilter":"smoke"}' "$B/api/admin/keys")
KEY_CODE="$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIES" -X POST -H "Content-Type: application/json" -d '{"name":"smoke2","permission":"FULL","bucketFilter":"smoke"}' "$B/api/admin/keys")"
AK="$(json_field "$R" accessKeyId)"
check "create scoped access key" "201" "$KEY_CODE"
[ -n "$AK" ] || { echo "✗ could not parse access key"; exit 1; }

# --- storage quota ---------------------------------------------------------------
echo "== storage quota =="
R=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$B/api/admin/quota")
check "quota defaults to unlimited" "0" "$(json_field "$R" storageBytesLimit)"
check "quota rejects negative limit" "400" "$(status_of -H "X-Admin-Secret: $ADMIN_SECRET" -X PATCH -H "Content-Type: application/json" -d '{"storageBytesLimit":-5}' "$B/api/admin/quota")"
check "quota set to 50B" "200" "$(status_of -H "X-Admin-Secret: $ADMIN_SECRET" -X PATCH -H "Content-Type: application/json" -d '{"storageBytesLimit":50}' "$B/api/admin/quota")"

head -c 100 /dev/zero > "$TMP/big.bin"
check "over-quota PUT -> 507" "507" "$(status_of -X PUT -H "x-access-key-id: $AK" --data-binary @"$TMP/big.bin" "$B/s3/smoke/overq.bin")"
check "rejected object not committed (HEAD 404)" "404" "$(status_of -I -H "x-access-key-id: $AK" "$B/s3/smoke/overq.bin")"
R=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$B/api/admin/usage")
check "usage unchanged after 507" "0" "$(json_field "$R" storageBytes)"

check "under-quota PUT -> 200" "200" "$(status_of -X PUT -H "x-access-key-id: $AK" --data-binary 'under-quota' "$B/s3/smoke/underq.bin")"
curl -s -o /dev/null -H "x-access-key-id: $AK" -X DELETE "$B/s3/smoke/underq.bin"
rm -f "$TMP/big.bin"

curl -s -o /dev/null -H "X-Admin-Secret: $ADMIN_SECRET" -X PATCH -H "Content-Type: application/json" -d '{"storageBytesLimit":0}' "$B/api/admin/quota"
R=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$B/api/admin/quota")
check "quota restored to unlimited" "0" "$(json_field "$R" storageBytesLimit)"

# --- S3 object operations -------------------------------------------------------
echo "== S3 PUT/GET/HEAD/list =="
printf 'smoke-test-content' > "$TMP/hello.txt"
check "PUT object" "200" "$(status_of -X PUT -H "x-access-key-id: $AK" --data-binary @"$TMP/hello.txt" "$B/s3/smoke/hello.txt")"
R=$(curl -s -H "x-access-key-id: $AK" "$B/s3/smoke/hello.txt")
check "GET object content" "smoke-test-content" "$R"
check "HEAD object" "200" "$(status_of -I -H "x-access-key-id: $AK" "$B/s3/smoke/hello.txt")"
check "ListObjects" "200" "$(status_of -H "x-access-key-id: $AK" "$B/s3/smoke")"

R=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$B/api/admin/usage")
check "usage reports stored bytes" "18" "$(json_field "$R" storageBytes)"
sleep 0.3 # let the fire-and-forget GET/HEAD log writes land
R=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$B/api/admin/usage")
check "usage reports a request" "2" "$(json_field "$R" requests)"
R=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$B/api/admin/usage?since=$(node -e 'console.log(new Date(Date.now()+3600000).toISOString())')")
check "usage since-future counts nothing" "0" "$(json_field "$R" requests)"

# --- multipart ------------------------------------------------------------------
echo "== multipart upload =="
R=$(curl -s -X POST -H "x-access-key-id: $AK" "$B/s3/smoke/big.bin?uploads")
UPLOAD_ID="$(printf '%s' "$R" | sed -n 's:.*<UploadId>\([^<]*\)</UploadId>.*:\1:p')"
check "create multipart upload" "200" "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "x-access-key-id: $AK" "$B/s3/smoke/big.bin?uploads")"
[ -n "$UPLOAD_ID" ] || { echo "✗ no UploadId in XML"; exit 1; }

ETAG1="$(curl -s -D - -o /dev/null -X PUT -H "x-access-key-id: $AK" --data-binary 'part-one' "$B/s3/smoke/big.bin?partNumber=1&uploadId=$UPLOAD_ID" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)"
ETAG2="$(curl -s -D - -o /dev/null -X PUT -H "x-access-key-id: $AK" --data-binary 'part-two' "$B/s3/smoke/big.bin?partNumber=2&uploadId=$UPLOAD_ID" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)"
[ -n "$ETAG1" ] && [ -n "$ETAG2" ] || { echo "✗ missing part ETags"; exit 1; }

COMPLETE_XML="<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>$ETAG1</ETag></Part><Part><PartNumber>2</PartNumber><ETag>$ETAG2</ETag></Part></CompleteMultipartUpload>"
curl -s -o /dev/null -X POST -H "x-access-key-id: $AK" -H "Content-Type: application/xml" --data "$COMPLETE_XML" "$B/s3/smoke/big.bin?uploadId=$UPLOAD_ID"
R=$(curl -s -H "x-access-key-id: $AK" "$B/s3/smoke/big.bin")
check "multipart assembled" "part-onepart-two" "$R"

# --- presigned + public bucket ----------------------------------------------------
echo "== presigned URL + public bucket =="
R=$(curl -s -b "$COOKIES" -X POST -H "Content-Type: application/json" -d '{"key":"hello.txt","expiresInSeconds":600}' "$B/api/admin/buckets/smoke/presigned")
PRESIGNED="$(json_field "$R" url)"
[ -n "$PRESIGNED" ] || { echo "✗ no presigned URL"; exit 1; }
R=$(curl -s "$PRESIGNED")
check "presigned GET" "smoke-test-content" "$R"

curl -s -o /dev/null -b "$COOKIES" -X PATCH -H "Content-Type: application/json" -d '{"isPublic":true}' "$B/api/admin/buckets/smoke"
check "public bucket anonymous GET" "200" "$(status_of "$B/s3/smoke/hello.txt")"

# --- logout + revocation (before the hammer, to avoid rate-limit cross-talk) -------
echo "== logout revokes session =="
check "logout" "200" "$(status_of -b "$COOKIES" -X POST "$B/api/admin/logout")"
R=$(curl -s -b "$COOKIES" "$B/api/admin/session")
check "session invalid after logout" "false" "$(json_field "$R" authenticated)"
check "overview after logout -> 401" "401" "$(status_of -b "$COOKIES" "$B/api/admin/overview")"

# --- rate limiting (last: consumes the whole /api/admin budget) -------------------
echo "== rate limiting =="
COUNT_429=0
for _ in $(seq 1 40); do
  CODE="$(status_of -X POST -H "Content-Type: application/json" -d '{"secret":"bruteforce"}' "$B/api/admin/login")"
  [ "$CODE" = "429" ] && COUNT_429=$((COUNT_429 + 1))
done
[ "$COUNT_429" -ge 1 ] && PASS=$((PASS + 1)) && echo "  ok   admin hammer -> 429 (x$COUNT_429)" \
  || { FAIL=$((FAIL + 1)); FAILURES+=("admin hammer never returned 429"); echo "  FAIL admin hammer never returned 429"; }

# --- summary ----------------------------------------------------------------------
echo
echo "== smoke result: $PASS passed, $FAIL failed =="
if [ "$FAIL" -gt 0 ]; then
  printf '  - %s\n' "${FAILURES[@]}"
  exit 1
fi
