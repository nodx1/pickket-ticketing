#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# dr-drill.sh — Pickket v2 DR(재해복구) 훈련 가이드 스크립트
#
# 4가지 DR 시나리오를 인터랙티브하게 수행하고 결과를 기록합니다.
#   Drill 1: ECS 서비스 크래시 복구 (목표 <3분)
#   Drill 2: Aurora 페일오버 (목표 <30초, RDS Proxy 사용 시)
#   Drill 3: Redis 노드 장애 자동 페일오버 (목표 <5초)
#   Drill 4: 전체 롤링 배포 — 헬스체크 통과, 5xx 0건
#
# 사용법: ./dr-drill.sh [--drill 1|2|3|4|all]
# 결과 파일: docs/operations/dr-drill-results/dr-drill-YYYY-MM-DD_HHMMSS.txt
###############################################################################

# ─── 설정 ────────────────────────────────────────────────────────────────────
REGION="ap-northeast-2"
CLUSTER="${PICKKET_CLUSTER:-pickket-stg}"
RESULTS_DIR="$(cd "$(dirname "$0")/../../docs/operations/dr-drill-results" && pwd)"
TIMESTAMP="$(date +%Y-%m-%d_%H%M%S)"
RESULT_FILE="${RESULTS_DIR}/dr-drill-${TIMESTAMP}.txt"

# Edge Guard가 봇으로 차단하지 않도록 브라우저 UA 사용
CURL_UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
# curl 공통 옵션: UA + Accept-Language + Accept (Edge Guard 봇 점수 우회)
curl_health() {
  curl -s -o /dev/null -w "%{http_code}" \
    -H "User-Agent: ${CURL_UA}" \
    -H "Accept-Language: ko-KR,ko;q=0.9" \
    -H "Accept: text/html,application/json" \
    "$@" 2>/dev/null || echo "000"
}
curl_body() {
  curl -s \
    -H "User-Agent: ${CURL_UA}" \
    -H "Accept-Language: ko-KR,ko;q=0.9" \
    -H "Accept: text/html,application/json" \
    "$@" 2>/dev/null || echo ""
}

