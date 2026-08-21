#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# chaos-test.sh — Pickket v2 카오스 테스트 자동화 스크립트
#
# 시나리오:
#   --scenario ecs-kill       ECS 서비스 desired-count 0 → 복구 → 측정
#   --scenario db-failover    Aurora 페일오버 트리거 → 다운타임 측정
#   --scenario redis-failover ElastiCache 페일오버 테스트 → 다운타임 측정
#   --scenario spike          k6로 즉시 2000 VU 트래픽 급증 → 응답 확인
#
# 사용법:
#   ./chaos-test.sh --scenario ecs-kill [--service ticket-gateway]
#   ./chaos-test.sh --scenario db-failover
#   ./chaos-test.sh --scenario redis-failover
#   ./chaos-test.sh --scenario spike [--target http://localhost:8021]
#
# 모든 시나리오는 시작/종료 시각, 복구 시간, 결과 요약을 출력합니다.
###############################################################################

# ─── 설정 ────────────────────────────────────────────────────────────────────
REGION="ap-northeast-2"
CLUSTER="pickket-v2"
DB_CLUSTER="${CLUSTER}-db"
REDIS_REPLICATION_GROUP="${CLUSTER}-redis"
HEALTH_ENDPOINT="${HEALTH_ENDPOINT:-http://localhost:8021/health/detailed}"

# ─── 색상 & 로깅 ─────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_info()    { echo -e "[$(date '+%H:%M:%S')] ${CYAN}[INFO]${NC}    $*"; }
log_ok()      { echo -e "[$(date '+%H:%M:%S')] ${GREEN}[OK]${NC}      $*"; }
log_warn()    { echo -e "[$(date '+%H:%M:%S')] ${YELLOW}[WARN]${NC}    $*"; }
log_fail()    { echo -e "[$(date '+%H:%M:%S')] ${RED}[FAIL]${NC}    $*"; }
log_section() { echo -e "\n${BOLD}${CYAN}━━━━━━━━━━ $* ━━━━━━━━━━${NC}\n"; }

elapsed_seconds() {
  echo $(( $2 - $1 ))
}

print_summary() {
  local scenario="$1" start="$2" end="$3" result="$4" detail="${5:-}"
  local elapsed
  elapsed=$(elapsed_seconds "$start" "$end")
  echo ""
  echo "┌──────────────────────────────────────────────┐"
  echo "│  카오스 테스트 결과 요약                     │"
  echo "├──────────────────────────────────────────────┤"
  printf "│  시나리오  : %-32s│\n" "$scenario"
  printf "│  시작 시각 : %-32s│\n" "$(date -d @"$start" '+%Y-%m-%d %H:%M:%S')"
  printf "│  종료 시각 : %-32s│\n" "$(date -d @"$end" '+%Y-%m-%d %H:%M:%S')"
  printf "│  소요 시간 : %-32s│\n" "${elapsed}초"
  printf "│  결과      : %-32s│\n" "$result"
  if [[ -n "$detail" ]]; then
    printf "│  상세      : %-32s│\n" "$detail"
  fi
  echo "└──────────────────────────────────────────────┘"
  echo ""
}

check_dependency() {
  local cmd="$1" name="${2:-$1}"
  if ! command -v "$cmd" &>/dev/null; then
    log_fail "${name}이(가) 설치되어 있지 않습니다."
    return 1
  fi
}

