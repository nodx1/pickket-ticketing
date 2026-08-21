#!/usr/bin/env bash
set -euo pipefail

# Staging-only CapRover deployment helper. It deliberately refuses production
# app names/domains and never prints the CapRover token or password.
CAPROVER_URL="${CAPROVER_URL:-}"
CAPROVER_PASSWORD="${CAPROVER_PASSWORD:-}"
CAPROVER_STAGING_APP="${CAPROVER_STAGING_APP:-pickket-organizer-staging}"
CAPROVER_STAGING_DOMAIN="${CAPROVER_STAGING_DOMAIN:-go-staging.pickket.kr}"
CAPROVER_CONFIRM_STAGING="${CAPROVER_CONFIRM_STAGING:-}"

if [[ "${CAPROVER_CONFIRM_STAGING}" != "I_UNDERSTAND" ]]; then
  echo "CAPROVER_CONFIRM_STAGING=I_UNDERSTAND is required" >&2
  exit 2
fi
if [[ -z "$CAPROVER_URL" || -z "$CAPROVER_PASSWORD" ]]; then
  echo "CAPROVER_URL and CAPROVER_PASSWORD are required" >&2
  exit 2
fi
if [[ "$CAPROVER_STAGING_APP" == *prod* || "$CAPROVER_STAGING_DOMAIN" == "go.pickket.kr" || "$CAPROVER_STAGING_DOMAIN" == "pickket.kr" ]]; then
  echo "production app/domain rejected" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

login_payload="$(CAPROVER_PASSWORD="$CAPROVER_PASSWORD" node -e 'process.stdout.write(JSON.stringify({password: process.env.CAPROVER_PASSWORD}))')"
token="$(curl -fsS -X POST "$CAPROVER_URL/api/v2/login" \
  -H 'Content-Type: application/json' -H 'x-namespace: captain' \
  --data-binary "$login_payload" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.data?.token)process.exit(2);process.stdout.write(j.data.token)})')"

# Build context is the current working tree (not HEAD), excluding local build
# and dependency artifacts. This makes the repair helper deploy the fixes being
# tested without mutating git history.
tar -C "$ROOT_DIR" --exclude=node_modules --exclude=.next --exclude=test-results --exclude=tsconfig.tsbuildinfo --exclude=.git -cf "$tmp_dir/organizer.tar" .
curl -fsS -X POST "$CAPROVER_URL/api/v2/user/apps/appData/$CAPROVER_STAGING_APP?detached=1" \
  -H 'x-namespace: captain' -H "x-captain-auth: $token" \
  -F "sourceFile=@$tmp_dir/organizer.tar" >/dev/null

echo "staging upload submitted: app=$CAPROVER_STAGING_APP domain=$CAPROVER_STAGING_DOMAIN"
echo "CapRover must attach $CAPROVER_STAGING_DOMAIN to $CAPROVER_STAGING_APP; run scripts/staging-smoke.ts after the build is healthy."
