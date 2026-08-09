#!/usr/bin/env bash
#
# platform-smoke.sh — end-to-end smoke test for the SaaS control plane.
#
# Drives the full customer journey against a RUNNING platform: signup →
# email-verify (dev auto-verify) → auto-provision → tenant quota + S3 PUT →
# usage/metering → billing degradation → operator console (live health) →
# suspend/resume/delete. Requires docker (tenant containers) + curl + node.
#
# Usage:  bash scripts/platform-smoke.sh
# Env:
#   PLATFORM_URL           base URL of a running platform (default http://127.0.0.1:3000)
#   METER_KEY              platform METER_KEY (optional; guards /api/meter)
#   OPERATOR_EMAIL         operator login (optional; enables operator checks)
#   OPERATOR_PASSWORD      operator password (optional)
#   SMOKE_VERIFY_TOKEN     skip signup and verify this token directly (for
#                          SMTP-configured deploys where signup mails the token)

set -uo pipefail

PASS=0
FAIL=0
declare -a FAILURES=()

BASE="${PLATFORM_URL:-http://127.0.0.1:3000}"
BASE="${BASE%/}"
TMP="$(mktemp -d /tmp/r2p-smoke.XXXXXX)"
COOKIE="$TMP/cust.cookies.txt"
OP_COOKIE="$TMP/op.cookies.txt"
TS="$(date +%s)"
EMAIL="smoke$TS@test.dev"
DOMAIN="smoke$TS.test.dev"
PASSWORD="platform-smoke-password"

INSTANCE_ID=""
TRAPPED=0

cleanup() {
  # Best-effort: delete the provisioned instance if the run left it behind.
  if [ -n "$INSTANCE_ID" ] && [ "$TRAPPED" = "0" ] && [ -f "$COOKIE" ]; then
    curl -s -o /dev/null -b "$COOKIE" -X DELETE "$BASE/api/instances/$INSTANCE_ID"
  fi
  if [ "$FAIL" -gt 0 ]; then
    echo "  artifacts kept in $TMP"
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1)); echo "  ok   $desc"
  else
    FAIL=$((FAIL + 1)); FAILURES+=("$desc (expected $expected, got $actual)"); echo "  FAIL $desc — expected $expected, got $actual"
  fi
}

status_of() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
json_field() { printf '%s' "$1" | node -p "JSON.parse(require('fs').readFileSync(0)).$2 ?? ''"; }

echo "== platform: $BASE =="

if [ -n "${SMOKE_VERIFY_TOKEN:-}" ]; then
  echo "== using provided verify token (SMTP-configured deploy) =="
  TOKEN="$SMOKE_VERIFY_TOKEN"
else
  echo "== signup + verify =="
  R=$(curl -s -X POST -H "Content-Type: application/json" \
    -d "{\"name\":\"Smoke Test\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"domain\":\"$DOMAIN\",\"planId\":\"free\"}" \
    "$BASE/api/auth/signup")
  check "signup creates account (auto-verified)" "true" "$(json_field "$R" autoVerified)"
  TOKEN="$(json_field "$R" verifyToken)"
  [ -n "$TOKEN" ] || { echo "✗ no verifyToken (is SMTP configured? use SMOKE_VERIFY_TOKEN)"; exit 1; }
fi

R=$(curl -s -c "$COOKIE" "$BASE/api/auth/verify?token=$TOKEN")
check "verify provisions the instance" "true" "$(json_field "$R" instanceProvisioned)"
INSTANCE_ID="$(json_field "$R" instanceId)"

R=$(curl -s -b "$COOKIE" "$BASE/api/auth/session")
check "session authenticated as customer" "customer" "$(json_field "$R" role)"

echo "== instance + tenant quota =="
R=$(curl -s -b "$COOKIE" "$BASE/api/instances")
check "one active free instance" "1" "$(node -p "const j=JSON.parse(process.argv[1]); j.instances.filter(i=>i.id==='$INSTANCE_ID'&&i.status==='active'&&i.plan==='free').length" "$R" 2>/dev/null || echo 0)"
ADMIN_SECRET="$(node -p "const j=JSON.parse(process.argv[1]); (j.instances.find(i=>i.id==='$INSTANCE_ID')||{}).adminSecret||''" "$R" 2>/dev/null || echo "")"
AK="$(node -p "const j=JSON.parse(process.argv[1]); (j.instances.find(i=>i.id==='$INSTANCE_ID')||{}).accessKeyId||''" "$R" 2>/dev/null || echo "")"
SK="$(node -p "const j=JSON.parse(process.argv[1]); (j.instances.find(i=>i.id==='$INSTANCE_ID')||{}).accessKeySecret||''" "$R" 2>/dev/null || echo "")"
[ -n "$ADMIN_SECRET" ] && [ -n "$AK" ] && [ -n "$SK" ] || { echo "✗ missing credentials in /api/instances"; exit 1; }