# ─── 색상 & 로깅 ─────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log_info()  { echo -e "[$(date '+%H:%M:%S')] ${CYAN}[INFO]${NC}  $*"; }
log_ok()    { echo -e "[$(date '+%H:%M:%S')] ${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "[$(date '+%H:%M:%S')] ${YELLOW}[WARN]${NC}  $*"; }
log_fail()  { echo -e "[$(date '+%H:%M:%S')] ${RED}[FAIL]${NC}  $*"; }
log_step()  { echo -e "\n${CYAN}━━━ $* ━━━${NC}\n"; }

# 결과 파일에도 동시 기록
tee_log() {
  echo "$*" | tee -a "$RESULT_FILE"
}

# ─── 유틸리티 ─────────────────────────────────────────────────────────────────
confirm_proceed() {
  local msg="${1:-계속 진행하시겠습니까?}"
  echo ""
  read -rp "$(echo -e "${YELLOW}▶ ${msg} (y/n): ${NC}")" answer
  if [[ "${answer}" != "y" && "${answer}" != "Y" ]]; then
    log_warn "사용자가 중단했습니다."
    return 1
  fi
}

elapsed_seconds() {
  local start=$1 end=$2
  echo $(( end - start ))
}

check_aws_cli() {
  if ! command -v aws &>/dev/null; then
    log_fail "AWS CLI가 설치되어 있지 않습니다."
    exit 1
  fi
  log_ok "AWS CLI 확인 완료"
}

# ─── Drill 1: ECS 서비스 크래시 복구 ─────────────────────────────────────────
drill_ecs_crash() {
  log_step "Drill 1: ECS 서비스 크래시 복구 (목표: <3분)"
  tee_log "=== Drill 1: ECS 서비스 크래시 복구 ==="
  tee_log "시작 시각: $(date '+%Y-%m-%d %H:%M:%S')"

  local SERVICE="ticket-gateway"

  log_info "대상 서비스: ${SERVICE}"
  log_info "현재 서비스 상태를 확인합니다..."

  # 현재 실행 중인 태스크 목록 조회
  aws ecs list-tasks \
    --cluster "$CLUSTER" \
    --service-name "$SERVICE" \
    --region "$REGION" \
    --query 'taskArns' --output table || true

  log_warn "이 드릴은 ${SERVICE} 서비스의 모든 실행 중인 태스크를 강제 종료합니다."
  confirm_proceed "ECS 태스크를 강제 종료하시겠습니까?" || return 0

  # 실행 중인 태스크 ARN 수집
  local TASK_ARNS
  TASK_ARNS=$(aws ecs list-tasks \
    --cluster "$CLUSTER" \
    --service-name "$SERVICE" \
    --region "$REGION" \
    --query 'taskArns[]' --output text 2>/dev/null || echo "")

  if [[ -z "$TASK_ARNS" ]]; then
    log_warn "실행 중인 태스크가 없습니다. 드릴을 건너뜁니다."
    tee_log "결과: SKIP — 실행 중인 태스크 없음"
    return 0
  fi

  # 태스크 강제 종료
  local START_EPOCH
  START_EPOCH=$(date +%s)

  for task_arn in $TASK_ARNS; do
    log_info "태스크 종료: ${task_arn}"
    aws ecs stop-task \
      --cluster "$CLUSTER" \
      --task "$task_arn" \
      --reason "DR Drill - ECS crash recovery test" \
      --region "$REGION" \
      --output text --query 'task.taskArn' || true
  done

  log_info "태스크 종료 완료. 복구 대기 중..."
  log_info "ECS 서비스 스케줄러가 새 태스크를 시작합니다. 매 10초마다 확인합니다."

  # 복구 모니터링 (최대 5분)
  local MAX_WAIT=300
  local INTERVAL=10
  local WAITED=0
  local RECOVERED=false

  while [[ $WAITED -lt $MAX_WAIT ]]; do
    sleep "$INTERVAL"
    WAITED=$((WAITED + INTERVAL))

    local RUNNING_COUNT
    RUNNING_COUNT=$(aws ecs describe-services \
      --cluster "$CLUSTER" \
      --services "$SERVICE" \
      --region "$REGION" \
      --query 'services[0].runningCount' --output text 2>/dev/null || echo "0")

    local DESIRED_COUNT
    DESIRED_COUNT=$(aws ecs describe-services \
      --cluster "$CLUSTER" \
      --services "$SERVICE" \
      --region "$REGION" \
      --query 'services[0].desiredCount' --output text 2>/dev/null || echo "0")

    log_info "  [${WAITED}s] running=${RUNNING_COUNT} / desired=${DESIRED_COUNT}"

    if [[ "$RUNNING_COUNT" == "$DESIRED_COUNT" && "$RUNNING_COUNT" != "0" ]]; then
      RECOVERED=true
      break
    fi
  done

  local END_EPOCH
  END_EPOCH=$(date +%s)
  local ELAPSED
  ELAPSED=$(elapsed_seconds "$START_EPOCH" "$END_EPOCH")

  if $RECOVERED; then
    if [[ $ELAPSED -le 180 ]]; then
      log_ok "복구 완료: ${ELAPSED}초 (목표 180초 이내 — PASS)"
      tee_log "결과: PASS — 복구 시간 ${ELAPSED}초 (목표 <180초)"
    else
      log_warn "복구 완료: ${ELAPSED}초 (목표 180초 초과 — WARN)"
      tee_log "결과: WARN — 복구 시간 ${ELAPSED}초 (목표 <180초 초과)"
    fi
  else
    log_fail "복구 실패: ${MAX_WAIT}초 내 복구되지 않음"
    tee_log "결과: FAIL — ${MAX_WAIT}초 내 복구 안 됨"
  fi
  tee_log ""
}

# ─── Drill 2: Aurora 페일오버 ─────────────────────────────────────────────────
drill_aurora_failover() {
  log_step "Drill 2: Aurora DB 페일오버 (목표: <30초, RDS Proxy 기준)"
  tee_log "=== Drill 2: Aurora DB 페일오버 ==="
  tee_log "시작 시각: $(date '+%Y-%m-%d %H:%M:%S')"

  local DB_CLUSTER="${CLUSTER}-db"
  local HEALTH_ENDPOINT="${HEALTH_ENDPOINT:-http://localhost:8021/health/detailed}"

  log_info "대상 DB 클러스터: ${DB_CLUSTER}"
  log_info "헬스체크 엔드포인트: ${HEALTH_ENDPOINT}"

  # 현재 DB 클러스터 상태 확인
  log_info "현재 클러스터 상태:"
  aws rds describe-db-clusters \
    --db-cluster-identifier "$DB_CLUSTER" \
    --region "$REGION" \
    --query 'DBClusters[0].{Status:Status, Engine:Engine, Endpoint:Endpoint}' \
    --output table 2>/dev/null || log_warn "클러스터 정보를 가져올 수 없습니다."

  log_warn "이 드릴은 Aurora 클러스터의 페일오버를 실행합니다."
  log_warn "프로덕션 환경에서는 반드시 유지보수 윈도우에 실행하세요."
  confirm_proceed "Aurora 페일오버를 실행하시겠습니까?" || return 0

  local START_EPOCH
  START_EPOCH=$(date +%s)

  # 페일오버 실행
  log_info "페일오버 명령 실행 중..."
  aws rds failover-db-cluster \
    --db-cluster-identifier "$DB_CLUSTER" \
    --region "$REGION" \
    --output text --query 'DBCluster.Status' || {
    log_fail "페일오버 명령 실패"
    tee_log "결과: FAIL — 페일오버 명령 실행 실패"
    return 1
  }

  log_info "페일오버 시작됨. 헬스체크로 다운타임 측정 중..."

  # 다운타임 측정: 1초 간격으로 헬스체크
  local MAX_WAIT=120
  local DOWNTIME_START=""
  local DOWNTIME_END=""
  local WAITED=0

  while [[ $WAITED -lt $MAX_WAIT ]]; do
    sleep 1
    WAITED=$((WAITED + 1))

    local HTTP_CODE
    HTTP_CODE=$(curl_health "$HEALTH_ENDPOINT")

    if [[ "$HTTP_CODE" != "200" && -z "$DOWNTIME_START" ]]; then
      DOWNTIME_START=$(date +%s)
      log_warn "  [${WAITED}s] 다운타임 시작 (HTTP ${HTTP_CODE})"
    elif [[ "$HTTP_CODE" == "200" && -n "$DOWNTIME_START" && -z "$DOWNTIME_END" ]]; then
      DOWNTIME_END=$(date +%s)
      log_ok "  [${WAITED}s] 서비스 복구 확인 (HTTP 200)"
      break
    else
      # 매 10초마다 상태 출력
      if (( WAITED % 10 == 0 )); then
        log_info "  [${WAITED}s] HTTP ${HTTP_CODE}"
      fi
    fi
  done

  local END_EPOCH
  END_EPOCH=$(date +%s)

  if [[ -n "$DOWNTIME_START" && -n "$DOWNTIME_END" ]]; then
    local DOWNTIME
    DOWNTIME=$(elapsed_seconds "$DOWNTIME_START" "$DOWNTIME_END")
    if [[ $DOWNTIME -le 30 ]]; then
      log_ok "다운타임: ${DOWNTIME}초 (목표 30초 이내 — PASS)"
      tee_log "결과: PASS — 다운타임 ${DOWNTIME}초 (목표 <30초)"
    else
      log_warn "다운타임: ${DOWNTIME}초 (목표 30초 초과 — WARN)"
      tee_log "결과: WARN — 다운타임 ${DOWNTIME}초 (목표 <30초 초과)"
    fi
  elif [[ -z "$DOWNTIME_START" ]]; then
    log_ok "다운타임 감지 안 됨 (RDS Proxy가 완벽히 처리)"
    tee_log "결과: PASS — 다운타임 0초 (RDS Proxy 완벽 처리)"
  else
    log_fail "복구 확인 실패 (${MAX_WAIT}초 내 헬스체크 미복구)"
    tee_log "결과: FAIL — ${MAX_WAIT}초 내 복구 미확인"
  fi
  tee_log ""
}

# ─── Drill 3: Redis 노드 장애 페일오버 ───────────────────────────────────────
drill_redis_failover() {
  log_step "Drill 3: Redis 노드 장애 자동 페일오버 (목표: <5초)"
  tee_log "=== Drill 3: Redis 노드 장애 자동 페일오버 ==="
  tee_log "시작 시각: $(date '+%Y-%m-%d %H:%M:%S')"

  local REPLICATION_GROUP="${CLUSTER}-redis"
  local REDIS_ENDPOINT="${REDIS_ENDPOINT:-redis://localhost:6381}"

  log_info "대상 ElastiCache 복제 그룹: ${REPLICATION_GROUP}"

  # 현재 상태 확인
  log_info "현재 복제 그룹 상태:"
  aws elasticache describe-replication-groups \
    --replication-group-id "$REPLICATION_GROUP" \
    --region "$REGION" \
    --query 'ReplicationGroups[0].{Status:Status, NodeGroups:NodeGroups[0].NodeGroupMembers[*].{Id:CacheClusterId,Role:CurrentRole}}' \
    --output table 2>/dev/null || log_warn "복제 그룹 정보를 가져올 수 없습니다."

  log_warn "이 드릴은 Redis 프라이머리 노드의 페일오버를 트리거합니다."
  confirm_proceed "Redis 페일오버를 실행하시겠습니까?" || return 0

  # 노드 그룹(샤드) ID 조회
  local NODE_GROUP_ID
  NODE_GROUP_ID=$(aws elasticache describe-replication-groups \
    --replication-group-id "$REPLICATION_GROUP" \
    --region "$REGION" \
    --query 'ReplicationGroups[0].NodeGroups[0].NodeGroupId' \
    --output text 2>/dev/null || echo "0001")

  local START_EPOCH
  START_EPOCH=$(date +%s)

  # 페일오버 테스트 실행
  log_info "Redis 페일오버 테스트 실행 중... (노드 그룹: ${NODE_GROUP_ID})"
  aws elasticache test-failover \
    --replication-group-id "$REPLICATION_GROUP" \
    --node-group-id "$NODE_GROUP_ID" \
    --region "$REGION" \
    --output text 2>/dev/null || {
    log_fail "Redis 페일오버 테스트 명령 실패"
    tee_log "결과: FAIL — 페일오버 테스트 명령 실행 실패"
    return 1
  }

  log_info "페일오버 트리거됨. Redis 연결 상태 확인 중..."

  # Redis 연결 확인 (1초 간격)
  local MAX_WAIT=60
  local DOWNTIME_START=""
  local DOWNTIME_END=""
  local WAITED=0

  while [[ $WAITED -lt $MAX_WAIT ]]; do
    sleep 1
    WAITED=$((WAITED + 1))

    # redis-cli PING으로 연결 확인
    if command -v redis-cli &>/dev/null; then
      local PONG
      PONG=$(redis-cli -u "$REDIS_ENDPOINT" PING 2>/dev/null || echo "FAIL")
      if [[ "$PONG" != "PONG" && -z "$DOWNTIME_START" ]]; then
        DOWNTIME_START=$(date +%s)
        log_warn "  [${WAITED}s] Redis 응답 없음"
      elif [[ "$PONG" == "PONG" && -n "$DOWNTIME_START" && -z "$DOWNTIME_END" ]]; then
        DOWNTIME_END=$(date +%s)
        log_ok "  [${WAITED}s] Redis 응답 복구 (PONG)"
        break
      fi
    else
      # redis-cli 없으면 ElastiCache API로 상태 확인
      local STATUS
      STATUS=$(aws elasticache describe-replication-groups \
        --replication-group-id "$REPLICATION_GROUP" \
        --region "$REGION" \
        --query 'ReplicationGroups[0].Status' \
        --output text 2>/dev/null || echo "unknown")

      if (( WAITED % 5 == 0 )); then
        log_info "  [${WAITED}s] 복제 그룹 상태: ${STATUS}"
      fi

      if [[ "$STATUS" == "available" && $WAITED -gt 5 ]]; then
        DOWNTIME_END=$(date +%s)
        log_ok "  [${WAITED}s] 복제 그룹 상태: available"
        break
      fi
    fi
  done

  local END_EPOCH
  END_EPOCH=$(date +%s)

  if [[ -n "$DOWNTIME_START" && -n "$DOWNTIME_END" ]]; then
    local DOWNTIME
    DOWNTIME=$(elapsed_seconds "$DOWNTIME_START" "$DOWNTIME_END")
    if [[ $DOWNTIME -le 5 ]]; then
      log_ok "페일오버 다운타임: ${DOWNTIME}초 (목표 5초 이내 — PASS)"
      tee_log "결과: PASS — 다운타임 ${DOWNTIME}초 (목표 <5초)"
    else
      log_warn "페일오버 다운타임: ${DOWNTIME}초 (목표 5초 초과 — WARN)"
      tee_log "결과: WARN — 다운타임 ${DOWNTIME}초 (목표 <5초 초과)"
    fi
  elif [[ -z "$DOWNTIME_START" ]]; then
    local TOTAL
    TOTAL=$(elapsed_seconds "$START_EPOCH" "$END_EPOCH")
    log_ok "다운타임 미감지 — 전체 소요시간 ${TOTAL}초"
    tee_log "결과: PASS — 다운타임 미감지 (소요 ${TOTAL}초)"
  else
    log_fail "복구 확인 실패 (${MAX_WAIT}초 초과)"
    tee_log "결과: FAIL — ${MAX_WAIT}초 내 복구 미확인"
  fi
  tee_log ""
}

# ─── Drill 4: 전체 롤링 배포 ─────────────────────────────────────────────────
drill_rolling_deploy() {
  log_step "Drill 4: 전체 롤링 배포 + 헬스체크 검증 (목표: 5xx 0건)"
  tee_log "=== Drill 4: 전체 롤링 배포 ==="
  tee_log "시작 시각: $(date '+%Y-%m-%d %H:%M:%S')"

  local SERVICES=("ticket-gateway" "consumer" "admin")
  local HEALTH_BASE="${HEALTH_BASE:-http://localhost:8021}"

  log_info "대상 서비스: ${SERVICES[*]}"
  log_info "헬스체크 베이스 URL: ${HEALTH_BASE}"

  log_warn "이 드릴은 모든 서비스를 강제 재배포(force-new-deployment)합니다."
  confirm_proceed "전체 롤링 배포를 실행하시겠습니까?" || return 0

  local START_EPOCH
  START_EPOCH=$(date +%s)
  local ERROR_COUNT=0

  # 모든 서비스에 force-new-deployment 실행
  for svc in "${SERVICES[@]}"; do
    log_info "서비스 재배포 시작: ${svc}"
    aws ecs update-service \
      --cluster "$CLUSTER" \
      --service "$svc" \
      --force-new-deployment \
      --region "$REGION" \
      --output text --query 'service.serviceName' 2>/dev/null || {
      log_warn "서비스 ${svc} 재배포 명령 실패 (서비스 미존재 가능)"
    }
  done

  log_info "모든 서비스 재배포 명령 전송 완료. 안정화 대기 중..."

  # 배포 안정화 대기 (최대 10분)
  local MAX_WAIT=600
  local WAITED=0

  while [[ $WAITED -lt $MAX_WAIT ]]; do
    sleep 15
    WAITED=$((WAITED + 15))

    local ALL_STABLE=true
    for svc in "${SERVICES[@]}"; do
      local RUNNING
      RUNNING=$(aws ecs describe-services \
        --cluster "$CLUSTER" \
        --services "$svc" \
        --region "$REGION" \
        --query 'services[0].deployments | length(@)' \
        --output text 2>/dev/null || echo "0")

      if [[ "$RUNNING" != "1" ]]; then
        ALL_STABLE=false
      fi
    done

    if (( WAITED % 30 == 0 )); then
      log_info "  [${WAITED}s] 배포 상태 확인 중... (all_stable=${ALL_STABLE})"
    fi

    if $ALL_STABLE; then
      log_ok "  [${WAITED}s] 모든 서비스 배포 완료 (단일 배포 상태)"
      break
    fi
  done

  # 헬스체크 검증 — 30초간 매 초 요청, 5xx 카운트
  log_info "헬스체크 검증 시작 (30초간 매 초 요청)..."
  local FIVEXX_COUNT=0
  local TOTAL_REQUESTS=0

  for i in $(seq 1 30); do
    local HTTP_CODE
    HTTP_CODE=$(curl_health "${HEALTH_BASE}/health/detailed")
    TOTAL_REQUESTS=$((TOTAL_REQUESTS + 1))

    if [[ "${HTTP_CODE}" =~ ^5 ]]; then
      FIVEXX_COUNT=$((FIVEXX_COUNT + 1))
      log_warn "  [${i}s] HTTP ${HTTP_CODE} — 5xx 감지!"
    fi
    sleep 1
  done

  local END_EPOCH
  END_EPOCH=$(date +%s)
  local ELAPSED
  ELAPSED=$(elapsed_seconds "$START_EPOCH" "$END_EPOCH")

  log_info "총 요청: ${TOTAL_REQUESTS}, 5xx 에러: ${FIVEXX_COUNT}"

  if [[ $FIVEXX_COUNT -eq 0 ]]; then
    log_ok "롤링 배포 완료: ${ELAPSED}초, 5xx 0건 — PASS"
    tee_log "결과: PASS — 소요 ${ELAPSED}초, 5xx 0건 (요청 ${TOTAL_REQUESTS}건)"
  else
    log_fail "롤링 배포 경고: ${ELAPSED}초, 5xx ${FIVEXX_COUNT}건 — FAIL"
    tee_log "결과: FAIL — 소요 ${ELAPSED}초, 5xx ${FIVEXX_COUNT}건 (요청 ${TOTAL_REQUESTS}건)"
  fi
  tee_log ""
}

# ─── 메인 ─────────────────────────────────────────────────────────────────────
main() {
  local DRILL="${1:-all}"

  # 결과 디렉토리 확인
  mkdir -p "$RESULTS_DIR"

  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║          Pickket v2 — DR 훈련 가이드 스크립트              ║"
  echo "║          리전: ${REGION}  클러스터: ${CLUSTER}        ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""

  check_aws_cli

  # 결과 파일 헤더
  tee_log "============================================"
  tee_log "Pickket v2 DR 훈련 결과"
  tee_log "실행 일시: $(date '+%Y-%m-%d %H:%M:%S')"
  tee_log "리전: ${REGION}"
  tee_log "클러스터: ${CLUSTER}"
  tee_log "운영자: $(whoami)"
  tee_log "============================================"
  tee_log ""

  case "$DRILL" in
    1)    drill_ecs_crash ;;
    2)    drill_aurora_failover ;;
    3)    drill_redis_failover ;;
    4)    drill_rolling_deploy ;;
    all)
      drill_ecs_crash
      drill_aurora_failover
      drill_redis_failover
      drill_rolling_deploy
      ;;
    *)
      echo "사용법: $0 [--drill 1|2|3|4|all]"
      echo "  1   ECS 서비스 크래시 복구"
      echo "  2   Aurora 페일오버"
      echo "  3   Redis 노드 장애 페일오버"
      echo "  4   전체 롤링 배포"
      echo "  all 전체 드릴 순차 실행 (기본값)"
      exit 1
      ;;
  esac

  # 최종 요약
  tee_log "============================================"
  tee_log "DR 훈련 종료: $(date '+%Y-%m-%d %H:%M:%S')"
  tee_log "결과 파일: ${RESULT_FILE}"
  tee_log "============================================"

  echo ""
  log_ok "결과가 저장되었습니다: ${RESULT_FILE}"
  echo ""
}

# --drill 옵션 파싱
DRILL_TARGET="all"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --drill) DRILL_TARGET="$2"; shift 2 ;;
    1|2|3|4|all) DRILL_TARGET="$1"; shift ;;
    -h|--help)
      echo "사용법: $0 [--drill 1|2|3|4|all]"
      exit 0
      ;;
    *) echo "알 수 없는 옵션: $1"; exit 1 ;;
  esac
done

main "$DRILL_TARGET"
