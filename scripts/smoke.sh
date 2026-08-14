#!/usr/bin/env bash
#
# R2 Storage smoke test — boots a throwaway backend instance (temp DB + storage
# dir + free port) and exercises the full surface: session auth, admin API, S3
# PUT/GET/HEAD/list, multipart upload, SSE-C, presigned URLs, public buckets,
# logout, and rate limiting. Requires a built backend (npm run build) and `curl` + `node`.
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

# base64 CRC-32 of an ASCII payload (matches S3's x-amz-checksum-crc32 header).
crc32_of() {
  node -e 'const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0}let r=0xffffffff;const s=process.argv[1];for(let i=0;i<s.length;i++){r=(t[(r^s.charCodeAt(i))&0xff]^(r>>>8))>>>0}const x=(r^0xffffffff)>>>0;process.stdout.write(Buffer.from([x>>>24,(x>>>16)&0xff,(x>>>8)&0xff,x&0xff]).toString("base64"))' "$1"
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
    MAINTENANCE_SWEEP_INTERVAL_MS=2000 \
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

# --- conditional writes ---------------------------------------------------------
echo "== conditional writes =="
printf 'first' > "$TMP/cond.txt"
check "PUT baseline cond.txt" "200" "$(status_of -X PUT "${AUTH_OPTS[@]}" --data-binary @"$TMP/cond.txt" "$B/s3/smoke/cond.txt")"
CETAG="$(curl -s -I "${AUTH_OPTS[@]}" "$B/s3/smoke/cond.txt" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)"
[ -n "$CETAG" ] || { echo "✗ no cond.txt ETag"; exit 1; }
check "If-Match wrong etag -> 412" "412" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H 'If-Match: "bogus"' --data-binary 'second' "$B/s3/smoke/cond.txt")"
check "failed If-Match did not overwrite" "first" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke/cond.txt")"
check "If-Match matching etag -> 200" "200" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H "If-Match: $CETAG" --data-binary 'second' "$B/s3/smoke/cond.txt")"
check "If-Match '*' proceeds on existing object" "200" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H 'If-Match: *' --data-binary 'second' "$B/s3/smoke/cond.txt")"
check "If-Unmodified-Since past -> 412" "412" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H 'If-Unmodified-Since: Sat, 01 Jan 2000 00:00:00 GMT' --data-binary 'third' "$B/s3/smoke/cond.txt")"
check "If-Unmodified-Since now -> 200" "200" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H "If-Unmodified-Since: $(date -u +'%a, %d %b %Y %H:%M:%S GMT')" --data-binary 'third' "$B/s3/smoke/cond.txt")"
check "If-None-Match * on existing -> 409" "409" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H 'If-None-Match: *' --data-binary 'fourth' "$B/s3/smoke/cond.txt")"
check "409 guard held (content unchanged)" "third" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke/cond.txt")"
check "If-None-Match * on new key -> 200" "200" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H 'If-None-Match: *' --data-binary 'new' "$B/s3/smoke/cond2.txt")"
check "If-None-Match * on missing -> object created" "new" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke/cond2.txt")"

# --- server-side copy (CopyObject) -------------------------------------------------
echo "== CopyObject =="
# A second bucket + an unrestricted key exercise cross-bucket copies.
curl -s -o /dev/null -b "$COOKIES" -X POST -H "Content-Type: application/json" -d '{"name":"smoke2"}' "$B/api/admin/buckets"
RK=$(curl -s -b "$COOKIES" -X POST -H "Content-Type: application/json" -d '{"name":"full","permission":"FULL"}' "$B/api/admin/keys")
RAK="$(json_field "$RK" accessKeyId)"
RSK="$(json_field "$RK" secretAccessKey)"
[ -n "$RAK" ] || { echo "✗ could not parse unrestricted key"; exit 1; }
RCOPY_OPTS=(-H "x-access-key-id: $RAK" -H "x-access-key-secret: $RSK")
check "CopyObject cross-bucket -> 200" "200" "$(status_of "${RCOPY_OPTS[@]}" -X PUT -H "x-amz-copy-source: /smoke/hello.txt" "$B/s3/smoke2/hi.txt")"
check "copied content matches source" "smoke-test-content" "$(curl -s "${RCOPY_OPTS[@]}" "$B/s3/smoke2/hi.txt")"
COPY_ETAG="$(curl -s -I "${RCOPY_OPTS[@]}" "$B/s3/smoke2/hi.txt" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)"
check "copy preserves ETag (content identity)" "$ETAG" "$COPY_ETAG"
check "PUT dest baseline" "200" "$(status_of "${RCOPY_OPTS[@]}" -X PUT --data-binary 'zzz' "$B/s3/smoke2/over.txt")"
check "CopyObject overwrites existing dest" "200" "$(status_of "${RCOPY_OPTS[@]}" -X PUT -H "x-amz-copy-source: /smoke/hello.txt" "$B/s3/smoke2/over.txt")"
check "overwritten dest has source content" "smoke-test-content" "$(curl -s "${RCOPY_OPTS[@]}" "$B/s3/smoke2/over.txt")"
check "REPLACE directive copy -> 200" "200" "$(status_of "${RCOPY_OPTS[@]}" -X PUT -H "x-amz-copy-source: /smoke/hello.txt" -H "x-amz-metadata-directive: REPLACE" -H "Content-Type: text/custom" "$B/s3/smoke2/replaced.txt")"
check "REPLACE directive sets Content-Type" "text/custom" "$(curl -s -D - -o /dev/null "${RCOPY_OPTS[@]}" "$B/s3/smoke2/replaced.txt" | grep -i '^content-type:' | tr -d '\r' | cut -d' ' -f2-)"
check "self-copy without REPLACE -> 400" "400" "$(status_of "${RCOPY_OPTS[@]}" -X PUT -H "x-amz-copy-source: /smoke2/hi.txt" "$B/s3/smoke2/hi.txt")"
check "self-copy with REPLACE -> 200" "200" "$(status_of "${RCOPY_OPTS[@]}" -X PUT -H "x-amz-copy-source: /smoke2/hi.txt" -H "x-amz-metadata-directive: REPLACE" "$B/s3/smoke2/hi.txt")"
check "copy missing source object -> 404" "404" "$(status_of "${RCOPY_OPTS[@]}" -X PUT -H "x-amz-copy-source: /smoke/nope.txt" "$B/s3/smoke2/x.txt")"
check "copy missing source bucket -> 404" "404" "$(status_of "${RCOPY_OPTS[@]}" -X PUT -H "x-amz-copy-source: /nobucket/x.txt" "$B/s3/smoke2/x.txt")"
check "malformed copy-source -> 400" "400" "$(status_of "${RCOPY_OPTS[@]}" -X PUT -H "x-amz-copy-source: not-a-copy-source" "$B/s3/smoke2/x.txt")"
check "scoped key cannot copy cross-bucket -> 403" "403" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H "x-amz-copy-source: /smoke/hello.txt" "$B/s3/smoke2/denied.txt")"
check "copy with If-None-Match: * on existing dest -> 409" "409" "$(status_of "${RCOPY_OPTS[@]}" -X PUT -H "x-amz-copy-source: /smoke/hello.txt" -H 'If-None-Match: *' "$B/s3/smoke2/hi.txt")"

# --- ListBuckets (GET /s3) -----------------------------------------------------
# smoke + smoke2 both exist here. RCOPY_OPTS is an unrestricted key; AUTH_OPTS is
# scoped to bucket "smoke" and must see only its own bucket in the service list.
echo "== ListBuckets =="
check "ListBuckets -> 200" "200" "$(status_of "${RCOPY_OPTS[@]}" "$B/s3")"
check "ListBuckets root element" "1" "$(curl -s "${RCOPY_OPTS[@]}" "$B/s3" | grep -c '<ListAllMyBucketsResult')"
check "ListBuckets lists smoke" "1" "$(curl -s "${RCOPY_OPTS[@]}" "$B/s3" | grep -c '<Name>smoke</Name>')"
check "ListBuckets lists smoke2" "1" "$(curl -s "${RCOPY_OPTS[@]}" "$B/s3" | grep -c '<Name>smoke2</Name>')"
check "ListBuckets total = 2" "2" "$(curl -s "${RCOPY_OPTS[@]}" "$B/s3" | grep -c '<Bucket>')"
check "ListBuckets includes CreationDate" "2" "$(curl -s "${RCOPY_OPTS[@]}" "$B/s3" | grep -c '<CreationDate>')"
check "ListBuckets anonymous -> 403" "403" "$(status_of "$B/s3")"
check "ListBuckets scoped key sees own bucket" "1" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3" | grep -c '<Name>smoke</Name>')"
check "ListBuckets scoped key hides other buckets" "0" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3" | grep -c '<Name>smoke2</Name>')"

