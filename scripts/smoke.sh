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
# 32-byte key (64 hex chars); smoke boots WITH encryption at rest so the whole
# suite exercises encrypt-write / decrypt-read on every object path.
ENC_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
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
    STORAGE_ENCRYPTION_KEY="$ENC_KEY" \
    LOGIN_FAIL_THRESHOLD=3 LOGIN_GLOBAL_THRESHOLD=5 LOGIN_IP_COOLDOWN_SEC=60 \
    LOGIN_GLOBAL_COOLDOWN_SEC=60 LOGIN_FAILURE_DELAY_MS=1 \
    ADMIN_SESSION_TTL_HOURS=0.01 \
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

# Session hardening: activity slides the expiry forward (idle TTL is 36s here).
S0="$(json_field "$R" expiresAt)"
sleep 1.2
curl -s -o /dev/null -b "$COOKIES" "$B/api/admin/overview"   # guarded -> renews
R=$(curl -s -b "$COOKIES" "$B/api/admin/session")
S1="$(json_field "$R" expiresAt)"
check "session expiry slides forward on activity" "true" "$(node -e "process.stdout.write(String(Date.parse('$S1')>Date.parse('$S0')))")"

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
SK="$(json_field "$R" secretAccessKey)"
check "create scoped access key" "201" "$KEY_CODE"
[ -n "$AK" ] || { echo "✗ could not parse access key"; exit 1; }
[ -n "$SK" ] || { echo "✗ could not parse access key secret"; exit 1; }

# --- storage quota ---------------------------------------------------------------
echo "== storage quota =="
R=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$B/api/admin/quota")
check "quota defaults to unlimited" "0" "$(json_field "$R" storageBytesLimit)"
check "quota rejects negative limit" "400" "$(status_of -H "X-Admin-Secret: $ADMIN_SECRET" -X PATCH -H "Content-Type: application/json" -d '{"storageBytesLimit":-5}' "$B/api/admin/quota")"
check "quota set to 50B" "200" "$(status_of -H "X-Admin-Secret: $ADMIN_SECRET" -X PATCH -H "Content-Type: application/json" -d '{"storageBytesLimit":50}' "$B/api/admin/quota")"

head -c 100 /dev/zero > "$TMP/big.bin"
check "over-quota PUT -> 507" "507" "$(status_of -X PUT -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" --data-binary @"$TMP/big.bin" "$B/s3/smoke/overq.bin")"
check "rejected object not committed (HEAD 404)" "404" "$(status_of -I -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/overq.bin")"
# Multipart parts consume disk before completion, so UploadPart must honor the
# quota too (otherwise parts could fill the disk while never being completed).
MPQ_XML="$(curl -s -X POST -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/mpq.bin?uploads")"
MPQ_ID="$(printf '%s' "$MPQ_XML" | sed -n 's:.*<UploadId>\([^<]*\)</UploadId>.*:\1:p')"
check "over-quota UploadPart -> 507" "507" "$(status_of -X PUT -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" --data-binary @"$TMP/big.bin" "$B/s3/smoke/mpq.bin?partNumber=1&uploadId=$MPQ_ID")"
check "over-quota part not persisted (complete fails)" "400" "$(status_of -X POST -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" -H "Content-Type: application/xml" --data "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>\"nope\"</ETag></Part></CompleteMultipartUpload>" "$B/s3/smoke/mpq.bin?uploadId=$MPQ_ID")"
curl -s -o /dev/null -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" -X DELETE "$B/s3/smoke/mpq.bin?uploadId=$MPQ_ID"
R=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$B/api/admin/usage")
check "usage unchanged after 507" "0" "$(json_field "$R" storageBytes)"

check "under-quota PUT -> 200" "200" "$(status_of -X PUT -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" --data-binary 'under-quota' "$B/s3/smoke/underq.bin")"
curl -s -o /dev/null -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" -X DELETE "$B/s3/smoke/underq.bin"
rm -f "$TMP/big.bin"

curl -s -o /dev/null -H "X-Admin-Secret: $ADMIN_SECRET" -X PATCH -H "Content-Type: application/json" -d '{"storageBytesLimit":0}' "$B/api/admin/quota"
R=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$B/api/admin/quota")
check "quota restored to unlimited" "0" "$(json_field "$R" storageBytesLimit)"