PORT="$(docker ps --filter "name=r2storage-$INSTANCE_ID" --format '{{.Ports}}' | sed -E 's/.*127\.0\.0\.1:([0-9]+)->.*/\1/' | head -1)"
[ -n "$PORT" ] || { echo "✗ tenant container not found (docker running?)"; exit 1; }
Q="$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "http://127.0.0.1:$PORT/api/admin/quota")"
check "tenant quota is free plan (5 GiB)" "5368709120" "$(json_field "$Q" storageBytesLimit)"

echo "== S3 write + usage =="
check "S3 PUT to default bucket" "200" "$(status_of -X PUT -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" --data-binary 'platform-smoke' "http://127.0.0.1:$PORT/s3/default/platform-smoke.txt")"
check "S3 GET object" "platform-smoke" "$(curl -s -H "x-access-key-id: $AK" -H "x-access-key-secret: $SK" "http://127.0.0.1:$PORT/s3/default/platform-smoke.txt")"

echo "== metering =="
MC="$(status_of -X POST -H "x-meter-key: ${METER_KEY:-}" "$BASE/api/meter")"
if [ -n "${METER_KEY:-}" ]; then
  check "POST /api/meter (key) -> 200" "200" "$MC"
else
  check "POST /api/meter (no key) -> 401" "401" "$MC"
fi
R=$(curl -s -b "$COOKIE" "$BASE/api/usage")
check "customer usage endpoint responds" "active" "$(json_field "$R" usage.status)"
if [ -n "${METER_KEY:-}" ]; then
  check "usage reflects stored bytes after meter" "14" "$(json_field "$R" usage.storageBytes)"
else
  check "no snapshot before metering (metering-only)" "null" "$(node -p "const j=JSON.parse(require('fs').readFileSync(0)); j.usage.lastPolledAt===null?'null':'set'" <<< "$R")"
fi

echo "== billing (metering-only) =="
check "checkout without Stripe -> 501" "501" "$(status_of -b "$COOKIE" -X POST -H "Content-Type: application/json" -d '{"planId":"pro"}' "$BASE/api/billing/checkout")"
check "portal without Stripe -> 501" "501" "$(status_of -b "$COOKIE" -X POST "$BASE/api/billing/portal")"

echo "== operator console =="
if [ -n "${OPERATOR_EMAIL:-}" ] && [ -n "${OPERATOR_PASSWORD:-}" ]; then
  R=$(curl -s -c "$OP_COOKIE" -X POST -H "Content-Type: application/json" \
    -d "{\"email\":\"$OPERATOR_EMAIL\",\"password\":\"$OPERATOR_PASSWORD\"}" "$BASE/api/auth/login")
  check "operator login" "operator" "$(json_field "$R" role)"
  R=$(curl -s -b "$OP_COOKIE" "$BASE/api/admin/instances")
  check "operator sees instance + live health ok" "true" "$(node -p "const j=JSON.parse(process.argv[1]); (j.instances.find(i=>i.id==='$INSTANCE_ID')||{}).health&&(j.instances.find(i=>i.id==='$INSTANCE_ID')).health.healthy===true" "$R" 2>/dev/null || echo false)"
else
  echo "  (OPERATOR_EMAIL/OPERATOR_PASSWORD unset — skipping operator checks)"
fi

echo "== suspend / resume / delete =="
R=$(curl -s -b "$COOKIE" -X PATCH -H "Content-Type: application/json" -d '{"action":"suspend"}' "$BASE/api/instances/$INSTANCE_ID")
check "suspend" "suspended" "$(json_field "$R" status)"
R=$(curl -s -b "$COOKIE" "$BASE/api/instances")
check "instance shows suspended" "suspended" "$(node -p "const j=JSON.parse(process.argv[1]); (j.instances.find(i=>i.id==='$INSTANCE_ID')||{}).status||''" "$R" 2>/dev/null || echo "")"

R=$(curl -s -b "$COOKIE" -X PATCH -H "Content-Type: application/json" -d '{"action":"resume"}' "$BASE/api/instances/$INSTANCE_ID")
check "resume" "active" "$(json_field "$R" status)"

R=$(curl -s -b "$COOKIE" -X DELETE "$BASE/api/instances/$INSTANCE_ID")
check "delete" "deleted" "$(json_field "$R" status)"
TRAPPED=1
INSTANCE_ID=""

echo
echo "== platform smoke result: $PASS passed, $FAIL failed =="
if [ "$FAIL" -gt 0 ]; then
  printf '  - %s\n' "${FAILURES[@]}"
  exit 1
fi