# --- batch delete (DeleteObjects) ---------------------------------------------------
echo "== DeleteObjects =="
for k in del1.txt del2.txt del3.txt keep.txt; do
  printf 'data-%s' "$k" > "$TMP/$k"
  status_of -X PUT "${AUTH_OPTS[@]}" --data-binary @"$TMP/$k" "$B/s3/smoke/$k" >/dev/null
done
DEL_XML="<Delete><Object><Key>del1.txt</Key></Object><Object><Key>del2.txt</Key></Object><Object><Key>missing.txt</Key></Object></Delete>"
DEL_RESULT="$(curl -s -X POST "${AUTH_OPTS[@]}" -H "Content-Type: application/xml" --data "$DEL_XML" "$B/s3/smoke?delete")"
check "DeleteObjects -> 200" "200" "$(status_of -X POST "${AUTH_OPTS[@]}" -H "Content-Type: application/xml" --data "$DEL_XML" "$B/s3/smoke?delete")"
check "DeleteObjects echoes deleted keys (non-quiet)" "2" "$(printf '%s' "$DEL_RESULT" | grep -c '<Deleted>')"
check "DeleteObjects reports no errors for missing key" "0" "$(printf '%s' "$DEL_RESULT" | grep -c '<Error>')"
check "batch-deleted del1.txt is gone" "404" "$(status_of -I "${AUTH_OPTS[@]}" "$B/s3/smoke/del1.txt")"
check "batch-deleted del2.txt is gone" "404" "$(status_of -I "${AUTH_OPTS[@]}" "$B/s3/smoke/del2.txt")"
check "unlisted keep.txt survives" "200" "$(status_of -I "${AUTH_OPTS[@]}" "$B/s3/smoke/keep.txt")"
QRESULT="$(curl -s -X POST "${AUTH_OPTS[@]}" -H "Content-Type: application/xml" --data '<Delete><Quiet>true</Quiet><Object><Key>del3.txt</Key></Object></Delete>' "$B/s3/smoke?delete")"
check "quiet DeleteObjects omits Deleted echoes" "0" "$(printf '%s' "$QRESULT" | grep -c '<Deleted>')"
check "quiet-deleted del3.txt is gone" "404" "$(status_of -I "${AUTH_OPTS[@]}" "$B/s3/smoke/del3.txt")"
check "DeleteObjects empty body -> 400" "400" "$(status_of -X POST "${AUTH_OPTS[@]}" -H "Content-Type: application/xml" --data '<Delete></Delete>' "$B/s3/smoke?delete")"
BIGXML="$(node -e 'const ks=Array.from({length:1001},(_,i)=>`<Object><Key>k${i}</Key></Object>`).join("");process.stdout.write(`<Delete>${ks}</Delete>`)')"
check "DeleteObjects >1000 keys -> 400" "400" "$(status_of -X POST "${AUTH_OPTS[@]}" -H "Content-Type: application/xml" --data "$BIGXML" "$B/s3/smoke?delete")"
# Batch delete needs FULL: a read-only key must be refused.
ROKEY=$(curl -s -b "$COOKIES" -X POST -H "Content-Type: application/json" -d '{"name":"ro","permission":"READ_ONLY","bucketFilter":"smoke"}' "$B/api/admin/keys")
ROAK="$(json_field "$ROKEY" accessKeyId)"
ROSK="$(json_field "$ROKEY" secretAccessKey)"
check "DeleteObjects with READ_ONLY key -> 403" "403" "$(status_of -X POST -H "x-access-key-id: $ROAK" -H "x-access-key-secret: $ROSK" -H "Content-Type: application/xml" --data "$DEL_XML" "$B/s3/smoke?delete")"
check "bucket-level POST without ?delete -> 400" "400" "$(status_of -X POST "${AUTH_OPTS[@]}" -H "Content-Type: application/xml" --data '<Delete></Delete>' "$B/s3/smoke")"

# --- object metadata ---------------------------------------------------------------
echo "== object metadata =="
META_OPTS=( -H "x-amz-meta-color: red" -H "x-amz-meta-owner: alice" -H 'Content-Disposition: attachment; filename="report.txt"' -H "Content-Encoding: gzip" -H "Cache-Control: max-age=60" )
printf 'meta-data' > "$TMP/meta.txt"
check "PUT with metadata" "200" "$(status_of -X PUT "${AUTH_OPTS[@]}" "${META_OPTS[@]}" --data-binary @"$TMP/meta.txt" "$B/s3/smoke/meta.txt")"
check "GET returns x-amz-meta-color" "red" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" "$B/s3/smoke/meta.txt" | grep -i '^x-amz-meta-color:' | tr -d '\r' | cut -d' ' -f2-)"
check "GET returns x-amz-meta-owner" "alice" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" "$B/s3/smoke/meta.txt" | grep -i '^x-amz-meta-owner:' | tr -d '\r' | cut -d' ' -f2-)"
check "GET returns Content-Disposition" 'attachment; filename="report.txt"' "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" "$B/s3/smoke/meta.txt" | grep -i '^content-disposition:' | tr -d '\r' | cut -d' ' -f2-)"
check "GET returns Content-Encoding" "gzip" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" "$B/s3/smoke/meta.txt" | grep -i '^content-encoding:' | tr -d '\r' | cut -d' ' -f2-)"
check "stored Cache-Control overrides default" "max-age=60" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" "$B/s3/smoke/meta.txt" | grep -i '^cache-control:' | tr -d '\r' | cut -d' ' -f2-)"
check "default Cache-Control without metadata" "public, max-age=31536000" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" "$B/s3/smoke/hello.txt" | grep -i '^cache-control:' | tr -d '\r' | cut -d' ' -f2-)"
check "HEAD returns metadata too" "red" "$(curl -s -I "${AUTH_OPTS[@]}" "$B/s3/smoke/meta.txt" | grep -i '^x-amz-meta-color:' | tr -d '\r' | cut -d' ' -f2-)"
# CopyObject COPY inherits the source's metadata; REPLACE re-derives it.
check "COPY directive inherits metadata" "red" "$(curl -s -o /dev/null -X PUT "${AUTH_OPTS[@]}" -H "x-amz-copy-source: /smoke/meta.txt" "$B/s3/smoke/meta-copy.txt"; curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" "$B/s3/smoke/meta-copy.txt" | grep -i '^x-amz-meta-color:' | tr -d '\r' | cut -d' ' -f2-)"
check "REPLACE directive swaps metadata" "blue" "$(curl -s -o /dev/null -X PUT "${AUTH_OPTS[@]}" -H "x-amz-copy-source: /smoke/meta.txt" -H "x-amz-metadata-directive: REPLACE" -H "x-amz-meta-color: blue" "$B/s3/smoke/meta-replaced.txt"; curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" "$B/s3/smoke/meta-replaced.txt" | grep -i '^x-amz-meta-color:' | tr -d '\r' | cut -d' ' -f2-)"
check "REPLACE drops inherited metadata" "0" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" "$B/s3/smoke/meta-replaced.txt" | grep -ci '^x-amz-meta-owner:')"
# Multipart: metadata is captured at initiate and lands on the completed object.
METAUP_XML="$(curl -s -X POST "${AUTH_OPTS[@]}" -H "x-amz-meta-shard: 1" "$B/s3/smoke/meta-mp.bin?uploads")"
METAUP_ID="$(printf '%s' "$METAUP_XML" | sed -n 's:.*<UploadId>\([^<]*\)</UploadId>.*:\1:p')"
MPE="$(curl -s -D - -o /dev/null -X PUT "${AUTH_OPTS[@]}" --data-binary 'part1' "$B/s3/smoke/meta-mp.bin?partNumber=1&uploadId=$METAUP_ID" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)"
curl -s -o /dev/null -X POST "${AUTH_OPTS[@]}" -H "Content-Type: application/xml" --data "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>$MPE</ETag></Part></CompleteMultipartUpload>" "$B/s3/smoke/meta-mp.bin?uploadId=$METAUP_ID"
check "multipart object carries initiate-time metadata" "1" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" "$B/s3/smoke/meta-mp.bin" | grep -ci '^x-amz-meta-shard: 1')"

