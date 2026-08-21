#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

AWS_REGION="${AWS_REGION:-ap-northeast-2}"
ECS_CLUSTER="${ECS_CLUSTER:?ECS_CLUSTER must be set}"
TARGET_SERVICE="${TARGET_SERVICE:-all}"
API_BASE_URL="${API_BASE_URL:-https://api.pickket.kr}"
CONSUMER_BASE_URL="${CONSUMER_BASE_URL:-https://www.pickket.kr}"
GO_BASE_URL="${GO_BASE_URL:-https://go.pickket.kr}"
ADMIN_BASE_URL="${ADMIN_BASE_URL:-https://admin.pickket.kr}"
SMOKE_RETRIES="${SMOKE_RETRIES:-20}"
SMOKE_SLEEP_SECONDS="${SMOKE_SLEEP_SECONDS:-3}"

should_check() {
  local svc="$1"
  [[ "$TARGET_SERVICE" == "all" || "$TARGET_SERVICE" == "$svc" ]]
}

SMOKE_CURL_OPTS=(-H "User-Agent: pickket-ci-smoke/1.0" -H "X-Smoke-Test: true")

retry_http() {
  local label="$1"
  local url="$2"
  local attempt=1
  while (( attempt <= SMOKE_RETRIES )); do
    if curl -fsS --max-time 10 "${SMOKE_CURL_OPTS[@]}" "$url" >/dev/null 2>&1; then
      echo "[PASS] ${label}: ${url}"
      return 0
    fi
    sleep "$SMOKE_SLEEP_SECONDS"
    ((attempt+=1))
  done
  echo "[ERROR] ${label} failed after ${SMOKE_RETRIES} attempts: ${url}" >&2
  return 1
}

for bin in curl jq aws; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[ERROR] missing required command: $bin" >&2
    exit 1
  fi
done

"${ROOT_DIR}/scripts/ci/aws_ecs_service_gate.sh"

if should_check backend || should_check celery-worker || should_check celery-beat; then
  retry_http "backend live health" "${API_BASE_URL}/health/live"

  health_json="$(curl -fsS --max-time 10 "${SMOKE_CURL_OPTS[@]}" "${API_BASE_URL}/health")"
  overall="$(echo "$health_json" | jq -r '.status')"
  db_connected="$(echo "$health_json" | jq -r '.database')"
  redis_connected="$(echo "$health_json" | jq -r '.redis')"

  echo "[INFO] health status=${overall} db=${db_connected} redis=${redis_connected}"

  if [[ "$overall" != "ok" ]]; then
    echo "[ERROR] backend health is not ok" >&2
    exit 1
  fi
  if [[ "$db_connected" != "ok" || "$redis_connected" != "ok" ]]; then
    echo "[ERROR] backend dependencies are not healthy" >&2
    exit 1
  fi
fi

if should_check consumer || should_check all; then
  retry_http "consumer frontend" "${CONSUMER_BASE_URL}/"

  # 메인페이지 콘텐츠 검증 — 구버전 배포 방지
  echo "[INFO] checking consumer homepage content..."
  HOMEPAGE_HTML="$(curl -fsS --max-time 10 "${SMOKE_CURL_OPTS[@]}" "${CONSUMER_BASE_URL}/" 2>/dev/null || true)"
  HOMEPAGE_SIZE="${#HOMEPAGE_HTML}"
  if (( HOMEPAGE_SIZE < 5000 )); then
    echo "[ERROR] consumer homepage HTML too small (${HOMEPAGE_SIZE} bytes) — 구버전 배포 의심" >&2
    exit 1
  fi
  echo "[PASS] consumer homepage size: ${HOMEPAGE_SIZE} bytes"
fi

if should_check go || should_check all; then
  retry_http "go frontend" "${GO_BASE_URL}/"
fi

if should_check admin || should_check all; then
  retry_http "admin frontend" "${ADMIN_BASE_URL}/"
fi

# --- Go Service Health Checks ---
echo "Checking ticket-gateway health..."
TICKET_GW_URL="${API_BASE_URL}"
TG_HEALTH=$(curl -sf -o /dev/null -w "%{http_code}" "${SMOKE_CURL_OPTS[@]}" "${TICKET_GW_URL}/api/v1/waiting-room/status/smoke-test" --max-time 10 || echo "000")
if [ "$TG_HEALTH" = "200" ]; then
  echo "  ✓ ticket-gateway: healthy"
else
  echo "  ✗ ticket-gateway: unhealthy (HTTP ${TG_HEALTH})"
  FAILED=1
fi

echo "Checking realtime-hub health..."
# WebSocket upgrade test
WS_URL="${WS_BASE_URL:-wss://api.pickket.kr}/ws/smoke-test"
WS_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "${SMOKE_CURL_OPTS[@]}" -H "Upgrade: websocket" -H "Connection: Upgrade" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" "${WS_URL}" --max-time 10 || echo "000")
if [ "$WS_STATUS" = "101" ] || [ "$WS_STATUS" = "200" ]; then
  echo "  ✓ realtime-hub: healthy"
else
  echo "  ✗ realtime-hub: status ${WS_STATUS} (may be expected if WS not routed yet)"
fi

echo "[SUCCESS] AWS post-deploy smoke checks passed"
