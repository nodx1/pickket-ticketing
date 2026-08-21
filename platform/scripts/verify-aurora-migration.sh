#!/usr/bin/env bash
# =============================================================================
# Aurora Serverless v2 마이그레이션 검증 스크립트
#
# 사용법:
#   export DATABASE_URL="postgresql+asyncpg://..."
#   export DATABASE_URL_SYNC="postgresql+psycopg2://..."
#   bash scripts/verify-aurora-migration.sh
# =============================================================================
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-2}"
CLUSTER_ID="${AURORA_CLUSTER_ID:-pickket-aurora-v2}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { echo "[$(date '+%H:%M:%S')] ✓ PASS — $*"; }
fail() { echo "[$(date '+%H:%M:%S')] ✗ FAIL — $*"; FAILURES=$((FAILURES + 1)); }

FAILURES=0

# =============================================================================
# 1. Aurora 클러스터 상태 확인
# =============================================================================
log "=== 1. Aurora Cluster Status ==="

CLUSTER_STATUS=$(aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_ID" \
  --query 'DBClusters[0].Status' --output text --region "$REGION" 2>/dev/null || echo "NOT_FOUND")

if [[ "$CLUSTER_STATUS" == "available" ]]; then
  pass "Aurora cluster '$CLUSTER_ID' is available"
else
  fail "Aurora cluster status: $CLUSTER_STATUS (expected: available)"
fi

# Writer/Reader 인스턴스 확인
WRITER_STATUS=$(aws rds describe-db-instances \
  --db-instance-identifier "${CLUSTER_ID}-writer" \
  --query 'DBInstances[0].DBInstanceStatus' --output text --region "$REGION" 2>/dev/null || echo "NOT_FOUND")

READER_STATUS=$(aws rds describe-db-instances \
  --db-instance-identifier "${CLUSTER_ID}-reader" \
  --query 'DBInstances[0].DBInstanceStatus' --output text --region "$REGION" 2>/dev/null || echo "NOT_FOUND")

[[ "$WRITER_STATUS" == "available" ]] && pass "Writer instance available" || fail "Writer status: $WRITER_STATUS"
[[ "$READER_STATUS" == "available" ]] && pass "Reader instance available" || fail "Reader status: $READER_STATUS"

# =============================================================================
# 2. RDS Proxy 상태 확인
# =============================================================================
log ""
log "=== 2. RDS Proxy Status ==="

PROXY_STATUS=$(aws rds describe-db-proxies \
  --db-proxy-name "pickket-v2-db-proxy" \
  --query 'DBProxies[0].Status' --output text --region "$REGION" 2>/dev/null || echo "NOT_FOUND")

if [[ "$PROXY_STATUS" == "available" ]]; then
  pass "RDS Proxy available"

  PROXY_ENDPOINT=$(aws rds describe-db-proxies \
    --db-proxy-name "pickket-v2-db-proxy" \
    --query 'DBProxies[0].Endpoint' --output text --region "$REGION")
  log "  Proxy endpoint: $PROXY_ENDPOINT"
else
  fail "RDS Proxy status: $PROXY_STATUS"
fi

# =============================================================================
# 3. Alembic 마이그레이션 상태
# =============================================================================
log ""
log "=== 3. Alembic Migration ==="

if command -v alembic &>/dev/null || [[ -f "backend/.venv/bin/alembic" ]]; then
  ALEMBIC_CMD="${ALEMBIC_CMD:-backend/.venv/bin/alembic}"
  cd backend 2>/dev/null || true

  CURRENT=$($ALEMBIC_CMD current 2>/dev/null | tail -1 || echo "ERROR")
  HEAD=$($ALEMBIC_CMD heads 2>/dev/null | tail -1 || echo "ERROR")

  if [[ "$CURRENT" == *"$HEAD"* ]] || [[ "$CURRENT" == "$HEAD" ]]; then
    pass "Alembic at head: $CURRENT"
  else
    fail "Alembic not at head. Current: $CURRENT, Head: $HEAD"
  fi

  cd - &>/dev/null || true
else
  log "  [SKIP] alembic not found — manual check required"
fi

# =============================================================================
# 4. 읽기/쓰기 테스트 (psql)
# =============================================================================
log ""
log "=== 4. Read/Write Test ==="

if command -v psql &>/dev/null && [[ -n "${DATABASE_URL_SYNC:-}" ]]; then
  # Extract connection string for psql (convert psycopg2 URL)
  PSQL_URL=$(echo "$DATABASE_URL_SYNC" | sed 's|postgresql+psycopg2://|postgresql://|')

  # Write test
  WRITE_RESULT=$(psql "$PSQL_URL" -c "SELECT 1 AS write_test;" -t 2>/dev/null | tr -d ' \n' || echo "ERROR")
  [[ "$WRITE_RESULT" == "1" ]] && pass "Write query successful" || fail "Write query failed: $WRITE_RESULT"

  # Read test (count a known table)
  TABLE_COUNT=$(psql "$PSQL_URL" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" -t 2>/dev/null | tr -d ' \n' || echo "ERROR")
  if [[ "$TABLE_COUNT" =~ ^[0-9]+$ ]] && [[ "$TABLE_COUNT" -gt 0 ]]; then
    pass "Read query successful — $TABLE_COUNT public tables"
  else
    fail "Read query failed: $TABLE_COUNT"
  fi
else
  log "  [SKIP] psql not available or DATABASE_URL_SYNC not set"
fi

# =============================================================================
# 5. ACU 스케일링 확인
# =============================================================================
log ""
log "=== 5. Aurora ACU Scaling Config ==="

ACU_CONFIG=$(aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_ID" \
  --query 'DBClusters[0].ServerlessV2ScalingConfiguration' --output json --region "$REGION" 2>/dev/null || echo "{}")

MIN_ACU=$(echo "$ACU_CONFIG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('MinCapacity','?'))" 2>/dev/null || echo "?")
MAX_ACU=$(echo "$ACU_CONFIG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('MaxCapacity','?'))" 2>/dev/null || echo "?")

log "  Min ACU: $MIN_ACU, Max ACU: $MAX_ACU"
[[ "$MIN_ACU" != "?" ]] && pass "ACU scaling configured" || fail "ACU scaling not configured"

# =============================================================================
# 결과
# =============================================================================
log ""
log "=============================="
if [[ $FAILURES -eq 0 ]]; then
  log "  모든 검증 통과!"
else
  log "  ${FAILURES}건 실패 — 수동 확인 필요"
fi
log "=============================="

exit $FAILURES