# --- listing + subresources --------------------------------------------------------
echo "== listing + subresources =="
printf 'a' > "$TMP/a.txt"
check "seed dir1/a.txt" "200" "$(status_of -X PUT "${AUTH_OPTS[@]}" --data-binary @"$TMP/a.txt" "$B/s3/smoke/dir1/a.txt")"
check "seed dir1/b.txt" "200" "$(status_of -X PUT "${AUTH_OPTS[@]}" --data-binary @"$TMP/a.txt" "$B/s3/smoke/dir1/b.txt")"
DLIST="$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?delimiter=/")"
check "delimiter folds dir1/ into CommonPrefix" "1" "$(printf '%s' "$DLIST" | grep -c '<Prefix>dir1/</Prefix>')"
check "delimiter hides folded keys" "0" "$(printf '%s' "$DLIST" | grep -c 'dir1/a.txt')"
check "delimiter still lists other keys" "1" "$(printf '%s' "$DLIST" | grep -c '<Key>hello.txt</Key>')"
PAGE1="$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?list-type=2&delimiter=/&max-keys=1")"
check "max-keys=1 truncates" "true" "$(printf '%s' "$PAGE1" | sed -n 's:.*<IsTruncated>\([^<]*\)</IsTruncated>.*:\1:p')"
CT="$(printf '%s' "$PAGE1" | sed -n 's:.*<NextContinuationToken>\([^<]*\)</NextContinuationToken>.*:\1:p')"
[ -n "$CT" ] || { echo "✗ no continuation token"; exit 1; }
PAGE2="$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?list-type=2&delimiter=/&continuation-token=$CT")"
check "continuation token resumes past page 1" "1" "$(printf '%s' "$PAGE2" | grep -c '<Key>hello.txt</Key>')"
check "resumed page not truncated" "false" "$(printf '%s' "$PAGE2" | sed -n 's:.*<IsTruncated>\([^<]*\)</IsTruncated>.*:\1:p')"
SA="$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?list-type=2&start-after=dir1/b.txt")"
check "start-after skips prior keys" "1" "$(printf '%s' "$SA" | grep -c '<Key>hello.txt</Key>')"
check "start-after drops dir1/ prefix" "0" "$(printf '%s' "$SA" | grep -c '<Prefix>dir1/</Prefix>')"
check "malformed continuation token -> 400" "400" "$(status_of "${AUTH_OPTS[@]}" "$B/s3/smoke?list-type=2&continuation-token=%25")"

# ListObjectsV1 (the default when list-type is absent) paginates with marker and
# reports NextMarker; older tools (s3cmd, rclone, aws-sdk-v2) speak this dialect.
check "V1 marker skips prior keys" "1" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?marker=dir1/b.txt" | grep -c '<Key>hello.txt</Key>')"
check "V1 marker drops dir1/ prefix" "0" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?marker=dir1/b.txt" | grep -c '<Prefix>dir1/</Prefix>')"
V1PAGE="$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?marker=dir1/b.txt&max-keys=1")"
check "V1 truncation reports NextMarker" "1" "$(printf '%s' "$V1PAGE" | grep -c '<NextMarker>')"
V1M="$(printf '%s' "$V1PAGE" | sed -n 's:.*<NextMarker>\([^<]*\)</NextMarker>.*:\1:p')"
[ -n "$V1M" ] || { echo "✗ no V1 NextMarker"; exit 1; }
check "V1 marker resumes past NextMarker" "1" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?marker=$V1M" | grep -c '<Key>meta-mp.bin</Key>')"
check "V1 listing omits V2-only elements" "0" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke" | grep -c '<KeyCount>\|<StartAfter>\|<NextContinuationToken>')"
check "V1 encoding-type=url encodes keys" "1" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?encoding-type=url" | grep -c '<Key>dir1%2Fa.txt</Key>')"
check "V1 encoding-type=url reports EncodingType" "url" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?encoding-type=url" | sed -n 's:.*<EncodingType>\([^<]*\)</EncodingType>.*:\1:p')"
check "GetBucketLocation" "1" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?location" | grep -c '<LocationConstraint')"
check "HeadBucket" "200" "$(status_of -I "${AUTH_OPTS[@]}" "$B/s3/smoke")"
check "HeadBucket missing -> 404" "404" "$(status_of -I "${AUTH_OPTS[@]}" "$B/s3/no-such-bucket")"
check "max-keys=0 returns empty list" "0" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?max-keys=0" | grep -c '<Key>')"

# --- response overrides + read preconditions + Content-MD5 --------------------------
echo "== response overrides + preconditions + Content-MD5 =="
check "response-content-type override" "text/x-test" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" "$B/s3/smoke/hello.txt?response-content-type=text%2Fx-test" | grep -i '^content-type:' | tr -d '\r' | cut -d' ' -f2-)"
check "response-content-disposition override" "inline" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" "$B/s3/smoke/hello.txt?response-content-disposition=inline" | grep -i '^content-disposition:' | tr -d '\r' | cut -d' ' -f2-)"
check "response-cache-control override" "no-cache" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" "$B/s3/smoke/hello.txt?response-cache-control=no-cache" | grep -i '^cache-control:' | tr -d '\r' | cut -d' ' -f2-)"
HE_ETAG="$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" "$B/s3/smoke/hello.txt" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)"
check "If-Match wrong etag -> 412" "412" "$(status_of "${AUTH_OPTS[@]}" -H 'If-Match: "deadbeef"' "$B/s3/smoke/hello.txt")"
check "If-Match correct etag -> 200" "200" "$(status_of "${AUTH_OPTS[@]}" -H "If-Match: $HE_ETAG" "$B/s3/smoke/hello.txt")"
check "If-Unmodified-Since past -> 412" "412" "$(status_of "${AUTH_OPTS[@]}" -H 'If-Unmodified-Since: Sun, 01 Jan 2020 00:00:00 GMT' "$B/s3/smoke/hello.txt")"
MD5OK="$(printf 'md5-check' | openssl dgst -md5 -binary | base64)"
check "PUT with correct Content-MD5" "200" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H "Content-MD5: $MD5OK" --data-binary 'md5-check' "$B/s3/smoke/md5check.txt")"
check "PUT with wrong Content-MD5 -> 400" "400" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H 'Content-MD5: QUJDRA==' --data-binary 'md5-check' "$B/s3/smoke/md5bad.txt")"
check "rejected Content-MD5 object not stored" "404" "$(status_of "${AUTH_OPTS[@]}" "$B/s3/smoke/md5bad.txt")"
check "PUT with malformed Content-MD5 -> 400" "400" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H 'Content-MD5: not-base64!!' --data-binary 'md5-check' "$B/s3/smoke/md5bad2.txt")"

# --- CRC-32 checksums (aws-sdk-v3 default) ---------------------------------
CRC_OK="$(crc32_of 'crc-check')"
check "PUT with correct x-amz-checksum-crc32" "200" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H "x-amz-checksum-crc32: $CRC_OK" --data-binary 'crc-check' "$B/s3/smoke/crccheck.txt")"
check "GET checksum-mode echoes x-amz-checksum-crc32" "$CRC_OK" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" -H 'x-amz-checksum-mode: enabled' "$B/s3/smoke/crccheck.txt" | grep -i '^x-amz-checksum-crc32:' | tr -d '\r' | cut -d' ' -f2-)"
check "GET checksum-mode reports FULL_OBJECT type" "1" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" -H 'x-amz-checksum-mode: enabled' "$B/s3/smoke/crccheck.txt" | grep -ci '^x-amz-checksum-type: FULL_OBJECT')"
check "GET without checksum-mode omits checksum header" "0" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" "$B/s3/smoke/crccheck.txt" | grep -ci '^x-amz-checksum-crc32:')"
check "GET checksum-mode invalid value -> 400" "400" "$(status_of "${AUTH_OPTS[@]}" -H 'x-amz-checksum-mode: bogus' "$B/s3/smoke/crccheck.txt")"
check "PUT with wrong x-amz-checksum-crc32 -> 400" "400" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H 'x-amz-checksum-crc32: AAAA==' --data-binary 'crc-check' "$B/s3/smoke/crcbad.txt")"
check "rejected checksum object not stored" "404" "$(status_of "${AUTH_OPTS[@]}" "$B/s3/smoke/crcbad.txt")"
check "CopyObject inherits source checksum" "$CRC_OK" "$(curl -s -o /dev/null -X PUT "${AUTH_OPTS[@]}" -H 'x-amz-copy-source: /smoke/crccheck.txt' "$B/s3/smoke/crc-copy.txt"; curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" -H 'x-amz-checksum-mode: enabled' "$B/s3/smoke/crc-copy.txt" | grep -i '^x-amz-checksum-crc32:' | tr -d '\r' | cut -d' ' -f2-)"