# --- admin audit trail ---------------------------------------------------------
echo "== admin audit trail =="
check "audit log requires auth" "401" "$(status_of "$B/api/admin/audit")"
AUDIT="$(curl -s -b "$COOKIES" "$B/api/admin/audit")"
# bucket.create was done via the dashboard cookie -> actor 'session'
check "audit records bucket.create (actor=session)" "session" "$(printf '%s' "$AUDIT" | node -e "const d=JSON.parse(require('fs').readFileSync(0));const e=d.find(x=>x.action==='bucket.create'&&x.target==='smoke');process.stdout.write(e?e.actor:'MISSING')")"
# two access keys were created via the cookie
check "audit records both key.create rows" "2" "$(printf '%s' "$AUDIT" | node -e "const d=JSON.parse(require('fs').readFileSync(0));process.stdout.write(String(d.filter(x=>x.action==='key.create').length))")"
# quota was patched via the x-admin-secret header -> actor 'header', detail carries the limit
check "audit records quota.update (actor=header)" "header" "$(printf '%s' "$AUDIT" | node -e "const d=JSON.parse(require('fs').readFileSync(0));const e=d.find(x=>x.action==='quota.update');process.stdout.write(e?e.actor:'MISSING')")"
# the 50B quota set earlier must appear in the trail (the later restore-to-0 row
# is also present, so count rows whose detail carries the 50B limit)
check "quota.update detail records limit" "1" "$(printf '%s' "$AUDIT" | node -e "const d=JSON.parse(require('fs').readFileSync(0));process.stdout.write(String(d.filter(x=>x.action==='quota.update'&&x.detail&&JSON.parse(x.detail).storageBytesLimit===50).length))")"
check "audit records login.success" "system" "$(printf '%s' "$AUDIT" | node -e "const d=JSON.parse(require('fs').readFileSync(0));const e=d.find(x=>x.action==='login.success');process.stdout.write(e?e.actor:'MISSING')")"
check "audit bad limit falls back to default" "true" "$(curl -s -b "$COOKIES" "$B/api/admin/audit?limit=abc" | node -e "const d=JSON.parse(require('fs').readFileSync(0));process.stdout.write(Array.isArray(d)&&d.length<=200?'true':'false')")"

# --- S3 object operations -------------------------------------------------------
echo "== S3 PUT/GET/HEAD/list =="
printf 'smoke-test-content' > "$TMP/hello.txt"
check "PUT object" "200" "$(status_of -X PUT -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" --data-binary @"$TMP/hello.txt" "$B/s3/smoke/hello.txt")"
R=$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/hello.txt")
check "GET object content" "smoke-test-content" "$R"
check "HEAD object" "200" "$(status_of -I -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/hello.txt")"
check "ListObjects" "200" "$(status_of -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke")"

# Encryption at rest: with STORAGE_ENCRYPTION_KEY set, the blob on disk must
# start with the r2enc1 magic and must not contain the plaintext payload.
ENCFILE="$(find "$STORE/smoke" -type f | head -1)"
check "stored blob is encrypted (r2enc1 magic)" "7232656e6331" "$(head -c 6 "$ENCFILE" | xxd -p)"
check "stored blob hides plaintext" "0" "$(grep -c 'smoke-test-content' "$ENCFILE" 2>/dev/null || true)"

# --- auth hardening -------------------------------------------------------------
echo "== auth hardening =="
check "bare access key id (no secret) rejected" "403" "$(status_of -H "x-access-key-id: $AK" "$B/s3/smoke/hello.txt")"
check "wrong access key secret rejected" "403" "$(status_of -H "x-access-key-id: $AK" -H "x-access-key-secret: wrong-secret" "$B/s3/smoke/hello.txt")"
check "unknown x-api-key secret rejected" "403" "$(status_of -H "x-api-key: not-a-real-secret" "$B/s3/smoke/hello.txt")"

R=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$B/api/admin/usage")
check "usage reports stored bytes" "18" "$(json_field "$R" storageBytes)"
sleep 0.3 # let the fire-and-forget GET/HEAD log writes land
R=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$B/api/admin/usage")
check "usage reports a request" "2" "$(json_field "$R" requests)"
R=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$B/api/admin/usage?since=$(node -e 'console.log(new Date(Date.now()+3600000).toISOString())')")
check "usage since-future counts nothing" "0" "$(json_field "$R" requests)"

