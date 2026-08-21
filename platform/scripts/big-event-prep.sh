#!/usr/bin/env bash
# ============================================================================
# 빅이벤트 인프라 사전 준비 스크립트
#
# Usage:
#   ./scripts/big-event-prep.sh <EVENT_ID> <OPEN_TIME_KST> <GRADE>
#
# Examples:
#   ./scripts/big-event-prep.sh evt_imhero_0410 "2026-04-10T14:00:00" S
#   ./scripts/big-event-prep.sh evt_iu_0501     "2026-05-01T20:00:00" A
#   ./scripts/big-event-prep.sh evt_fest_0615   "2026-06-15T12:00:00" B
#
# Grades:
#   S  — 10만+ 동시접속 (임영웅, BTS급)
#   A  — 3~10만 동시접속 (아이유, 세븐틴급)
#   B  — 1~3만 동시접속 (중견 아티스트)
#   C  — ~1만 동시접속 (일반 이벤트)
#
# 상세 런북: docs/operations/BIG_EVENT_RUNBOOK.md
# ============================================================================
set -euo pipefail

REGION="ap-northeast-2"
CLUSTER="pickket"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# ── Args ────────────────────────────────────────────────────────────────────
EVENT_ID="${1:-}"
OPEN_TIME="${2:-}"
GRADE="${3:-B}"

if [ -z "$EVENT_ID" ] || [ -z "$OPEN_TIME" ]; then
  echo "Usage: $0 <EVENT_ID> <OPEN_TIME_KST> <GRADE: S|A|B|C>"
  echo ""
  echo "Examples:"
  echo "  $0 evt_imhero_0410 '2026-04-10T14:00:00' S"
  echo "  $0 evt_iu_0501     '2026-05-01T20:00:00' A"
  exit 1
fi

# ── Grade → 리소스 매핑 ─────────────────────────────────────────────────────
case "$GRADE" in
  S|s) BACKEND=30; GATEWAY=25; CONSUMER=10; CELERY=8;  ACU=16; GRADE_LABEL="S (10만+)" ;;
  A|a) BACKEND=20; GATEWAY=15; CONSUMER=8;  CELERY=6;  ACU=8;  GRADE_LABEL="A (3~10만)" ;;
  B|b) BACKEND=10; GATEWAY=10; CONSUMER=5;  CELERY=4;  ACU=4;  GRADE_LABEL="B (1~3만)" ;;
  C|c) BACKEND=5;  GATEWAY=5;  CONSUMER=3;  CELERY=2;  ACU=2;  GRADE_LABEL="C (~1만)" ;;
  *)   echo "ERROR: Unknown grade '${GRADE}'. Use S/A/B/C."; exit 1 ;;
esac

echo "============================================================"
echo "  빅이벤트 인프라 준비"
echo "============================================================"
echo ""
echo "  이벤트 ID  : ${EVENT_ID}"
echo "  오픈 시각  : ${OPEN_TIME} KST"
echo "  등급       : ${GRADE_LABEL}"
echo ""
echo "  리소스 계획:"
echo "    Backend        : ${BACKEND} 태스크"
echo "    Ticket Gateway : ${GATEWAY} 태스크"
echo "    Consumer       : ${CONSUMER} 태스크"
echo "    Celery Worker  : ${CELERY} 태스크"
echo "    Aurora min ACU : ${ACU}"
echo ""
echo "------------------------------------------------------------"
echo ""

# ── 1. ECS 스케줄 스케일링 등록 ─────────────────────────────────────────────
echo "=== [1/4] ECS 스케줄 스케일링 등록 ==="

SCHEDULED_SCALING="${SCRIPT_DIR}/infra/aws/scheduled-scaling.sh"

if [ ! -f "$SCHEDULED_SCALING" ]; then
  echo "ERROR: ${SCHEDULED_SCALING} not found"
  exit 1
fi

declare -A SERVICES=(
  ["backend"]=$BACKEND
  ["ticket-gateway"]=$GATEWAY
  ["consumer"]=$CONSUMER
  ["celery-worker"]=$CELERY
)

for svc in backend ticket-gateway consumer celery-worker; do
  count=${SERVICES[$svc]}
  echo ""
  echo "  → pickket-prod-${svc}: ${count} 태스크"
  "$SCHEDULED_SCALING" create "$OPEN_TIME" \
    --cluster "$CLUSTER" \
    --service "pickket-prod-${svc}" \
    --count "$count" \
    --event-id "$EVENT_ID" \
    --pre-minutes 10 \
    --post-minutes 60 \
    --env production 2>&1 | sed 's/^/    /'