# ─── 시나리오 1: ECS 서비스 킬 & 복구 ────────────────────────────────────────
scenario_ecs_kill() {
  local SERVICE="${ECS_SERVICE:-ticket-gateway}"
  log_section "카오스: ECS 서비스 킬 — ${SERVICE}"

  check_dependency aws "AWS CLI"

  # 현재 desired count 저장 (복원용)
  local ORIGINAL_DESIRED
  ORIGINAL_DESIRED=$(aws ecs describe-services \
    --cluster "$CLUSTER" \
    --services "$SERVICE" \
    --region "$REGION" \
    --query 'services[0].desiredCount' \
    --output text 2>/dev/null || echo "2")

  log_info "원래 desired count: ${ORIGINAL_DESIRED}"
  log_info "desired count를 0으로 설정합니다..."

  local START_EPOCH
  START_EPOCH=$(date +%s)

  # desired count → 0
  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$SERVICE" \
    --desired-count 0 \
    --region "$REGION" \
    --output text --query 'service.serviceName' || {
    log_fail "서비스 업데이트 실패"
    return 1
  }

  log_info "서비스 중단 대기 (30초)..."
  sleep 30

  # 현재 running count 확인
  local RUNNING_AFTER_KILL
  RUNNING_AFTER_KILL=$(aws ecs describe-services \
    --cluster "$CLUSTER" \
    --services "$SERVICE" \
    --region "$REGION" \
    --query 'services[0].runningCount' \
    --output text 2>/dev/null || echo "?")
  log_info "중단 후 running count: ${RUNNING_AFTER_KILL}"

  # desired count 복원
  log_info "desired count를 ${ORIGINAL_DESIRED}(으)로 복원합니다..."
  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$SERVICE" \
    --desired-count "$ORIGINAL_DESIRED" \
    --region "$REGION" \
    --output text --query 'service.serviceName' || {
    log_fail "서비스 복원 실패! 수동 확인 필요: desired-count=${ORIGINAL_DESIRED}"
    return 1
  }

  # 복구 대기 모니터링
  log_info "복구 모니터링 시작 (매 10초)..."
  local MAX_WAIT=300
  local WAITED=0
  local RECOVERED=false

  while [[ $WAITED -lt $MAX_WAIT ]]; do
    sleep 10
    WAITED=$((WAITED + 10))

    local RUNNING
    RUNNING=$(aws ecs describe-services \
      --cluster "$CLUSTER" \
      --services "$SERVICE" \
      --region "$REGION" \
      --query 'services[0].runningCount' \
      --output text 2>/dev/null || echo "0")

    log_info "  [${WAITED}s] running=${RUNNING} / desired=${ORIGINAL_DESIRED}"

    if [[ "$RUNNING" == "$ORIGINAL_DESIRED" ]]; then
      RECOVERED=true
      break
    fi
  done

  local END_EPOCH
  END_EPOCH=$(date +%s)
  local RECOVERY_TIME
  RECOVERY_TIME=$(elapsed_seconds "$START_EPOCH" "$END_EPOCH")

  if $RECOVERED; then
    print_summary "ecs-kill (${SERVICE})" "$START_EPOCH" "$END_EPOCH" "PASS" "복구 시간: ${RECOVERY_TIME}초"
  else
    print_summary "ecs-kill (${SERVICE})" "$START_EPOCH" "$END_EPOCH" "FAIL" "복구 미완료 (${MAX_WAIT}초 초과)"
  fi
}

# ─── 시나리오 2: Aurora DB 페일오버 ───────────────────────────────────────────
scenario_db_failover() {
  log_section "카오스: Aurora DB 페일오버 — ${DB_CLUSTER}"

  check_dependency aws "AWS CLI"
  check_dependency curl "curl"

  local START_EPOCH
  START_EPOCH=$(date +%s)

  # 페일오버 트리거
  log_info "Aurora 페일오버 실행..."
  aws rds failover-db-cluster \
    --db-cluster-identifier "$DB_CLUSTER" \
    --region "$REGION" \
    --output text --query 'DBCluster.Status' || {
    log_fail "페일오버 명령 실패"
    return 1
  }

  # 엔드포인트 모니터링 — 다운타임 측정
  log_info "헬스체크로 다운타임 측정 중 (1초 간격, 최대 120초)..."
  local MAX_WAIT=120
  local WAITED=0
  local DOWNTIME_START=""
  local DOWNTIME_END=""

  while [[ $WAITED -lt $MAX_WAIT ]]; do
    sleep 1
    WAITED=$((WAITED + 1))

    local HTTP_CODE
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$HEALTH_ENDPOINT" 2>/dev/null || echo "000")

    if [[ "$HTTP_CODE" != "200" && -z "$DOWNTIME_START" ]]; then
      DOWNTIME_START=$(date +%s)
      log_warn "  [${WAITED}s] 다운타임 감지 (HTTP ${HTTP_CODE})"
    elif [[ "$HTTP_CODE" == "200" && -n "$DOWNTIME_START" && -z "$DOWNTIME_END" ]]; then
      DOWNTIME_END=$(date +%s)
      log_ok "  [${WAITED}s] 서비스 복구 (HTTP 200)"
      break
    elif (( WAITED % 10 == 0 )); then
      log_info "  [${WAITED}s] HTTP ${HTTP_CODE}"
    fi
  done

  local END_EPOCH
  END_EPOCH=$(date +%s)

  if [[ -n "$DOWNTIME_START" && -n "$DOWNTIME_END" ]]; then
    local DOWNTIME
    DOWNTIME=$(elapsed_seconds "$DOWNTIME_START" "$DOWNTIME_END")
    local RESULT="PASS"
    [[ $DOWNTIME -gt 30 ]] && RESULT="WARN"
    print_summary "db-failover" "$START_EPOCH" "$END_EPOCH" "$RESULT" "다운타임: ${DOWNTIME}초 (목표 <30초)"
  elif [[ -z "$DOWNTIME_START" ]]; then
    print_summary "db-failover" "$START_EPOCH" "$END_EPOCH" "PASS" "다운타임 0초 (RDS Proxy)"
  else
    print_summary "db-failover" "$START_EPOCH" "$END_EPOCH" "FAIL" "복구 미확인 (${MAX_WAIT}초 초과)"
  fi
}