# --- byte-range + conditional GET --------------------------------------------------
# hello.txt = 'smoke-test-content' (18 bytes):  0-4='smoke' 5-='-test-content'
# -5='ntent' 6-11='test-c'. Booted with STORAGE_ENCRYPTION_KEY, so ranged reads
# exercise the decrypt-and-slice path (sliceStream).
echo "== Range + conditional GET =="
AUTH_OPTS=(-H "x-access-key-id: $AK" -H "x-access-key-secret: $SK")
check "Range bytes=0-4 -> 206" "206" "$(status_of "${AUTH_OPTS[@]}" -H "Range: bytes=0-4" "$B/s3/smoke/hello.txt")"
check "Range bytes=0-4 body" "smoke" "$(curl -s "${AUTH_OPTS[@]}" -H "Range: bytes=0-4" "$B/s3/smoke/hello.txt")"
check "Range bytes=0-4 Content-Range" "bytes 0-4/18" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" -H "Range: bytes=0-4" "$B/s3/smoke/hello.txt" | grep -i '^content-range:' | tr -d '\r' | cut -d' ' -f2-)"
check "Range bytes=0-4 Content-Length" "5" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" -H "Range: bytes=0-4" "$B/s3/smoke/hello.txt" | grep -i '^content-length:' | tr -d '\r' | cut -d' ' -f2)"
check "Range open-ended bytes=5- body" "-test-content" "$(curl -s "${AUTH_OPTS[@]}" -H "Range: bytes=5-" "$B/s3/smoke/hello.txt")"
check "Range suffix bytes=-5 body" "ntent" "$(curl -s "${AUTH_OPTS[@]}" -H "Range: bytes=-5" "$B/s3/smoke/hello.txt")"
check "Range middle bytes=6-11 body" "test-c" "$(curl -s "${AUTH_OPTS[@]}" -H "Range: bytes=6-11" "$B/s3/smoke/hello.txt")"
check "Range past-end clamps to EOF" "8" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" -H "Range: bytes=10-99" "$B/s3/smoke/hello.txt" | grep -i '^content-length:' | tr -d '\r' | cut -d' ' -f2)"
check "unsatisfiable Range -> 416" "416" "$(status_of "${AUTH_OPTS[@]}" -H "Range: bytes=99-100" "$B/s3/smoke/hello.txt")"
check "416 includes Content-Range */size" "bytes */18" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" -H "Range: bytes=99-100" "$B/s3/smoke/hello.txt" | grep -i '^content-range:' | tr -d '\r' | cut -d' ' -f2-)"
check "malformed Range falls back to full 200" "200" "$(status_of "${AUTH_OPTS[@]}" -H "Range: bytes=abc" "$B/s3/smoke/hello.txt")"
check "malformed Range body is full object" "smoke-test-content" "$(curl -s "${AUTH_OPTS[@]}" -H "Range: bytes=abc" "$B/s3/smoke/hello.txt")"
: > "$TMP/empty.txt"
check "PUT empty object" "200" "$(status_of -X PUT "${AUTH_OPTS[@]}" --data-binary @"$TMP/empty.txt" "$B/s3/smoke/empty.txt")"
check "Range on empty object -> 416" "416" "$(status_of "${AUTH_OPTS[@]}" -H "Range: bytes=0-0" "$B/s3/smoke/empty.txt")"

ETAG="$(curl -s -I "${AUTH_OPTS[@]}" "$B/s3/smoke/hello.txt" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)"
[ -n "$ETAG" ] || { echo "✗ no ETag"; exit 1; }
check "If-None-Match matching ETag -> 304" "304" "$(status_of "${AUTH_OPTS[@]}" -H "If-None-Match: $ETAG" "$B/s3/smoke/hello.txt")"
check "If-None-Match * -> 304" "304" "$(status_of "${AUTH_OPTS[@]}" -H "If-None-Match: *" "$B/s3/smoke/hello.txt")"
check "If-None-Match non-matching -> 200" "200" "$(status_of "${AUTH_OPTS[@]}" -H 'If-None-Match: "bogus"' "$B/s3/smoke/hello.txt")"
check "If-Modified-Since now -> 304" "304" "$(status_of "${AUTH_OPTS[@]}" -H "If-Modified-Since: $(date -u +'%a, %d %b %Y %H:%M:%S GMT')" "$B/s3/smoke/hello.txt")"
check "If-Modified-Since past -> 200" "200" "$(status_of "${AUTH_OPTS[@]}" -H 'If-Modified-Since: Sat, 01 Jan 2000 00:00:00 GMT' "$B/s3/smoke/hello.txt")"
check "304 sends ETag header" "1" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" -H "If-None-Match: $ETAG" "$B/s3/smoke/hello.txt" | grep -ic '^etag:')"

