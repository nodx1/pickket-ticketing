#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# verify-prod-secrets.sh — Production 시크릿 PLACEHOLDER 점검 스크립트
#
# 8개 PLACEHOLDER 시크릿의 실값 입력 여부를 확인합니다.
# 실값이 입력되면 ✅, PLACEHOLDER면 ❌로 표시합니다.
#
# 사용법: ./verify-prod-secrets.sh [--env stg|prod]
###############################################################################

REGION="ap-northeast-2"
ENV="${1:-prod}"

# --env 파라미터 파싱
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV="$2"; shift 2 ;;
    stg|prod) ENV="$1"; shift ;;
    *) shift ;;
  esac
done

PREFIX="pickket-${ENV}"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Pickket ${ENV} — 시크릿 PLACEHOLDER 점검           ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# PLACEHOLDER 시크릿 목록 + 참조 서비스
declare -A SECRETS
SECRETS=(
  ["portone-api-secret"]="backend, celery-worker, celery-beat | 결제 PG 연동 (PortOne API 키)"
  ["portone-webhook-secret"]="backend, celery-worker, celery-beat | 결제 웹훅 검증 시크릿"
  ["sentry-dsn"]="backend, celery-worker, celery-beat | 에러 추적 (Sentry DSN URL)"
  ["redis-cluster-nodes"]="backend, celery-worker, celery-beat, realtime-hub, ticket-gateway | Redis 클러스터 노드 주소"
  ["totp-encryption-key"]="backend | TOTP 2FA 암호화 키"
  ["s3-access-key"]="backend, celery-worker, celery-beat | S3 파일 업로드 (AWS Access Key)"
  ["s3-secret-key"]="backend, celery-worker, celery-beat | S3 파일 업로드 (AWS Secret Key)"
  ["database-read-url"]="backend | 읽기 전용 DB URL (Aurora Read Replica)"
)

PASS=0
FAIL=0

for secret_name in $(echo "${!SECRETS[@]}" | tr ' ' '\n' | sort); do
  full_name="${PREFIX}/${secret_name}"
  info="${SECRETS[$secret_name]}"

  # 시크릿 값 조회 (첫 20자만)
  VALUE=$(aws secretsmanager get-secret-value \
    --secret-id "$full_name" \
    --region "$REGION" \
    --query 'SecretString' --output text 2>/dev/null || echo "NOT_FOUND")

  if [[ "$VALUE" == "NOT_FOUND" ]]; then
    echo "❌ ${secret_name} — 시크릿 미존재"
    echo "   서비스: ${info}"
    FAIL=$((FAIL + 1))
  elif [[ "$VALUE" == *"PLACEHOLDER"* || "$VALUE" == *"placeholder"* || "$VALUE" == *"REPLACE_ME"* || -z "$VALUE" ]]; then
    echo "❌ ${secret_name} — PLACEHOLDER (실값 미입력)"
    echo "   서비스: ${info}"
    FAIL=$((FAIL + 1))
  else
    # 보안상 값은 마스킹
    MASKED="${VALUE:0:4}****"
    echo "✅ ${secret_name} — 실값 입력됨 (${MASKED})"
    PASS=$((PASS + 1))
  fi
  echo ""
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "결과: ✅ ${PASS}개 OK / ❌ ${FAIL}개 PLACEHOLDER"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo "⚠️  ${FAIL}개 시크릿에 실값을 입력해야 합니다."
  echo "   aws secretsmanager put-secret-value \\"
  echo "     --secret-id ${PREFIX}/<시크릿명> \\"
  echo "     --secret-string '<실값>' \\"
  echo "     --region ${REGION}"
  echo ""
  echo "입력 후 이 스크립트를 다시 실행하여 확인하세요."
  exit 1
fi

echo ""
echo "✅ 모든 시크릿에 실값이 입력되었습니다."
exit 0