# ─── 시나리오 3: Redis 페일오버 ───────────────────────────────────────────────
scenario_redis_failover() {
  log_section "카오스: Redis 페일오버 — ${REDIS_REPLICATION_GROUP}"

  check_dependency aws "AWS CLI"

  # 노드 그룹 ID 조회
  local NODE_GROUP_ID
  NODE_GROUP_ID=$(aws elasticache describe-replication-groups \
    --replication-group-id "$REDIS_REPLICATION_GROUP" \
    --region "$REGION" \
    --query 'ReplicationGroups[0].NodeGroups[0].NodeGroupId' \
    --output text 2>/dev/null || echo "0001")

  local START_EPOCH
  START_EPOCH=$(date +%s)

  # 페일오버 테스트 실행
  log_info "ElastiCache 페일오버 테스트 실행 (노드 그룹: ${NODE_GROUP_ID})..."
  aws elasticache test-failover \
    --replication-group-id "$REDIS_REPLICATION_GROUP" \
    --node-group-id "$NODE_GROUP_ID" \
    --region "$REGION" \
    --output text 2>/dev/null || {
    log_fail "Redis 페일오버 테스트 명령 실패"
    return 1
  }

  # 상태 모니터링
  log_info "복제 그룹 상태 모니터링 중 (5초 간격, 최대 60초)..."
  local MAX_WAIT=60
  local WAITED=0
  local FAILOVER_DETECTED=false

  while [[ $WAITED -lt $MAX_WAIT ]]; do
    sleep 5
    WAITED=$((WAITED + 5))

    local STATUS
    STATUS=$(aws elasticache describe-replication-groups \
      --replication-group-id "$REDIS_REPLICATION_GROUP" \
      --region "$REGION" \
      --query 'ReplicationGroups[0].Status' \
      --output text 2>/dev/null || echo "unknown")

    log_info "  [${WAITED}s] 상태: ${STATUS}"

    if [[ "$STATUS" == "available" && $WAITED -gt 5 ]]; then
      FAILOVER_DETECTED=true
      break
    fi
  done

  local END_EPOCH
  END_EPOCH=$(date +%s)
  local ELAPSED
  ELAPSED=$(elapsed_seconds "$START_EPOCH" "$END_EPOCH")

  if $FAILOVER_DETECTED; then
    local RESULT="PASS"
    [[ $ELAPSED -gt 5 ]] && RESULT="WARN"
    print_summary "redis-failover" "$START_EPOCH" "$END_EPOCH" "$RESULT" "페일오버 완료: ${ELAPSED}초 (목표 <5초)"
  else
    print_summary "redis-failover" "$START_EPOCH" "$END_EPOCH" "FAIL" "복구 미확인 (${MAX_WAIT}초 초과)"
  fi
}

# ─── 시나리오 4: 트래픽 급증 (k6) ────────────────────────────────────────────
scenario_spike() {
  local TARGET_URL="${SPIKE_TARGET:-http://localhost:8021}"
  log_section "카오스: 트래픽 급증 — 즉시 2000 VU → ${TARGET_URL}"

  check_dependency k6 "k6 (https://k6.io)" || {
    log_fail "k6가 설치되어 있지 않습니다. 설치: https://k6.io/docs/get-started/installation/"
    return 1
  }

  # k6 인라인 스크립트 생성
  local K6_SCRIPT
  K6_SCRIPT=$(mktemp /tmp/chaos-spike-XXXXXX.js)

  cat > "$K6_SCRIPT" <<'EOFK6'
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// 즉시 2000 VU 급증 시나리오
export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5s',  target: 2000 }, // 5초 만에 2000 VU 도달
        { duration: '30s', target: 2000 }, // 30초간 유지
        { duration: '10s', target: 0 },    // 10초에 걸쳐 정리
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],        // 실패율 5% 미만
    http_req_duration: ['p(95)<3000'],     // p95 3초 미만
  },
};

const BASE_URL = __ENV.TARGET_URL || 'http://localhost:8021';