# --- multipart ------------------------------------------------------------------
echo "== multipart upload =="
R=$(curl -s -X POST -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/big.bin?uploads")
UPLOAD_ID="$(printf '%s' "$R" | sed -n 's:.*<UploadId>\([^<]*\)</UploadId>.*:\1:p')"
check "create multipart upload" "200" "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/big.bin?uploads")"
[ -n "$UPLOAD_ID" ] || { echo "✗ no UploadId in XML"; exit 1; }

# CompleteMultipartUpload body is capped at 1MB (it's only a part list); a huge
# body must be rejected 413 instead of being buffered into memory.
head -c 2097152 /dev/zero | tr '\0' 'a' > "$TMP/huge.xml"
check "oversized CompleteMultipartUpload body -> 413" "413" "$(status_of -X POST -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" -H "Content-Type: application/xml" --data-binary @"$TMP/huge.xml" "$B/s3/smoke/big.bin?uploadId=$UPLOAD_ID")"
rm -f "$TMP/huge.xml"

ETAG1="$(curl -s -D - -o /dev/null -X PUT -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" --data-binary 'part-one' "$B/s3/smoke/big.bin?partNumber=1&uploadId=$UPLOAD_ID" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)"
ETAG2="$(curl -s -D - -o /dev/null -X PUT -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" --data-binary 'part-two' "$B/s3/smoke/big.bin?partNumber=2&uploadId=$UPLOAD_ID" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)"
[ -n "$ETAG1" ] && [ -n "$ETAG2" ] || { echo "✗ missing part ETags"; exit 1; }

COMPLETE_XML="<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>$ETAG1</ETag></Part><Part><PartNumber>2</PartNumber><ETag>$ETAG2</ETag></Part></CompleteMultipartUpload>"
curl -s -o /dev/null -X POST -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" -H "Content-Type: application/xml" --data "$COMPLETE_XML" "$B/s3/smoke/big.bin?uploadId=$UPLOAD_ID"
R=$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/big.bin")
check "multipart assembled" "part-onepart-two" "$R"
# The assembled object must also be encrypted on disk (multipart parts decrypt
# and re-encrypt during assembly). Check the magic of every stored blob.
ALLENC="$(find "$STORE/smoke" -type f | while read -r f; do head -c 6 "$f" | xxd -p; done | sort -u)"
check "all stored blobs encrypted on disk" "7232656e6331" "$ALLENC"

# --- presigned + public bucket ----------------------------------------------------
echo "== presigned URL + public bucket =="
R=$(curl -s -b "$COOKIES" -X POST -H "Content-Type: application/json" -d '{"key":"hello.txt","expiresInSeconds":600}' "$B/api/admin/buckets/smoke/presigned")
PRESIGNED="$(json_field "$R" url)"
[ -n "$PRESIGNED" ] || { echo "✗ no presigned URL"; exit 1; }
R=$(curl -s "$PRESIGNED")
check "presigned GET" "smoke-test-content" "$R"

curl -s -o /dev/null -b "$COOKIES" -X PATCH -H "Content-Type: application/json" -d '{"isPublic":true}' "$B/api/admin/buckets/smoke"
check "public bucket anonymous GET" "200" "$(status_of "$B/s3/smoke/hello.txt")"
check "public bucket anonymous Range -> 206" "206" "$(status_of -H 'Range: bytes=0-4' "$B/s3/smoke/hello.txt")"

# --- logout + revocation (before the hammer, to avoid rate-limit cross-talk) -------
echo "== logout revokes session =="
check "logout" "200" "$(status_of -b "$COOKIES" -X POST "$B/api/admin/logout")"
R=$(curl -s -b "$COOKIES" "$B/api/admin/session")
check "session invalid after logout" "false" "$(json_field "$R" authenticated)"
check "overview after logout -> 401" "401" "$(status_of -b "$COOKIES" "$B/api/admin/overview")"