# --- object tags -----------------------------------------------------------------
echo "== object tags =="
printf 'tagged' > "$TMP/tagged.txt"
check "PUT with x-amz-tagging" "200" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H 'x-amz-tagging: color=red&env=prod' --data-binary @"$TMP/tagged.txt" "$B/s3/smoke/tagged.txt")"
check "GET reports x-amz-tagging-count" "2" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" "$B/s3/smoke/tagged.txt" | grep -i '^x-amz-tagging-count:' | tr -d '\r' | cut -d' ' -f2-)"
check "GET ?tagging lists tags" "1" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke/tagged.txt?tagging" | grep -c '<Key>color</Key><Value>red</Value>')"
TAGBODY='<Tagging><TagSet><Tag><Key>newtag</Key><Value>yes</Value></Tag></TagSet></Tagging>'
TAGMD5="$(printf '%s' "$TAGBODY" | openssl dgst -md5 -binary | base64)"
check "PUT ?tagging replaces tags" "200" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H "Content-MD5: $TAGMD5" --data "$TAGBODY" "$B/s3/smoke/tagged.txt?tagging")"
check "replaced tags visible" "1" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke/tagged.txt?tagging" | grep -c '<Key>newtag</Key><Value>yes</Value>')"
check "old tag gone" "0" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke/tagged.txt?tagging" | grep -c '<Key>color</Key>')"
check "PUT ?tagging wrong Content-MD5 -> 400" "400" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H 'Content-MD5: QUJDRA==' --data "$TAGBODY" "$B/s3/smoke/tagged.txt?tagging")"
check "PUT ?tagging malformed XML -> 400" "400" "$(status_of -X PUT "${AUTH_OPTS[@]}" --data '<Tagging><TagSet><Tag><Key>x</Key>' "$B/s3/smoke/tagged.txt?tagging")"
check "PUT ?tagging missing object -> 404" "404" "$(status_of -X PUT "${AUTH_OPTS[@]}" --data "$TAGBODY" "$B/s3/smoke/nope.txt?tagging")"
check "GET ?tagging missing object -> 404" "404" "$(status_of "${AUTH_OPTS[@]}" "$B/s3/smoke/nope.txt?tagging")"
check "DELETE ?tagging clears tags" "204" "$(status_of -X DELETE "${AUTH_OPTS[@]}" "$B/s3/smoke/tagged.txt?tagging")"
check "cleared tags drop tagging-count header" "0" "$(curl -s -D - -o /dev/null "${AUTH_OPTS[@]}" "$B/s3/smoke/tagged.txt" | grep -ci '^x-amz-tagging-count:')"
check "PUT with duplicate x-amz-tagging -> 400" "400" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H 'x-amz-tagging: color=red&color=blue' --data-binary x "$B/s3/smoke/tagbad.txt")"
check "CopyObject COPY inherits tags" "1" "$(curl -s -o /dev/null -X PUT "${AUTH_OPTS[@]}" -H 'x-amz-tagging: color=red' --data-binary x "$B/s3/smoke/tagged2.txt"; curl -s -o /dev/null -X PUT "${AUTH_OPTS[@]}" -H 'x-amz-copy-source: /smoke/tagged2.txt' "$B/s3/smoke/tag-copy.txt"; curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke/tag-copy.txt?tagging" | grep -c '<Key>color</Key><Value>red</Value>')"
check "CopyObject REPLACE swaps tags" "1" "$(curl -s -o /dev/null -X PUT "${AUTH_OPTS[@]}" -H 'x-amz-copy-source: /smoke/tagged2.txt' -H 'x-amz-tagging-directive: REPLACE' -H 'x-amz-tagging: new=yes' "$B/s3/smoke/tag-replaced.txt"; curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke/tag-replaced.txt?tagging" | grep -c '<Key>new</Key><Value>yes</Value>')"

# --- bucket subresources + GetObjectAttributes -----------------------------------
echo "== bucket subresources + GetObjectAttributes =="
check "bucket ?versioning -> 200" "1" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?versioning" | grep -c '<VersioningConfiguration')"
check "bucket ?acl -> 200" "1" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?acl" | grep -c '<AccessControlPolicy')"
check "bucket ?cors -> 200" "1" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?cors" | grep -c '<AllowedOrigin>')"
check "bucket ?policy -> 404" "404" "$(status_of "${AUTH_OPTS[@]}" "$B/s3/smoke?policy")"
check "bucket ?lifecycle -> 404" "404" "$(status_of "${AUTH_OPTS[@]}" "$B/s3/smoke?lifecycle")"
check "bucket ?replication -> 501" "501" "$(status_of "${AUTH_OPTS[@]}" "$B/s3/smoke?replication")"
check "listing unaffected by subresources" "1" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke" | grep -c '<ListBucketResult')"
check "GetObjectAttributes" "1" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke/hello.txt?attributes" | grep -c '<GetObjectAttributesResponse')"
check "GetObjectAttributes size" "18" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke/hello.txt?attributes" | sed -n 's:.*<ObjectSize>\([0-9]*\)</ObjectSize>.*:\1:p')"
check "GetObjectAttributes checksum block" "1" "$(curl -s "${AUTH_OPTS[@]}" -H 'x-amz-checksum-mode: enabled' "$B/s3/smoke/crccheck.txt?attributes" | grep -c '<ChecksumCRC32>')"
check "GetObjectAttributes missing -> 404" "404" "$(status_of "${AUTH_OPTS[@]}" "$B/s3/smoke/nope.txt?attributes")"

