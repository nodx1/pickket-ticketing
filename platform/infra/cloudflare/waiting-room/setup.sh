#!/usr/bin/env bash
# Cloudflare Waiting Room Setup for Pickket
# ---------------------------------------------------------------------------
# Capacity Rationale (2026-04-04 부하 테스트 기준):
#   - Backend: ECS Fargate 20 tasks x 512 MCU = 실측 동시 처리 ~2,700명
#   - total_active_users: 2,500 (서버 용량의 ~93%, 안전 마진 확보)
#   - new_users_per_minute: 500 (분당 유입 제한 — 서버 부하 급증 방지)
#   - session_duration: 10분 (비활성 세션 해제 → 대기열 회전 속도 유지)
#   - 기존 설정(5,000/1,000)은 서버 과부하 유발 → 부하 테스트 결과에 맞춰 하향
# ---------------------------------------------------------------------------
set -euo pipefail

# Required: CF_API_TOKEN and CF_ZONE_ID environment variables
: "${CF_API_TOKEN:?Set CF_API_TOKEN}"
: "${CF_ZONE_ID:?Set CF_ZONE_ID}"

API_BASE="https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/waiting_rooms"

# ---------------------------------------------------------------------------
# Environment: STAGING (stg.pickket.kr)
# ---------------------------------------------------------------------------
echo "=== Creating Staging Waiting Room ==="

STG_RESPONSE=$(curl -s -X POST "$API_BASE" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "name": "pickket-stg-event-queue",
    "description": "Pickket 스테이징 이벤트 티켓 판매 대기열",
    "host": "stg.pickket.kr",
    "path": "/events/",
    "total_active_users": 2500,
    "new_users_per_minute": 500,
    "session_duration": 10,
    "queueing_method": "fifo",
    "queueing_status_code": 200,
    "json_response_enabled": true,
    "default_template_language": "ko-KR",
    "cookie_suffix": "pickket_stg_wr",
    "additional_routes": [
      {"host": "stg.pickket.kr", "path": "/api/v1/cart/"},
      {"host": "stg.pickket.kr", "path": "/api/v1/events/*/purchase"}
    ],
    "enabled": false
  }')

echo "$STG_RESPONSE" | python3 -m json.tool

STG_WR_ID=$(echo "$STG_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['id'])" 2>/dev/null || echo "UNKNOWN")
echo ""
echo "Staging Waiting Room ID: $STG_WR_ID"
echo ""

# ---------------------------------------------------------------------------
# Environment: PRODUCTION (www.pickket.kr)
# ---------------------------------------------------------------------------
echo "=== Creating Production Waiting Room ==="

RESPONSE=$(curl -s -X POST "$API_BASE" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "name": "pickket-event-queue",
    "description": "Pickket 이벤트 티켓 판매 대기열",
    "host": "www.pickket.kr",
    "path": "/events/",
    "total_active_users": 2500,
    "new_users_per_minute": 500,
    "session_duration": 10,
    "queueing_method": "fifo",
    "queueing_status_code": 200,
    "json_response_enabled": true,
    "default_template_language": "ko-KR",
    "cookie_suffix": "pickket_wr",
    "additional_routes": [
      {"host": "www.pickket.kr", "path": "/api/v1/cart/"},
      {"host": "www.pickket.kr", "path": "/api/v1/events/*/purchase"}
    ],
    "enabled": false
  }')

echo "$RESPONSE" | python3 -m json.tool

WR_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['id'])" 2>/dev/null || echo "UNKNOWN")
echo ""
echo "Production Waiting Room ID: $WR_ID"
echo ""

# ---------------------------------------------------------------------------
# Usage: Enable/Disable before and after events
# ---------------------------------------------------------------------------
echo "=== Staging Commands ==="
echo "To enable before an event:"
echo "  curl -X PATCH '${API_BASE}/${STG_WR_ID}' -H 'Authorization: Bearer \$CF_API_TOKEN' -H 'Content-Type: application/json' --data '{\"enabled\": true}'"
echo "To disable after an event:"
echo "  curl -X PATCH '${API_BASE}/${STG_WR_ID}' -H 'Authorization: Bearer \$CF_API_TOKEN' -H 'Content-Type: application/json' --data '{\"enabled\": false}'"
echo ""
echo "=== Production Commands ==="
echo "To enable before an event:"
echo "  curl -X PATCH '${API_BASE}/${WR_ID}' -H 'Authorization: Bearer \$CF_API_TOKEN' -H 'Content-Type: application/json' --data '{\"enabled\": true}'"
echo "To disable after an event:"
echo "  curl -X PATCH '${API_BASE}/${WR_ID}' -H 'Authorization: Bearer \$CF_API_TOKEN' -H 'Content-Type: application/json' --data '{\"enabled\": false}'"