# --- brute-force lockout + rate limiting (last: leaves the lockout armed) --------
# The throwaway server boots with LOGIN_FAIL_THRESHOLD=3 / LOGIN_GLOBAL_THRESHOLD=5.
# Each simulated client sends its own X-Forwarded-For so per-IP counters are
# independent of the real 127.0.0.1 rate-limit budget (trustProxy trusts XFF).
echo "== login brute-force lockout =="
login_of() { # login_of <xff> <secret>
  status_of -H "X-Forwarded-For: $1" -X POST -H "Content-Type: application/json" \
    -d "{\"secret\":\"$2\"}" "$B/api/admin/login"
}

# 1. Per-IP lockout: 3 consecutive bad attempts from one address lock it out.
check "per-IP: 1st bad login -> 401" "401" "$(login_of 1.1.1.1 wrong)"
check "per-IP: 2nd bad login -> 401" "401" "$(login_of 1.1.1.1 wrong)"
check "per-IP: 3rd bad login -> 401" "401" "$(login_of 1.1.1.1 wrong)"
check "per-IP: correct secret now locked out -> 429" "429" "$(login_of 1.1.1.1 "$ADMIN_SECRET")"

R=$(curl -s -D - -o /dev/null -H "X-Forwarded-For: 1.1.1.1" -X POST -H "Content-Type: application/json" \
  -d "{\"secret\":\"$ADMIN_SECRET\"}" "$B/api/admin/login")
[ -n "$(printf '%s' "$R" | grep -i '^retry-after:')" ] && PASS=$((PASS + 1)) && echo "  ok   lockout response carries Retry-After" \
  || { FAIL=$((FAIL + 1)); FAILURES+=("lockout response had no Retry-After"); echo "  FAIL lockout response carries Retry-After"; }

# 2. Per-IP isolation + audit trail: another address still logs in (global not
#    tripped by one source), and the overview reports the 3 failed attempts.
COOKIES2="$TMP/cookies2.txt"
LOGIN_CODE="$(curl -s -c "$COOKIES2" -o /dev/null -w "%{http_code}" -H "X-Forwarded-For: 2.2.2.2" -X POST -H "Content-Type: application/json" -d "{\"secret\":\"$ADMIN_SECRET\"}" "$B/api/admin/login")"
check "per-IP: other address still logs in (isolation)" "200" "$LOGIN_CODE"
R=$(curl -s -b "$COOKIES2" "$B/api/admin/overview")
# 3 failed lockout attempts from 1.1.1.1 + 1 from the session section's
# "wrong secret -> 401" check (127.0.0.1) = 4 rows.
check "failed logins surfaced in overview" "4" "$(json_field "$R" failedLogins24h)"

# 3. Global lockout: 5 total failures across fresh addresses block everyone,
#    even an address that never failed.
check "global: 1st bad login -> 401" "401" "$(login_of 2.2.2.2 wrong)"
check "global: 2nd bad login -> 401" "401" "$(login_of 3.3.3.3 wrong)"
check "global: 3rd bad login -> 401" "401" "$(login_of 4.4.4.4 wrong)"
check "global: 4th bad login -> 401" "401" "$(login_of 5.5.5.5 wrong)"
check "global: 5th bad login -> 401" "401" "$(login_of 6.6.6.6 wrong)"
check "global: fresh address locked out too -> 429" "429" "$(login_of 7.7.7.7 "$ADMIN_SECRET")"

# 4. Per-IP admin rate limit still fires (overview hammer; no secret header so
#    the lockout counters are untouched).
echo "== rate limiting =="
COUNT_429=0
for _ in $(seq 1 40); do
  CODE="$(status_of -b "$COOKIES" "$B/api/admin/overview")"
  [ "$CODE" = "429" ] && COUNT_429=$((COUNT_429 + 1))
done
[ "$COUNT_429" -ge 1 ] && PASS=$((PASS + 1)) && echo "  ok   admin overview hammer -> 429 (x$COUNT_429)" \
  || { FAIL=$((FAIL + 1)); FAILURES+=("admin overview hammer never returned 429"); echo "  FAIL admin overview hammer -> 429"; }