# --- bucket CORS (PutBucketCors + preflight) ------------------------------------
# smoke2 carries a single-rule CORS config: only https://app.example.com with
# PUT/GET. Preflight OPTIONS is answered without auth (the follow-up request
# carries credentials); a disallowed origin/method gets 403 AccessForbidden.
echo "== bucket CORS =="
CORS_BODY='<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><CORSRule><AllowedOrigin>https://app.example.com</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>'
CORSMD5="$(printf '%s' "$CORS_BODY" | openssl dgst -md5 -binary | base64)"
check "PUT ?cors (with Content-MD5)" "200" "$(status_of -X PUT "${RCOPY_OPTS[@]}" -H "Content-MD5: $CORSMD5" --data "$CORS_BODY" "$B/s3/smoke2?cors")"
check "GET ?cors returns config" "1" "$(curl -s "${RCOPY_OPTS[@]}" "$B/s3/smoke2?cors" | grep -c '<CORSConfiguration')"
check "GET ?cors echoes origin" "1" "$(curl -s "${RCOPY_OPTS[@]}" "$B/s3/smoke2?cors" | grep -c '<AllowedOrigin>https://app.example.com</AllowedOrigin>')"
check "GET ?cors echoes method" "1" "$(curl -s "${RCOPY_OPTS[@]}" "$B/s3/smoke2?cors" | grep -c '<AllowedMethod>PUT</AllowedMethod>')"
check "GET ?cors echoes MaxAgeSeconds" "1" "$(curl -s "${RCOPY_OPTS[@]}" "$B/s3/smoke2?cors" | grep -c '<MaxAgeSeconds>3600</MaxAgeSeconds>')"
check "PUT ?cors wrong Content-MD5 -> 400" "400" "$(status_of -X PUT "${RCOPY_OPTS[@]}" -H 'Content-MD5: QUJDRA==' --data "$CORS_BODY" "$B/s3/smoke2?cors")"
check "PUT ?cors missing AllowedOrigin -> 400" "400" "$(status_of -X PUT "${RCOPY_OPTS[@]}" --data '<CORSConfiguration><CORSRule><AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>' "$B/s3/smoke2?cors")"
check "PUT ?cors bad method -> 400" "400" "$(status_of -X PUT "${RCOPY_OPTS[@]}" --data '<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>FOO</AllowedMethod></CORSRule></CORSConfiguration>' "$B/s3/smoke2?cors")"
check "preflight allowed origin -> 200" "200" "$(status_of -X OPTIONS -H 'Origin: https://app.example.com' -H 'Access-Control-Request-Method: PUT' "$B/s3/smoke2/hi.txt")"
check "preflight echoes allow-origin" "https://app.example.com" "$(curl -s -D - -o /dev/null -X OPTIONS -H 'Origin: https://app.example.com' -H 'Access-Control-Request-Method: PUT' "$B/s3/smoke2/hi.txt" | grep -i '^access-control-allow-origin:' | tr -d '\r' | cut -d' ' -f2-)"
check "preflight reports allow-methods" "1" "$(curl -s -D - -o /dev/null -X OPTIONS -H 'Origin: https://app.example.com' -H 'Access-Control-Request-Method: PUT' "$B/s3/smoke2/hi.txt" | grep -i '^access-control-allow-methods:' | grep -c PUT)"
check "preflight echoes requested headers" "1" "$(curl -s -D - -o /dev/null -X OPTIONS -H 'Origin: https://app.example.com' -H 'Access-Control-Request-Method: PUT' -H 'Access-Control-Request-Headers: content-type, x-amz-checksum-crc32' "$B/s3/smoke2/hi.txt" | grep -i '^access-control-allow-headers:' | grep -c 'x-amz-checksum-crc32')"
check "preflight reports max-age" "3600" "$(curl -s -D - -o /dev/null -X OPTIONS -H 'Origin: https://app.example.com' -H 'Access-Control-Request-Method: PUT' "$B/s3/smoke2/hi.txt" | grep -i '^access-control-max-age:' | tr -d '\r' | cut -d' ' -f2)"
check "preflight disallowed origin -> 403" "403" "$(status_of -X OPTIONS -H 'Origin: https://evil.example.com' -H 'Access-Control-Request-Method: PUT' "$B/s3/smoke2/hi.txt")"
check "preflight method not allowed -> 403" "403" "$(status_of -X OPTIONS -H 'Origin: https://app.example.com' -H 'Access-Control-Request-Method: DELETE' "$B/s3/smoke2/hi.txt")"
check "GET object echoes matched origin" "https://app.example.com" "$(curl -s -D - -o /dev/null -H 'Origin: https://app.example.com' "${RCOPY_OPTS[@]}" "$B/s3/smoke2/hi.txt" | grep -i '^access-control-allow-origin:' | tr -d '\r' | cut -d' ' -f2-)"
check "GET object unmatching origin omits ACAO" "0" "$(curl -s -D - -o /dev/null -H 'Origin: https://evil.example.com' "${RCOPY_OPTS[@]}" "$B/s3/smoke2/hi.txt" | grep -ci '^access-control-allow-origin:')"
check "DELETE ?cors clears config" "204" "$(status_of -X DELETE "${RCOPY_OPTS[@]}" "$B/s3/smoke2?cors")"
check "GET ?cors after delete drops rules" "0" "$(curl -s "${RCOPY_OPTS[@]}" "$B/s3/smoke2?cors" | grep -c 'app.example.com')"
check "preflight after delete -> 403" "403" "$(status_of -X OPTIONS -H 'Origin: https://app.example.com' -H 'Access-Control-Request-Method: PUT' "$B/s3/smoke2/hi.txt")"
check "legacy admin origin still served after delete" "1" "$(curl -s "${RCOPY_OPTS[@]}" "$B/s3/smoke2?cors" | grep -c '<AllowedOrigin>\*</AllowedOrigin>')"

# --- bucket tagging (PutBucketTagging) -------------------------------------------
echo "== bucket tagging =="
BTAG_BODY='<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet><Tag><Key>env</Key><Value>prod</Value></Tag><Tag><Key>team</Key><Value>media</Value></Tag></TagSet></Tagging>'
BTAGMD5="$(printf '%s' "$BTAG_BODY" | openssl dgst -md5 -binary | base64)"
check "PUT bucket ?tagging (with Content-MD5)" "200" "$(status_of -X PUT "${RCOPY_OPTS[@]}" -H "Content-MD5: $BTAGMD5" --data "$BTAG_BODY" "$B/s3/smoke2?tagging")"
check "GET bucket ?tagging returns tags" "1" "$(curl -s "${RCOPY_OPTS[@]}" "$B/s3/smoke2?tagging" | grep -c '<Key>env</Key><Value>prod</Value>')"
check "GET bucket ?tagging second tag" "1" "$(curl -s "${RCOPY_OPTS[@]}" "$B/s3/smoke2?tagging" | grep -c '<Key>team</Key><Value>media</Value>')"
check "PUT bucket ?tagging wrong Content-MD5 -> 400" "400" "$(status_of -X PUT "${RCOPY_OPTS[@]}" -H 'Content-MD5: QUJDRA==' --data "$BTAG_BODY" "$B/s3/smoke2?tagging")"
check "PUT bucket ?tagging malformed XML -> 400" "400" "$(status_of -X PUT "${RCOPY_OPTS[@]}" --data '<Tagging><TagSet><Tag><Key>x</Key>' "$B/s3/smoke2?tagging")"
check "DELETE bucket ?tagging clears" "204" "$(status_of -X DELETE "${RCOPY_OPTS[@]}" "$B/s3/smoke2?tagging")"
check "GET bucket ?tagging empty after delete" "1" "$(curl -s "${RCOPY_OPTS[@]}" "$B/s3/smoke2?tagging" | grep -c '<TagSet')"
check "bucket-level PUT ?policy -> 400" "400" "$(status_of -X PUT "${RCOPY_OPTS[@]}" --data x "$B/s3/smoke2?policy")"

# --- SSE-C (validate + echo compatibility surface) ------------------------------
# The server adopts S3's SSE-C wire protocol but stores blobs with its own
# server-managed AES-256-GCM key: the customer key trio is validated (well-formed
# base64 256-bit key + matching base64 key-MD5) and echoed back, never stored or
# derived from — so any well-formed key reads any object (see ssec.ts).
echo "== SSE-C =="
SSEC_KEY_B64="$(openssl rand -base64 32)"
SSEC_KEY_MD5="$(node -e "process.stdout.write(require('crypto').createHash('md5').update(Buffer.from(process.argv[1],'base64')).digest('base64'))" "$SSEC_KEY_B64")"
SSEC_OPTS=(-H "x-amz-server-side-encryption-customer-algorithm: AES256" -H "x-amz-server-side-encryption-customer-key: $SSEC_KEY_B64" -H "x-amz-server-side-encryption-customer-key-MD5: $SSEC_KEY_MD5")
SSEC_ALL=("${AUTH_OPTS[@]}" "${SSEC_OPTS[@]}")

check "SSE-C PUT -> 200" "200" "$(status_of -X PUT "${SSEC_ALL[@]}" --data-binary 'ssec-secret' "$B/s3/smoke/ssec.txt")"
check "SSE-C PUT echoes algorithm" "AES256" "$(curl -s -D - -o /dev/null -X PUT "${SSEC_ALL[@]}" --data-binary 'ssec-secret' "$B/s3/smoke/ssec.txt" | grep -i '^x-amz-server-side-encryption-customer-algorithm:' | tr -d '\r' | cut -d' ' -f2-)"
check "SSE-C PUT echoes key-MD5" "$SSEC_KEY_MD5" "$(curl -s -D - -o /dev/null -X PUT "${SSEC_ALL[@]}" --data-binary 'ssec-secret' "$B/s3/smoke/ssec.txt" | grep -i '^x-amz-server-side-encryption-customer-key-md5:' | tr -d '\r' | cut -d' ' -f2-)"
check "SSE-C GET returns object" "ssec-secret" "$(curl -s "${SSEC_ALL[@]}" "$B/s3/smoke/ssec.txt")"
check "SSE-C GET echoes algorithm" "1" "$(curl -s -D - -o /dev/null "${SSEC_ALL[@]}" "$B/s3/smoke/ssec.txt" | grep -ci '^x-amz-server-side-encryption-customer-algorithm: AES256')"
check "SSE-C HEAD -> 200" "200" "$(status_of -I "${SSEC_ALL[@]}" "$B/s3/smoke/ssec.txt")"
check "SSE-C object readable without key headers (facade)" "ssec-secret" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke/ssec.txt")"
OTHER_KEY="$(openssl rand -base64 32)"
OTHER_MD5="$(node -e "process.stdout.write(require('crypto').createHash('md5').update(Buffer.from(process.argv[1],'base64')).digest('base64'))" "$OTHER_KEY")"
check "SSE-C GET with a different valid key still works (facade)" "ssec-secret" "$(curl -s "${AUTH_OPTS[@]}" -H "x-amz-server-side-encryption-customer-algorithm: AES256" -H "x-amz-server-side-encryption-customer-key: $OTHER_KEY" -H "x-amz-server-side-encryption-customer-key-MD5: $OTHER_MD5" "$B/s3/smoke/ssec.txt")"

