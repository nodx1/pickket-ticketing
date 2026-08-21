#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# chaos-test-monitoring.sh — 모니터링 실증 검증 (Phase 1.5)
#
# Phase 1 완료 후 staging에서 실행. 알림이 진짜 오는지 검증.
#
# 시나리오:
#   1. DB 연결 끊기 → /health/ready 실패 → CloudWatch → Slack critical
#   2. 500 에러 폭탄 → 에러율 5% 초과 → Slack 알림
#   3. Redis 다운 시뮬레이션 → health degraded → Slack warning
#
# 사용법:
#   ./chaos-test-monitoring.sh --scenario db-disconnect [--duration 300]
#   ./chaos-test-monitoring.sh --scenario error-bomb [--count 100]
#   ./chaos-test-monitoring.sh --scenario all
#
# 사전 조건:
#   - ALERTING_WEBHOOK_URL 환경변수 설정됨
#   - staging 환경에서 실행
#   - Telegram 알림 채팅방 모니터링 중
###############################################################################

REGION="ap-northeast-2"
API_URL="${API_URL:-https://api-staging.pickket.kr}"
DURATION="${DURATION:-300}"
ERROR_COUNT="${ERROR_COUNT:-100}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "[$(date '+%H:%M:%S')] $*"; }
ok()  { log "${GREEN}✓ $*${NC}"; }
warn() { log "${YELLOW}⚠ $*${NC}"; }
fail() { log "${RED}✗ $*${NC}"; }

###############################################################################
# 시나리오 1: DB 연결 끊기 (보안그룹 변경)
###############################################################################
scenario_db_disconnect() {
  log "=== 시나리오 1: DB 연결 끊기 ==="
  log "방법: RDS 보안그룹에서 ECS SG 일시 제거 (${DURATION}초)"
  log ""
  warn "이 시나리오는 수동 실행이 필요합니다:"
  echo "  1. AWS 콘솔 → RDS → pickket-aurora-v2 → Security Group"
  echo "  2. Inbound 규칙에서 ECS Security Group 규칙 삭제"
  echo "  3. 아래 명령으로 헬스체크 모니터링 시작"
  echo ""
  echo "  while true; do"
  echo "    curl -s ${API_URL}/health/detailed | python3 -m json.tool 2>/dev/null || echo 'FAILED'"
  echo "    sleep 5"
  echo "  done"
  echo ""
  echo "  4. ${DURATION}초 후 보안그룹 규칙 복원"
  echo ""
  log "검증 항목:"
  echo "  - [ ] /health/ready → 503 반환 확인"
  echo "  - [ ] CloudWatch pickket-db-connections 알람 ALARM 상태"
  echo "  - [ ] Telegram CRITICAL 채팅방에 5분 이내 알림 도착"
  echo "  - [ ] 보안그룹 복원 후 OK 알림 도착"
}

###############################################################################
# 시나리오 2: 500 에러 폭탄
###############################################################################
scenario_error_bomb() {
  log "=== 시나리오 2: 500 에러 폭탄 ==="
  log "방법: 존재하지 않는 내부 경로로 ${ERROR_COUNT}회 요청 → 에러율 초과"
  log ""

  # 먼저 정상 요청 100개로 baseline 확보
  log "Baseline 요청 100개 발사..."
  for i in $(seq 1 100); do
    curl -s -o /dev/null "${API_URL}/api/v1/events/trending" &
  done
  wait
  ok "Baseline 완료"

  # 500 유발 요청 발사 (없는 내부 리소스 접근)
  log "에러 유발 요청 ${ERROR_COUNT}개 발사..."
  ERRORS=0
  for i in $(seq 1 "$ERROR_COUNT"); do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${API_URL}/api/v1/events/00000000-0000-0000-0000-000000000000/force-500-test" 2>/dev/null || echo "000")
    if [ "$STATUS" -ge 400 ] 2>/dev/null; then
      ERRORS=$((ERRORS + 1))
    fi
    # 너무 빠르면 레이트리밋에 걸림
    if [ $((i % 10)) -eq 0 ]; then
      sleep 0.5
    fi
  done
  ok "에러 발사 완료: ${ERRORS}/${ERROR_COUNT} 에러 응답"

  log ""
  log "검증 항목:"
  echo "  - [ ] 에러율 5% 초과 시 Telegram 알림 도착 (10분 이내)"
  echo "  - [ ] Sentry에 에러 이벤트 기록 확인"
  echo "  - [ ] 동일 알림 10분 내 재발송 안 됨 (쿨다운 확인)"

  # 10분 후 동일 요청 → 쿨다운 검증
  log ""
  warn "쿨다운 검증: 5분 후 동일 에러 재발사 → 알림 중복 확인"
  log "  sleep 300 && ./chaos-test-monitoring.sh --scenario error-bomb --count 50"
}

###############################################################################
# 시나리오 3: Redis 다운 시뮬레이션
###############################################################################
scenario_redis_down() {
  log "=== 시나리오 3: Redis 다운 시뮬레이션 ==="
  log ""
  warn "이 시나리오는 수동 실행이 필요합니다:"
  echo "  1. AWS 콘솔 → ElastiCache → pickket-redis-cluster"
  echo "  2. 'Test failover' 실행"
  echo "  3. 아래 명령으로 헬스체크 모니터링:"
  echo ""
  echo "  while true; do"
  echo "    curl -s ${API_URL}/health/detailed | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get(\"status\"), d.get(\"checks\",{}).get(\"redis\"))' 2>/dev/null || echo 'FAILED'"
  echo "    sleep 5"
  echo "  done"
  echo ""
  log "검증 항목:"
  echo "  - [ ] /health/detailed → redis: degraded"
  echo "  - [ ] CloudWatch pickket-redis-memory 또는 pickket-redis-cpu 알람"
  echo "  - [ ] Telegram WARNING 채팅방에 알림 도착"
  echo "  - [ ] 페일오버 완료 후 OK 알림 도착"
  echo "  - [ ] API 응답은 계속 정상 (Redis 없이 graceful degradation)"
}

###############################################################################
# 메인
###############################################################################
SCENARIO="${1:-all}"
case "$SCENARIO" in
  --scenario)
    SCENARIO="${2:-all}"
    shift 2 || true
    ;;
esac

# 추가 파라미터 파싱
while [[ $# -gt 0 ]]; do
  case "$1" in
    --duration) DURATION="$2"; shift 2 ;;
    --count) ERROR_COUNT="$2"; shift 2 ;;
    --api-url) API_URL="$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo "==========================================="
echo " Pickket 모니터링 카오스 테스트"
echo " API: ${API_URL}"
echo " 시간: $(date '+%Y-%m-%d %H:%M:%S')"
echo "==========================================="
echo ""

case "$SCENARIO" in
  db-disconnect|db)
    scenario_db_disconnect
    ;;
  error-bomb|errors)
    scenario_error_bomb
    ;;
  redis-down|redis)
    scenario_redis_down
    ;;
  all)
    scenario_error_bomb
    echo ""
    echo "==========================================="
    echo ""
    scenario_db_disconnect
    echo ""
    echo "==========================================="
    echo ""
    scenario_redis_down
    ;;
  *)
    echo "사용법: $0 --scenario {db-disconnect|error-bomb|redis-down|all}"
    exit 1
    ;;
esac

echo ""
log "카오스 테스트 가이드 출력 완료."
log "각 시나리오 실행 후 Telegram 채팅방에서 알림 도착을 확인하세요."