export default function () {
  const endpoints = [
    `${BASE_URL}/health/detailed`,
    `${BASE_URL}/api/v1/events`,
  ];

  const url = endpoints[Math.floor(Math.random() * endpoints.length)];
  const res = http.get(url, { timeout: '10s' });

  check(res, {
    'status is not 5xx': (r) => r.status < 500,
    'response time < 5s': (r) => r.timings.duration < 5000,
  });

  sleep(0.1);
}
EOFK6

  log_info "k6 스크립트 생성: ${K6_SCRIPT}"

  local START_EPOCH
  START_EPOCH=$(date +%s)

  # k6 실행
  log_info "k6 실행 중 (2000 VU spike, ~45초)..."
  local K6_OUTPUT
  K6_OUTPUT=$(mktemp /tmp/chaos-spike-result-XXXXXX.txt)

  k6 run \
    -e "TARGET_URL=${TARGET_URL}" \
    --summary-export="${K6_OUTPUT}.json" \
    "$K6_SCRIPT" 2>&1 | tee "$K6_OUTPUT" || true

  local END_EPOCH
  END_EPOCH=$(date +%s)

  # 결과 분석
  local FAILED_RATE
  FAILED_RATE=$(grep -oP 'http_req_failed.*?(\d+\.\d+%)' "$K6_OUTPUT" | grep -oP '\d+\.\d+%' | head -1 || echo "N/A")
  local P95_DURATION
  P95_DURATION=$(grep -oP 'http_req_duration.*?p\(95\)=(\S+)' "$K6_OUTPUT" | grep -oP 'p\(95\)=\S+' | head -1 || echo "N/A")

  log_info "실패율: ${FAILED_RATE}"
  log_info "p95 응답시간: ${P95_DURATION}"

  # 임시 파일 정리
  rm -f "$K6_SCRIPT" "$K6_OUTPUT" "${K6_OUTPUT}.json"

  local RESULT="PASS"
  # 간이 판정 — 실패율 5% 초과 시 FAIL
  if [[ "$FAILED_RATE" != "N/A" ]]; then
    local RATE_NUM
    RATE_NUM=$(echo "$FAILED_RATE" | grep -oP '[\d.]+' || echo "0")
    if awk "BEGIN {exit !($RATE_NUM > 5.0)}"; then
      RESULT="FAIL"
    fi
  fi

  print_summary "spike (2000 VU)" "$START_EPOCH" "$END_EPOCH" "$RESULT" "실패율=${FAILED_RATE}, p95=${P95_DURATION}"
}

# ─── 사용법 출력 ──────────────────────────────────────────────────────────────
usage() {
  echo ""
  echo "사용법: $0 --scenario <시나리오> [옵션]"
  echo ""
  echo "시나리오:"
  echo "  ecs-kill         ECS 서비스를 desired-count 0으로 변경 후 복구 측정"
  echo "  db-failover      Aurora DB 클러스터 페일오버 → 다운타임 측정"
  echo "  redis-failover   ElastiCache 페일오버 테스트 → 다운타임 측정"
  echo "  spike            k6로 즉시 2000 VU 트래픽 급증 테스트"
  echo ""
  echo "옵션:"
  echo "  --service <name>   ecs-kill 대상 서비스 (기본: ticket-gateway)"
  echo "  --target <url>     spike 대상 URL (기본: http://localhost:8021)"
  echo ""
  echo "환경변수:"
  echo "  HEALTH_ENDPOINT    헬스체크 URL (기본: http://localhost:8021/health/detailed)"
  echo "  REGION             AWS 리전 (기본: ap-northeast-2)"
  echo "  CLUSTER            ECS 클러스터 (기본: pickket-v2)"
  echo ""
  echo "예시:"
  echo "  $0 --scenario ecs-kill --service consumer"
  echo "  $0 --scenario db-failover"
  echo "  $0 --scenario spike --target https://api.pickket.kr"
  echo ""
}

# ─── 메인 ─────────────────────────────────────────────────────────────────────
main() {
  local SCENARIO=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --scenario)  SCENARIO="$2"; shift 2 ;;
      --service)   ECS_SERVICE="$2"; shift 2 ;;
      --target)    SPIKE_TARGET="$2"; shift 2 ;;
      -h|--help)   usage; exit 0 ;;
      *)           log_fail "알 수 없는 옵션: $1"; usage; exit 1 ;;
    esac
  done

  if [[ -z "$SCENARIO" ]]; then
    log_fail "--scenario 옵션이 필요합니다."
    usage
    exit 1
  fi

  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║        Pickket v2 — 카오스 테스트 자동화 스크립트          ║"
  echo "║        리전: ${REGION}  클러스터: ${CLUSTER}          ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""

  log_info "시나리오: ${SCENARIO}"
  log_info "시작 시각: $(date '+%Y-%m-%d %H:%M:%S')"

  case "$SCENARIO" in
    ecs-kill)        scenario_ecs_kill ;;
    db-failover)     scenario_db_failover ;;
    redis-failover)  scenario_redis_failover ;;
    spike)           scenario_spike ;;
    *)
      log_fail "알 수 없는 시나리오: ${SCENARIO}"
      usage
      exit 1
      ;;
  esac
}

main "$@"