check "SSE-C algorithm without key -> 400" "400" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H "x-amz-server-side-encryption-customer-algorithm: AES256" --data x "$B/s3/smoke/ssec-bad.txt")"
check "SSE-C unsupported algorithm -> 400" "400" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H "x-amz-server-side-encryption-customer-algorithm: AES128" -H "x-amz-server-side-encryption-customer-key: $SSEC_KEY_B64" -H "x-amz-server-side-encryption-customer-key-MD5: $SSEC_KEY_MD5" --data x "$B/s3/smoke/ssec-bad.txt")"
SHORT_KEY="$(openssl rand -base64 16)"
SHORT_MD5="$(node -e "process.stdout.write(require('crypto').createHash('md5').update(Buffer.from(process.argv[1],'base64')).digest('base64'))" "$SHORT_KEY")"
check "SSE-C key wrong size -> 400" "400" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H "x-amz-server-side-encryption-customer-algorithm: AES256" -H "x-amz-server-side-encryption-customer-key: $SHORT_KEY" -H "x-amz-server-side-encryption-customer-key-MD5: $SHORT_MD5" --data x "$B/s3/smoke/ssec-bad.txt")"
check "SSE-C malformed base64 key -> 400" "400" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H "x-amz-server-side-encryption-customer-algorithm: AES256" -H "x-amz-server-side-encryption-customer-key: not-base64!" -H "x-amz-server-side-encryption-customer-key-MD5: $SSEC_KEY_MD5" --data x "$B/s3/smoke/ssec-bad.txt")"
check "SSE-C wrong key MD5 -> 400" "400" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H "x-amz-server-side-encryption-customer-algorithm: AES256" -H "x-amz-server-side-encryption-customer-key: $SSEC_KEY_B64" -H "x-amz-server-side-encryption-customer-key-MD5: QUJDRA==" --data x "$B/s3/smoke/ssec-bad.txt")"
check "SSE-C GET with bad trio -> 400" "400" "$(status_of "${AUTH_OPTS[@]}" -H "x-amz-server-side-encryption-customer-algorithm: AES256" "$B/s3/smoke/ssec.txt")"

SRCSSEC=(-H "x-amz-copy-source-server-side-encryption-customer-algorithm: AES256" -H "x-amz-copy-source-server-side-encryption-customer-key: $SSEC_KEY_B64" -H "x-amz-copy-source-server-side-encryption-customer-key-MD5: $SSEC_KEY_MD5")
check "SSE-C CopyObject (dest+source) -> 200" "200" "$(status_of -X PUT "${SSEC_ALL[@]}" "${SRCSSEC[@]}" -H 'x-amz-copy-source: /smoke/ssec.txt' "$B/s3/smoke/ssec-copy.txt")"
check "SSE-C Copy echoes dest algorithm" "1" "$(curl -s -D - -o /dev/null -X PUT "${SSEC_ALL[@]}" "${SRCSSEC[@]}" -H 'x-amz-copy-source: /smoke/ssec.txt' "$B/s3/smoke/ssec-copy.txt" | grep -ci '^x-amz-server-side-encryption-customer-algorithm: AES256')"
check "SSE-C Copy bad source trio -> 400" "400" "$(status_of -X PUT "${SSEC_ALL[@]}" -H 'x-amz-copy-source-server-side-encryption-customer-algorithm: AES256' -H 'x-amz-copy-source: /smoke/ssec.txt' "$B/s3/smoke/ssec-copy.txt")"

check "SSE-C CreateMultipartUpload echoes algorithm" "1" "$(curl -s -D - -o /dev/null "${SSEC_ALL[@]}" -X POST "$B/s3/smoke/ssec-mp.bin?uploads" | grep -ci '^x-amz-server-side-encryption-customer-algorithm: AES256')"
MPSS_XML="$(curl -s "${SSEC_ALL[@]}" -X POST "$B/s3/smoke/ssec-mp.bin?uploads")"
MPSS_ID="$(printf '%s' "$MPSS_XML" | sed -n 's:.*<UploadId>\([^<]*\)</UploadId>.*:\1:p')"
check "SSE-C UploadPart -> 200" "200" "$(status_of -X PUT "${SSEC_ALL[@]}" --data-binary 'part-one' "$B/s3/smoke/ssec-mp.bin?partNumber=1&uploadId=$MPSS_ID")"
check "SSE-C UploadPart echoes algorithm" "1" "$(curl -s -D - -o /dev/null -X PUT "${SSEC_ALL[@]}" --data-binary 'part-one' "$B/s3/smoke/ssec-mp.bin?partNumber=1&uploadId=$MPSS_ID" | grep -ci '^x-amz-server-side-encryption-customer-algorithm: AES256')"
curl -s -o /dev/null "${AUTH_OPTS[@]}" -X DELETE "$B/s3/smoke/ssec-mp.bin?uploadId=$MPSS_ID"
curl -s -o /dev/null "${AUTH_OPTS[@]}" -X DELETE "$B/s3/smoke/ssec.txt"
curl -s -o /dev/null "${AUTH_OPTS[@]}" -X DELETE "$B/s3/smoke/ssec-copy.txt"

# --- bucket lifecycle ----------------------------------------------------------
echo "== bucket lifecycle =="
LIFECYCLE_OK='<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ID>keep30</ID><Filter><Prefix>logs/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>30</Days></Expiration></Rule><Rule><ID>retired</ID><Filter><Prefix>old/</Prefix></Filter><Status>Disabled</Status><Expiration><Days>7</Days></Expiration></Rule></LifecycleConfiguration>'
LIFEMD5="$(printf '%s' "$LIFECYCLE_OK" | openssl dgst -md5 -binary | base64)"
check "PUT ?lifecycle (with Content-MD5)" "200" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H "Content-MD5: $LIFEMD5" --data "$LIFECYCLE_OK" "$B/s3/smoke?lifecycle")"
check "PUT ?lifecycle wrong Content-MD5 -> 400" "400" "$(status_of -X PUT "${AUTH_OPTS[@]}" -H 'Content-MD5: QUJDRA==' --data "$LIFECYCLE_OK" "$B/s3/smoke?lifecycle")"
check "GET ?lifecycle returns config" "1" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?lifecycle" | grep -c '<LifecycleConfiguration')"
check "GET ?lifecycle echoes rule ID" "1" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?lifecycle" | grep -c '<ID>keep30</ID>')"
check "GET ?lifecycle echoes prefix filter" "1" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?lifecycle" | grep -c '<Prefix>logs/</Prefix>')"
check "GET ?lifecycle echoes Enabled+days" "1" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?lifecycle" | grep -c '<Status>Enabled</Status>')"
check "GET ?lifecycle echoes Disabled rule" "1" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?lifecycle" | grep -c '<Status>Disabled</Status>')"
check "PUT ?lifecycle malformed XML -> 400" "400" "$(status_of -X PUT "${AUTH_OPTS[@]}" --data '<LifecycleConfiguration><Rule><Status>Enabled</Status>' "$B/s3/smoke?lifecycle")"
check "PUT ?lifecycle missing expiration -> 400" "400" "$(status_of -X PUT "${AUTH_OPTS[@]}" --data '<LifecycleConfiguration><Rule><ID>x</ID><Filter><Prefix>a/</Prefix></Filter><Status>Enabled</Status></Rule></LifecycleConfiguration>' "$B/s3/smoke?lifecycle")"
check "PUT ?lifecycle days=0 -> 400" "400" "$(status_of -X PUT "${AUTH_OPTS[@]}" --data '<LifecycleConfiguration><Rule><Filter><Prefix>a/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>0</Days></Expiration></Rule></LifecycleConfiguration>' "$B/s3/smoke?lifecycle")"
check "PUT ?lifecycle days+date conflict -> 400" "400" "$(status_of -X PUT "${AUTH_OPTS[@]}" --data '<LifecycleConfiguration><Rule><Filter><Prefix>a/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>1</Days><Date>2026-01-01</Date></Expiration></Rule></LifecycleConfiguration>' "$B/s3/smoke?lifecycle")"
check "PUT ?lifecycle unknown bucket -> 404" "404" "$(status_of -X PUT "${AUTH_OPTS[@]}" --data "$LIFECYCLE_OK" "$B/s3/no-such-bucket?lifecycle")"
check "bucket-level PUT without subresource -> 400" "400" "$(status_of -X PUT "${AUTH_OPTS[@]}" --data x "$B/s3/smoke")"
check "bucket-level DELETE without subresource -> 400" "400" "$(status_of -X DELETE "${AUTH_OPTS[@]}" "$B/s3/smoke")"