# --- session absolute-lifetime cap (second throwaway boot, short MAX) -----------
# Proves that even with a long idle TTL, renewal can never push a session past
# ADMIN_SESSION_MAX_HOURS (0.002h = 7.2s here).
echo "== session absolute-lifetime cap =="
PORT2=$((PORT + 1))
DB2="$TMP/cap.db"
STORE2="$TMP/store2"
LOG2="$TMP/server2.log"
mkdir -p "$STORE2"
(
  cd "$BACKEND"
  DATABASE_URL="file:$DB2" npx prisma db push >/dev/null 2>&1
)
(
  cd "$BACKEND"
  exec env PORT="$PORT2" HOST=127.0.0.1 DATABASE_URL="file:$DB2" STORAGE_DIR="$STORE2" \
    ADMIN_SECRET="$ADMIN_SECRET" BASE_DOMAIN=localhost NODE_ENV=production \
    ADMIN_SESSION_MAX_HOURS=0.002 \
    node dist/index.js >"$LOG2" 2>&1
) &
SERVER2_PID=$!
B2="http://127.0.0.1:$PORT2"
for _ in $(seq 1 50); do
  curl -sf "$B2/health" >/dev/null 2>&1 && break
  sleep 0.2
done
COOKIES3="$TMP/cookies3.txt"
curl -s -c "$COOKIES3" -o /dev/null -X POST -H "Content-Type: application/json" \
  -d "{\"secret\":\"$ADMIN_SECRET\"}" "$B2/api/admin/login"
S0="$(curl -s -b "$COOKIES3" "$B2/api/admin/session" | node -e "const d=JSON.parse(require('fs').readFileSync(0));process.stdout.write(d.expiresAt||'')")"
check "session born capped at MAX (~7.2s)" "true" "$(node -e "const d=Date.parse('$S0')-Date.now();process.stdout.write(String(d>=5000&&d<=9000))")"
curl -s -o /dev/null -b "$COOKIES3" "$B2/api/admin/overview"   # renewal attempt
S1="$(curl -s -b "$COOKIES3" "$B2/api/admin/session" | node -e "const d=JSON.parse(require('fs').readFileSync(0));process.stdout.write(d.expiresAt||'')")"
check "renewal cannot extend past the cap" "true" "$(node -e "process.stdout.write(String(Math.abs(Date.parse('$S1')-Date.parse('$S0'))<1000))")"
check "session still authenticated under cap" "true" "$(curl -s -b "$COOKIES3" "$B2/api/admin/session" | node -e "const d=JSON.parse(require('fs').readFileSync(0));process.stdout.write(String(d.authenticated))")"
kill "$SERVER2_PID" 2>/dev/null; wait "$SERVER2_PID" 2>/dev/null

# --- admin IP allowlist (third throwaway boot, allowlist enabled) ---------------
# Boots with ADMIN_ALLOWED_CIDRS=127.0.0.1/32: the real client (loopback) passes,
# but a spoofed X-Forwarded-For lands outside the allowlist and is denied 403 —
# including on the login route, which runs before any auth logic.
echo "== admin IP allowlist =="
PORT3=$((PORT + 2))
DB3="$TMP/allow.db"
STORE3="$TMP/store3"
LOG3="$TMP/server3.log"
mkdir -p "$STORE3"
(
  cd "$BACKEND"
  DATABASE_URL="file:$DB3" npx prisma db push >/dev/null 2>&1
)
(
  cd "$BACKEND"
  exec env PORT="$PORT3" HOST=127.0.0.1 DATABASE_URL="file:$DB3" STORAGE_DIR="$STORE3" \
    ADMIN_SECRET="$ADMIN_SECRET" BASE_DOMAIN=localhost NODE_ENV=production \
    ADMIN_ALLOWED_CIDRS=127.0.0.1/32 \
    node dist/index.js >"$LOG3" 2>&1
) &
SERVER3_PID=$!
B3="http://127.0.0.1:$PORT3"
for _ in $(seq 1 50); do
  curl -sf "$B3/health" >/dev/null 2>&1 && break
  sleep 0.2
