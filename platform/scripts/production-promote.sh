#!/usr/bin/env bash
# =============================================================================
# Pickket v2 — Production 승격 체크리스트
#
# Staging에서 검증 완료된 인프라를 Production에 적용하기 전
# 모든 전제조건을 자동 확인하는 스크립트.
#
# 사용법:
#   bash scripts/production-promote.sh
# =============================================================================
set -euo pipefail

REGION="ap-northeast-2"
PREFIX="pickket-v2"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { echo "[$(date '+%H:%M:%S')] ✓ $*"; }
fail() { echo "[$(date '+%H:%M:%S')] ✗ $*"; FAILURES=$((FAILURES + 1)); }
warn() { echo "[$(date '+%H:%M:%S')] ⚠ $*"; WARNINGS=$((WARNINGS + 1)); }

FAILURES=0
WARNINGS=0

log "=============================="
log "  Production 승격 전 체크리스트"
log "=============================="
log ""

# =============================================================================
# 1. Terraform 상태 확인
# =============================================================================
log "=== 1. Terraform 상태 ==="

if command -v terraform &>/dev/null; then
  # Staging에 변경사항 없는지 확인
  cd infra/terraform/environments/staging 2>/dev/null && {
    PLAN_OUTPUT=$(terraform plan -input=false -no-color 2>&1 | tail -5 || echo "ERROR")
    if echo "$PLAN_OUTPUT" | grep -q "No changes"; then
      pass "Staging: terraform plan — 변경사항 없음"
    else
      warn "Staging: terraform plan에 변경사항 있음 — 먼저 staging apply 필요"
    fi
    cd "$OLDPWD"
  } || warn "Staging terraform 디렉토리 접근 불가"
else
  warn "terraform CLI 미설치"
fi

# =============================================================================
# 2. Staging 서비스 상태
# =============================================================================
log ""
log "=== 2. Staging 서비스 상태 ==="

# ECS 서비스 상태
for service in backend consumer admin ticket-gateway realtime-hub celery-worker; do
  SVC_STATUS=$(aws ecs describe-services \
    --cluster pickket \
    --services "pickket-stg-${service}" \
    --query 'services[0].status' --output text --region "$REGION" 2>/dev/null || echo "NOT_FOUND")

  if [[ "$SVC_STATUS" == "ACTIVE" ]]; then
    RUNNING=$(aws ecs describe-services \
      --cluster pickket \
      --services "pickket-stg-${service}" \
      --query 'services[0].runningCount' --output text --region "$REGION" 2>/dev/null || echo "0")
    pass "Staging ${service}: ACTIVE (${RUNNING} tasks)"
  else
    fail "Staging ${service}: ${SVC_STATUS}"
  fi
done

# =============================================================================
# 3. 부하 테스트 결과 존재
# =============================================================================
log ""
log "=== 3. 부하 테스트 결과 ==="

LOAD_TEST_DIR="docs/operations/load-test-results"
RESULT_COUNT=$(find "$LOAD_TEST_DIR" -name "*.md" ! -name "TEMPLATE.md" 2>/dev/null | wc -l)
if [[ "$RESULT_COUNT" -gt 0 ]]; then
  pass "부하 테스트 결과 ${RESULT_COUNT}건 존재"
else
  fail "부하 테스트 결과 없음 — staging 부하 테스트 먼저 실행"
fi

# =============================================================================
# 4. DR Drill 결과 존재
# =============================================================================
log ""
log "=== 4. DR Drill 결과 ==="

DR_DIR="docs/operations/dr-drill-results"
DR_COUNT=$(find "$DR_DIR" -name "*.md" 2>/dev/null | wc -l)
if [[ "$DR_COUNT" -gt 0 ]]; then
  pass "DR drill 결과 ${DR_COUNT}건 존재"
else
  warn "DR drill 결과 없음 — 선행 권장"
fi

# =============================================================================
# 5. GitHub Secrets 확인 (간접)
# =============================================================================
log ""
log "=== 5. AWS 리소스 확인 ==="

# S3 상태 버킷
aws s3 ls "s3://pickket-terraform-state/" --region "$REGION" &>/dev/null && \
  pass "Terraform state S3 버킷 접근 가능" || \
  fail "Terraform state S3 버킷 접근 불가"

# DynamoDB 잠금 테이블
aws dynamodb describe-table --table-name pickket-terraform-locks --region "$REGION" &>/dev/null && \
  pass "Terraform locks DynamoDB 테이블 존재" || \
  fail "Terraform locks DynamoDB 테이블 없음"

# ACM 인증서
CERT_STATUS=$(aws acm list-certificates \
  --query "CertificateSummaryList[?DomainName=='pickket.kr'].Status | [0]" \
  --output text --region "$REGION" 2>/dev/null || echo "NOT_FOUND")
if [[ "$CERT_STATUS" == "ISSUED" ]]; then
  pass "ACM 인증서 (pickket.kr): ISSUED"
else
  fail "ACM 인증서 상태: ${CERT_STATUS}"
fi

# =============================================================================
# 6. Production 시크릿
# =============================================================================
log ""
log "=== 6. Production Secrets Manager ==="

CRITICAL_SECRETS=("database-credentials" "secret-key" "database-url" "redis-url")
for secret in "${CRITICAL_SECRETS[@]}"; do
  aws secretsmanager describe-secret \
    --secret-id "pickket-prod/${secret}" \
    --region "$REGION" &>/dev/null && \
    pass "Secret pickket-prod/${secret} 존재" || \
    fail "Secret pickket-prod/${secret} 없음"
done

# =============================================================================
# 결과
# =============================================================================
log ""
log "=============================="
log "  체크리스트 완료"
log "=============================="
log ""
log "  통과: $((FAILURES == 0 && WARNINGS == 0 ? 1 : 0)) — 실패: ${FAILURES}, 경고: ${WARNINGS}"
log ""

if [[ $FAILURES -gt 0 ]]; then
  log "  ❌ Production 승격 불가 — ${FAILURES}건 실패 해결 필요"
  exit 1
elif [[ $WARNINGS -gt 0 ]]; then
  log "  ⚠ 경고 ${WARNINGS}건 — 확인 후 진행 가능"
  log ""
  log "  승격 진행:"
  log "    cd infra/terraform/environments/production"
  log "    terraform plan"
  log "    terraform apply  # 꼼꼼히 리뷰 후"
  exit 0
else
  log "  ✅ 모든 검증 통과 — Production 승격 가능"
  log ""
  log "  승격 진행:"
  log "    cd infra/terraform/environments/production"
  log "    terraform plan"
  log "    terraform apply  # 꼼꼼히 리뷰 후"
  exit 0
fi
