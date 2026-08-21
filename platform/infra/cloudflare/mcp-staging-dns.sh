#!/usr/bin/env bash
# MCP 서버 DNS 이관: mcp.pickket.kr (prod) → mcp-staging.pickket.kr (stg)
# 실행 전: export CF_API_TOKEN=<token> CF_ZONE_ID=<zone_id>
set -euo pipefail

: "${CF_API_TOKEN:?CF_API_TOKEN 환경변수 필요}"
: "${CF_ZONE_ID:?CF_ZONE_ID 환경변수 필요}"

API="https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records"
STG_ALB="pickket-stg-alb-963299864.ap-northeast-2.elb.amazonaws.com"

cf_api() {
  curl -sf -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" "$@"
}

echo "=== [1] mcp-staging.pickket.kr CNAME 추가 ==="
EXISTING=$(cf_api "${API}?name=mcp-staging.pickket.kr" | python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(r[0]['id'] if r else '')" 2>/dev/null || echo "")
if [ -z "$EXISTING" ]; then
  cf_api -X POST "$API" --data "{
    \"type\": \"CNAME\",
    \"name\": \"mcp-staging\",
    \"content\": \"${STG_ALB}\",
    \"proxied\": true,
    \"ttl\": 1
  }" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  추가됨:', d['result']['name'])"
else
  cf_api -X PATCH "${API}/${EXISTING}" --data "{
    \"content\": \"${STG_ALB}\",
    \"proxied\": true
  }" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  업데이트됨:', d['result']['name'])"
fi
echo "  ✅ mcp-staging.pickket.kr → ${STG_ALB}"

echo ""
echo "=== [2] mcp.pickket.kr (prod) DNS 레코드 삭제 ==="
MCP_ID=$(cf_api "${API}?name=mcp.pickket.kr" | python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(r[0]['id'] if r else '')" 2>/dev/null || echo "")
if [ -n "$MCP_ID" ]; then
  cf_api -X DELETE "${API}/${MCP_ID}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  삭제됨' if d['success'] else '  실패: '+str(d))"
  echo "  ✅ mcp.pickket.kr 레코드 삭제 완료"
else
  echo "  ⚠️  mcp.pickket.kr 레코드 없음 (이미 삭제됐거나 다른 이름)"
fi

echo ""
echo "=== DNS 이관 완료 ==="
echo "  mcp-staging.pickket.kr → ${STG_ALB} (Cloudflare proxied)"
echo "  mcp.pickket.kr → 삭제됨"