# Expiry e2e: a past-date rule + the 2s sweep interval must delete matching
# objects. A dedicated prefix keeps the other smoke objects untouched.
check "seed object for expiry" "200" "$(status_of -X PUT "${AUTH_OPTS[@]}" --data-binary 'doomed' "$B/s3/smoke/expired/doomed.txt")"
LIFEEXPIRE='<LifecycleConfiguration><Rule><ID>now</ID><Filter><Prefix>expired/</Prefix></Filter><Status>Enabled</Status><Expiration><Date>2000-01-01</Date></Expiration></Rule></LifecycleConfiguration>'
check "PUT ?lifecycle past-date rule" "200" "$(status_of -X PUT "${AUTH_OPTS[@]}" --data "$LIFEEXPIRE" "$B/s3/smoke?lifecycle")"
sleep 3
check "past-date rule expires object (GET 404)" "404" "$(status_of "${AUTH_OPTS[@]}" "$B/s3/smoke/expired/doomed.txt")"
check "expired object gone from listing" "0" "$(curl -s "${AUTH_OPTS[@]}" "$B/s3/smoke?list-type=2&prefix=expired/" | grep -c 'doomed.txt')"
check "unrelated keys survive the sweep" "200" "$(status_of "${AUTH_OPTS[@]}" "$B/s3/smoke/hello.txt")"

check "DELETE ?lifecycle" "204" "$(status_of -X DELETE "${AUTH_OPTS[@]}" "$B/s3/smoke?lifecycle")"
check "GET ?lifecycle after delete -> 404" "404" "$(status_of "${AUTH_OPTS[@]}" "$B/s3/smoke?lifecycle")"

# --- multipart ------------------------------------------------------------------
echo "== multipart upload =="
R=$(curl -s -X POST -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" -H 'x-amz-tagging: mp=1' "$B/s3/smoke/big.bin?uploads")
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

# ListParts + ListMultipartUploads let SDKs inspect an upload before completing.
LPXML="$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/big.bin?uploadId=$UPLOAD_ID")"
check "ListParts lists part 1" "1" "$(printf '%s' "$LPXML" | grep -c '<PartNumber>1</PartNumber>')"
check "ListParts lists part 2 size" "8" "$(printf '%s' "$LPXML" | perl -0777 -ne 'if (/<PartNumber>2<\/PartNumber>.*?<Size>(\d+)<\/Size>/s) { print $1 }')"
check "ListParts not truncated" "false" "$(printf '%s' "$LPXML" | sed -n 's:.*<IsTruncated>\([^<]*\)</IsTruncated>.*:\1:p')"
check "ListParts unknown upload -> 404" "404" "$(status_of -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/big.bin?uploadId=nope")"
check "ListParts wrong key for upload -> 404" "404" "$(status_of -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/other.bin?uploadId=$UPLOAD_ID")"
check "ListMultipartUploads shows in-progress upload" "1" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke?uploads" | grep -c "$UPLOAD_ID")"
check "ListParts max-parts truncates" "true" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/big.bin?uploadId=$UPLOAD_ID&max-parts=1" | sed -n 's:.*<IsTruncated>\([^<]*\)</IsTruncated>.*:\1:p')"
check "ListParts part-number-marker resumes" "1" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/big.bin?uploadId=$UPLOAD_ID&part-number-marker=1" | grep -c '<PartNumber>2</PartNumber>')"
check "ListParts marker excludes earlier part" "0" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/big.bin?uploadId=$UPLOAD_ID&part-number-marker=1" | grep -c '<PartNumber>1</PartNumber>')"

# ListMultipartUploads pagination + filtering (SDKs page in-progress uploads).
# Seed five uploads: two paginated keys, two sharing one key (upload-id-marker
# resume), and a key with a space (encoding-type=url).
PAG_A="$(printf '%s' "$(curl -s -X POST -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/pag/2026/a.bin?uploads")" | sed -n 's:.*<UploadId>\([^<]*\)</UploadId>.*:\1:p')"
PAG_B="$(printf '%s' "$(curl -s -X POST -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/pag/2027/b.bin?uploads")" | sed -n 's:.*<UploadId>\([^<]*\)</UploadId>.*:\1:p')"
DUP1="$(printf '%s' "$(curl -s -X POST -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/dup.bin?uploads")" | sed -n 's:.*<UploadId>\([^<]*\)</UploadId>.*:\1:p')"
DUP2="$(printf '%s' "$(curl -s -X POST -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/dup.bin?uploads")" | sed -n 's:.*<UploadId>\([^<]*\)</UploadId>.*:\1:p')"
SPACE_ID="$(printf '%s' "$(curl -s -X POST -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/space%20key.bin?uploads")" | sed -n 's:.*<UploadId>\([^<]*\)</UploadId>.*:\1:p')"
[ -n "$PAG_A" ] && [ -n "$PAG_B" ] && [ -n "$DUP1" ] && [ -n "$DUP2" ] && [ -n "$SPACE_ID" ] || { echo "✗ no pagination UploadIds"; exit 1; }

check "uploads prefix filters keys" "1" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke?uploads&prefix=pag/" | grep -c '<Key>pag/2026/a.bin</Key>')"
check "uploads prefix excludes others" "0" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke?uploads&prefix=pag/" | grep -c '<Key>dup.bin</Key>')"
check "uploads delimiter folds CommonPrefixes" "2" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke?uploads&prefix=pag/&delimiter=/" | grep -c '<CommonPrefixes>')"
check "uploads delimiter folds the right prefixes" "1" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke?uploads&prefix=pag/&delimiter=/" | grep -c '<Prefix>pag/2027/</Prefix>')"
check "uploads max-uploads truncates" "true" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke?uploads&prefix=pag/&max-uploads=1" | sed -n 's:.*<IsTruncated>\([^<]*\)</IsTruncated>.*:\1:p')"
check "uploads NextUploadIdMarker echoes last" "$PAG_A" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke?uploads&prefix=pag/&max-uploads=1" | sed -n 's:.*<NextUploadIdMarker>\([^<]*\)</NextUploadIdMarker>.*:\1:p')"
check "uploads key-marker skips marker key" "0" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke?uploads&prefix=pag/&key-marker=pag/2026/a.bin" | grep -c '<Key>pag/2026/a.bin</Key>')"
check "uploads key-marker returns later key" "1" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke?uploads&prefix=pag/&key-marker=pag/2026/a.bin" | grep -c '<Key>pag/2027/b.bin</Key>')"
DUP_IDS="$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke?uploads&prefix=dup.bin" | sed -n 's:.*<UploadId>\([^<]*\)</UploadId>.*:\1:p' | sort)"
DUP_LOW="$(printf '%s\n' "$DUP_IDS" | head -1)"
DUP_HIGH="$(printf '%s\n' "$DUP_IDS" | tail -1)"
check "uploads upload-id-marker resumes within key" "$DUP_HIGH" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke?uploads&prefix=dup.bin&key-marker=dup.bin&upload-id-marker=$DUP_LOW" | sed -n 's:.*<UploadId>\([^<]*\)</UploadId>.*:\1:p')"
check "uploads bare key-marker skips whole key" "0" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke?uploads&prefix=dup.bin&key-marker=dup.bin" | grep -c '<Key>dup.bin</Key>')"
check "uploads encoding-type=url encodes keys" "1" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke?uploads&encoding-type=url" | grep -c '<Key>space%20key.bin</Key>')"
check "uploads encoding-type=url announced" "1" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke?uploads&encoding-type=url" | grep -c '<EncodingType>url</EncodingType>')"
check "uploads raw key without encoding-type" "1" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke?uploads" | grep -c '<Key>space key.bin</Key>')"