done
check "allowlist: real IP reaches overview -> 200" "200" "$(status_of -H "X-Admin-Secret: $ADMIN_SECRET" "$B3/api/admin/overview")"
check "allowlist: spoofed IP overview -> 403" "403" "$(status_of -H "X-Forwarded-For: 8.8.8.8" -H "X-Admin-Secret: $ADMIN_SECRET" "$B3/api/admin/overview")"
check "allowlist: login gated too -> 403" "403" "$(status_of -H "X-Forwarded-For: 8.8.8.8" -X POST -H "Content-Type: application/json" -d "{\"secret\":\"$ADMIN_SECRET\"}" "$B3/api/admin/login")"
check "allowlist: real IP can still log in -> 200" "200" "$(status_of -X POST -H "Content-Type: application/json" -d "{\"secret\":\"$ADMIN_SECRET\"}" "$B3/api/admin/login")"
kill "$SERVER3_PID" 2>/dev/null; wait "$SERVER3_PID" 2>/dev/null

# --- TOTP 2FA (fourth throwaway boot, ADMIN_TOTP_SECRET enabled) -----------------
# With a TOTP secret set, the login route requires a valid 6-digit code on top of
# ADMIN_SECRET; machine access via the x-admin-secret header stays exempt.
echo "== TOTP 2FA =="
TOTP_SECRET="JBSWY3DPEHPK3PXP"
PORT4=$((PORT + 3))
DB4="$TMP/totp.db"
STORE4="$TMP/store4"
LOG4="$TMP/server4.log"
mkdir -p "$STORE4"
(
  cd "$BACKEND"
  DATABASE_URL="file:$DB4" npx prisma db push >/dev/null 2>&1
)
(
  cd "$BACKEND"
  exec env PORT="$PORT4" HOST=127.0.0.1 DATABASE_URL="file:$DB4" STORAGE_DIR="$STORE4" \
    ADMIN_SECRET="$ADMIN_SECRET" BASE_DOMAIN=localhost NODE_ENV=production \
    LOGIN_FAIL_THRESHOLD=3 LOGIN_GLOBAL_THRESHOLD=20 LOGIN_IP_COOLDOWN_SEC=60 \
    LOGIN_GLOBAL_COOLDOWN_SEC=60 LOGIN_FAILURE_DELAY_MS=1 \
    ADMIN_TOTP_SECRET="$TOTP_SECRET" \
    node dist/index.js >"$LOG4" 2>&1
) &
SERVER4_PID=$!
B4="http://127.0.0.1:$PORT4"
for _ in $(seq 1 50); do
  curl -sf "$B4/health" >/dev/null 2>&1 && break
  sleep 0.2
done
# Build JSON bodies via printf into variables: a literal comma inside braces in
# the shell source would be brace-expanded into broken -d args (e.g. splitting
# {"a":..,"b":..} into two curls).
BODY="$(printf '{"secret":"%s"}' "$ADMIN_SECRET")"
check "totp: missing code rejected" "401" "$(status_of -X POST -H "Content-Type: application/json" -d "$BODY" "$B4/api/admin/login")"
BODY="$(printf '{"secret":"%s","totp":"%s"}' "$ADMIN_SECRET" "000000")"
check "totp: wrong code rejected" "401" "$(status_of -X POST -H "Content-Type: application/json" -d "$BODY" "$B4/api/admin/login")"
# Mint a valid code with the same module the server verifies against, at wall-clock now.
GOOD_CODE="$(node -e 'const {totpCode}=require(process.argv[1]); process.stdout.write(totpCode(process.argv[2], Math.floor(Date.now()/1000)))' "$BACKEND/dist/auth/totp.js" "$TOTP_SECRET")"
[ -n "$GOOD_CODE" ] || { echo "✗ could not mint a TOTP code"; exit 1; }
BODY="$(printf '{"secret":"%s","totp":"%s"}' "$ADMIN_SECRET" "$GOOD_CODE")"
check "totp: valid code accepted" "200" "$(status_of -X POST -H "Content-Type: application/json" -d "$BODY" "$B4/api/admin/login")"
check "totp: header auth bypasses 2FA -> 200" "200" "$(status_of -H "X-Admin-Secret: $ADMIN_SECRET" "$B4/api/admin/overview")"
kill "$SERVER4_PID" 2>/dev/null; wait "$SERVER4_PID" 2>/dev/null

# --- summary ----------------------------------------------------------------------
echo
echo "== smoke result: $PASS passed, $FAIL failed =="
if [ "$FAIL" -gt 0 ]; then
  printf '  - %s\n' "${FAILURES[@]}"
  exit 1
fi
