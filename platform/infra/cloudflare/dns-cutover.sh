#!/usr/bin/env bash
# DNS TTL Management for Infrastructure Migration
set -euo pipefail

: "${CF_API_TOKEN:?Set CF_API_TOKEN}"
: "${CF_ZONE_ID:?Set CF_ZONE_ID}"

API_BASE="https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records"

set_ttl() {
  local name="$1"
  local ttl="$2"

  RECORD_ID=$(curl -s "$API_BASE?name=${name}" \
    -H "Authorization: Bearer $CF_API_TOKEN" | \
    python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(r[0]['id'] if r else '')" 2>/dev/null)

  if [ -z "$RECORD_ID" ]; then
    echo "  SKIP: $name (not found)"
    return
  fi

  curl -s -X PATCH "${API_BASE}/${RECORD_ID}" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"ttl\": $ttl}" > /dev/null

  echo "  SET: $name → TTL ${ttl}s"
}

DOMAINS=(
  "www.pickket.kr"
  "api.pickket.kr"
  "go.pickket.kr"
  "admin.pickket.kr"
)

case "${1:-}" in
  pre-migration)
    echo "=== D-1: Reducing TTL to 60s ==="
    for domain in "${DOMAINS[@]}"; do
      set_ttl "$domain" 60
    done
    echo "Done. Wait 24h for old TTL to expire before migration."
    ;;

  post-migration)
    echo "=== D+1: Restoring TTL to 300s ==="
    for domain in "${DOMAINS[@]}"; do
      set_ttl "$domain" 300
    done
    ;;

  normal)
    echo "=== D+7: Normal TTL 3600s ==="
    for domain in "${DOMAINS[@]}"; do
      set_ttl "$domain" 3600
    done
    ;;

  status)
    echo "=== Current DNS TTL Status ==="
    for domain in "${DOMAINS[@]}"; do
      TTL=$(curl -s "$API_BASE?name=${domain}" \
        -H "Authorization: Bearer $CF_API_TOKEN" | \
        python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(r[0]['ttl'] if r else 'N/A')" 2>/dev/null)
      echo "  $domain: ${TTL}s"
    done
    ;;

  *)
    echo "Usage: $0 [pre-migration|post-migration|normal|status]"
    exit 1
    ;;
esac