check "abort seeded upload A" "204" "$(status_of -X DELETE -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/pag/2026/a.bin?uploadId=$PAG_A")"
check "abort seeded upload B" "204" "$(status_of -X DELETE -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/pag/2027/b.bin?uploadId=$PAG_B")"
check "abort seeded upload DUP1" "204" "$(status_of -X DELETE -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/dup.bin?uploadId=$DUP1")"
check "abort seeded upload DUP2" "204" "$(status_of -X DELETE -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/dup.bin?uploadId=$DUP2")"
check "abort seeded space-key upload" "204" "$(status_of -X DELETE -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/space%20key.bin?uploadId=$SPACE_ID")"
check "seeded uploads cleaned up" "0" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke?uploads&prefix=pag/" | grep -c '<Upload>')"

# UploadPart checksum integrity (part 3 is uploaded but never completed, so the
# assembled big.bin stays part-one+part-two).
PC_OK="$(crc32_of 'part-three')"
check "UploadPart with correct x-amz-checksum-crc32" "200" "$(status_of -X PUT -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" -H "x-amz-checksum-crc32: $PC_OK" --data-binary 'part-three' "$B/s3/smoke/big.bin?partNumber=3&uploadId=$UPLOAD_ID")"
check "UploadPart wrong x-amz-checksum-crc32 -> 400" "400" "$(status_of -X PUT -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" -H 'x-amz-checksum-crc32: AAAA==' --data-binary 'part-three' "$B/s3/smoke/big.bin?partNumber=3&uploadId=$UPLOAD_ID")"

# UploadPartCopy: a part sourced from an existing object (full or byte range).
echo "== UploadPartCopy =="
printf '0123456789abcdef' > "$TMP/copy-src.bin"
check "seed copy source" "200" "$(status_of -X PUT -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" --data-binary @"$TMP/copy-src.bin" "$B/s3/smoke/copy-src.bin")"
UPC_XML="$(curl -s -X POST -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/copied.bin?uploads")"
UPC_ID="$(printf '%s' "$UPC_XML" | sed -n 's:.*<UploadId>\([^<]*\)</UploadId>.*:\1:p')"
check "UploadPartCopy full source" "200" "$(status_of -X PUT -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" -H "x-amz-copy-source: /smoke/copy-src.bin" "$B/s3/smoke/copied.bin?partNumber=1&uploadId=$UPC_ID")"
UPC_ETAG1="$(curl -s -X PUT -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" -H "x-amz-copy-source: /smoke/copy-src.bin" "$B/s3/smoke/copied.bin?partNumber=1&uploadId=$UPC_ID" | sed -n 's:.*<ETag>\([^<]*\)</ETag>.*:\1:p')"
[ -n "$UPC_ETAG1" ] || { echo "✗ no part ETag from UploadPartCopy"; exit 1; }
check "UploadPartCopy range source" "200" "$(status_of -X PUT -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" -H "x-amz-copy-source: /smoke/copy-src.bin" -H "x-amz-copy-source-range: bytes=0-7" "$B/s3/smoke/copied.bin?partNumber=2&uploadId=$UPC_ID")"
check "UploadPartCopy malformed range -> 400" "400" "$(status_of -X PUT -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" -H "x-amz-copy-source: /smoke/copy-src.bin" -H "x-amz-copy-source-range: bytes=abc" "$B/s3/smoke/copied.bin?partNumber=3&uploadId=$UPC_ID")"
check "UploadPartCopy missing source -> 404" "404" "$(status_of -X PUT -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" -H "x-amz-copy-source: /smoke/does-not-exist.bin" "$B/s3/smoke/copied.bin?partNumber=3&uploadId=$UPC_ID")"
UPC_ETAG2="$(curl -s -X PUT -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" -H "x-amz-copy-source: /smoke/copy-src.bin" -H "x-amz-copy-source-range: bytes=0-7" "$B/s3/smoke/copied.bin?partNumber=2&uploadId=$UPC_ID" | sed -n 's:.*<ETag>\([^<]*\)</ETag>.*:\1:p')"
UPC_COMPLETE="<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>$UPC_ETAG1</ETag></Part><Part><PartNumber>2</PartNumber><ETag>$UPC_ETAG2</ETag></Part></CompleteMultipartUpload>"
check "UploadPartCopy complete" "200" "$(status_of -X POST -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" -H "Content-Type: application/xml" --data "$UPC_COMPLETE" "$B/s3/smoke/copied.bin?uploadId=$UPC_ID")"
check "UploadPartCopy assembled content" "0123456789abcdef01234567" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/copied.bin")"

COMPLETE_XML="<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>$ETAG1</ETag></Part><Part><PartNumber>2</PartNumber><ETag>$ETAG2</ETag></Part></CompleteMultipartUpload>"
COMPLETE_R="$(curl -s -X POST -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" -H "Content-Type: application/xml" --data "$COMPLETE_XML" "$B/s3/smoke/big.bin?uploadId=$UPLOAD_ID")"
check "multipart complete reports ChecksumCRC32" "1" "$(printf '%s' "$COMPLETE_R" | grep -c '<ChecksumCRC32>')"
R=$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/big.bin")
check "multipart assembled" "part-onepart-two" "$R"
check "multipart object carries initiate-time tags" "1" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "$B/s3/smoke/big.bin?tagging" | grep -c '<Key>mp</Key><Value>1</Value>')"
check "multipart GET checksum matches plaintext" "$(crc32_of 'part-onepart-two')" "$(curl -s -D - -o /dev/null -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" -H 'x-amz-checksum-mode: enabled' "$B/s3/smoke/big.bin" | grep -i '^x-amz-checksum-crc32:' | tr -d '\r' | cut -d' ' -f2-)"
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

# --- SDK path-style SigV4 (s3auth.ts canonicalUriCandidates) --------------------
# AWS SDKs pointed at this endpoint believe it's S3: their canonical URI is
# /<bucket>/<key> (no /s3 prefix) — the server must verify that form too, not
# just the /s3/... paths our admin API mints. This node script reproduces an
# SDK's path-style presign exactly (empty-value params like `uploads` included).
cat > "$TMP/sigv4.js" <<'EOF'
const crypto = require('crypto');
const REGION = 'us-east-1', SERVICE = 's3', TERMINATOR = 'aws4_request';
const hmac = (k, i) => crypto.createHmac('sha256', k).update(i).digest();
const sk = (sec, ds) => hmac(hmac(hmac(hmac('AWS4' + sec, ds), REGION), SERVICE), TERMINATOR);
const enc = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const [method, uriPath, host, ak, sec, ...extra] = process.argv.slice(2);
const now = new Date();
const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
const dateStamp = amzDate.slice(0, 8);
const scope = `${dateStamp}/${REGION}/${SERVICE}/${TERMINATOR}`;
const params = [
  ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
  ['X-Amz-Credential', `${ak}/${scope}`],
  ['X-Amz-Date', amzDate],
  ['X-Amz-Expires', '600'],
  ['X-Amz-SignedHeaders', 'host'],
  ...(extra.length ? extra.map((e) => { const i = e.indexOf('='); return [e.slice(0, i), e.slice(i + 1)]; }) : []),
];
const canonicalQuery = params.map(([n, v]) => `${enc(n)}=${enc(v)}`).sort().join('&');
const canonicalRequest = [method, uriPath, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
const sts = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
const signature = hmac(sk(sec, dateStamp), sts).toString('hex');
process.stdout.write(`${canonicalQuery}&X-Amz-Signature=${signature}`);
EOF
check "SDK path-style presigned GET verifies (canonical URI /smoke/hello.txt)" "smoke-test-content" "$(curl -s "$B/s3/smoke/hello.txt?$(node "$TMP/sigv4.js" GET /smoke/hello.txt "127.0.0.1:$PORT" "$AK" "$SK")")"
PATHSTYLE_MP_XML="$(curl -s -X POST "$B/s3/smoke/mp-style.bin?$(node "$TMP/sigv4.js" POST /smoke/mp-style.bin "127.0.0.1:$PORT" "$AK" "$SK" "uploads=")")"
check "SDK path-style presigned POST ?uploads (empty-value param)" "1" "$(printf '%s' "$PATHSTYLE_MP_XML" | grep -c '<InitiateMultipartUploadResult')"
check "SDK path-style ?uploads produces UploadId" "1" "$(printf '%s' "$PATHSTYLE_MP_XML" | grep -c '<UploadId>')"

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