done

echo ""
echo "  스케줄 목록:"
"$SCHEDULED_SCALING" list --env production 2>&1 | sed 's/^/    /'

# ── 2. Aurora 워밍 안내 ─────────────────────────────────────────────────────
echo ""
echo "=== [2/4] Aurora 워밍 ==="

LAMBDA_ARN=$(aws lambda get-function --function-name pickket-aurora-warming \
  --query 'Configuration.FunctionArn' --output text --region "$REGION" 2>/dev/null || echo "")

if [ -n "$LAMBDA_ARN" ] && [ "$LAMBDA_ARN" != "None" ]; then
  echo "  Lambda 확인: ${LAMBDA_ARN}"
  echo ""
  echo "  EventBridge 룰을 수동으로 등록하세요:"
  echo "    - 오픈 15분 전 → action:warmup, min_capacity:${ACU}"
  echo "    - 오픈 1시간 후 → action:cooldown"
  echo ""
  echo "  또는 오픈 직전에 즉시 워밍:"
  echo "    ./infra/aws/aurora-warming.sh warmup-now"
else
  echo "  ⚠ Lambda 미배포. 먼저 배포하세요:"
  echo "    ./infra/aws/aurora-warming.sh deploy"
fi

# ── 3. 헬스 체크 ────────────────────────────────────────────────────────────
echo ""
echo "=== [3/4] 현재 시스템 상태 ==="

echo ""
echo "  API 헬스:"
API_STATUS=$(curl -s -o /dev/null -w '%{http_code}' https://api.pickket.kr/health 2>/dev/null || echo "FAIL")
echo "    https://api.pickket.kr/health → ${API_STATUS}"

echo ""
echo "  Edge Queue 헬스:"
QUEUE_STATUS=$(curl -s -o /dev/null -w '%{http_code}' https://queue.pickket.kr/queue/health 2>/dev/null || echo "FAIL")
echo "    https://queue.pickket.kr/queue/health → ${QUEUE_STATUS}"

echo ""
echo "  ECS 서비스 현황:"
aws ecs describe-services --cluster "$CLUSTER" \
  --services pickket-prod-backend pickket-prod-ticket-gateway pickket-prod-consumer \
  --query 'services[*].{Service:serviceName,Running:runningCount,Desired:desiredCount}' \
  --output table --region "$REGION" 2>&1 | sed 's/^/    /' || echo "    (조회 실패 — 서비스 미등록 가능)"

# ── 4. 체크리스트 출력 ──────────────────────────────────────────────────────
echo ""
echo "=== [4/4] 남은 체크리스트 ==="
echo ""
echo "  D-1 (전날):"
echo "    □ 스케줄 등록 확인 완료"
echo "    □ 팀 Telegram 공지 발송"
echo ""
echo "  H-1 (1시간 전):"
echo "    □ ECS 태스크 수 확인 (스케줄 작동 여부)"
echo "    □ Aurora ACU 확인"
echo "    □ Waiting Room 활성화"
echo "      curl -X PATCH 'https://api.cloudflare.com/client/v4/zones/<ZONE>/waiting_rooms/<ID>' \\"
echo "        -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' \\"
echo "        --data '{\"enabled\": true}'"
echo ""
echo "  H-0 (오픈 시각):"
echo "    □ 모니터링 대시보드 열기 (CloudWatch / Grafana)"
echo "    □ API 응답 시간 확인"
echo "    □ Edge Queue 상태 확인"
echo ""
echo "  H+1 (1시간 후):"
echo "    □ Waiting Room 비활성화"
echo "    □ 스케줄 정리: ./infra/aws/scheduled-scaling.sh delete ${EVENT_ID} --env production"
echo "    □ Aurora 쿨다운 확인"
echo ""
echo "  D+1 (다음 날):"
echo "    □ 정산 대사 결과 확인"
echo "    □ sold_count 대사 확인"
echo "    □ 비용 확인"
echo ""
echo "============================================================"
echo "  준비 완료. 상세 런북: docs/operations/BIG_EVENT_RUNBOOK.md"
echo "============================================================"
