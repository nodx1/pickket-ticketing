#!/bin/bash
# 로컬에서 직접 ECS 배포 — GitHub Actions 빌링 이슈 등으로 임시 사용
#
# ⚠️ 주의: 이 스크립트는 비상용. 정상 경로는 GitHub Actions.
# - 감사 로그 없음
# - staging-gate 우회됨 (production 배포 전 staging 검증 강제 안 함)
# - 시크릿이 로컬 파일(.env.deploy.local)에 평문 저장됨
#
# 사용법:
#   1. .env.deploy.local 작성 (.env.deploy.example 참고)
#   2. AWS CLI / Docker Desktop / jq 설치 확인
#   3. ./scripts/deploy-local.sh staging   (또는 production)

set -euo pipefail

ENV="${1:-staging}"
if [[ "$ENV" != "staging" && "$ENV" != "production" ]]; then
  echo "❌ 사용법: $0 [staging|production]" >&2
  exit 1
fi

# ─── 1. 환경변수 로드 ────────────────────────────────────────────────
if [[ ! -f ".env.deploy.local" ]]; then
  echo "❌ .env.deploy.local 파일이 없음. .env.deploy.example 복사해서 채우기." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env.deploy.local
set +a

# 필수 변수 검증
required=(AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION ECR_REGISTRY ECR_REPOSITORY \
  NEXT_PUBLIC_COMPANY_NAME NEXT_PUBLIC_COMPANY_ADDRESS NEXT_PUBLIC_CONTACT_EMAIL \
  NEXT_PUBLIC_OWNER_NAME NEXT_PUBLIC_BUSINESS_NUMBER NEXT_PUBLIC_ECOMMERCE_NUMBER \
  NEXT_PUBLIC_BANK_NAME NEXT_PUBLIC_BANK_ACCOUNT NEXT_PUBLIC_BANK_HOLDER)
for v in "${required[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    echo "❌ $v 가 .env.deploy.local 에 없음" >&2
    exit 1
  fi
done

# 도구 확인
for cmd in aws docker jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "❌ $cmd 설치 필요" >&2
    exit 1
  fi
done
if ! docker info &>/dev/null; then
  echo "❌ Docker Desktop 실행 안 됨" >&2
  exit 1
fi

# ─── 2. 환경별 설정 ──────────────────────────────────────────────────
if [[ "$ENV" == "production" ]]; then
  CLUSTER="pickket"
  GO_DOMAIN="go.pickket.kr"
  IMAGE_LATEST_TAG="prod-latest"
else
  CLUSTER="pickket-stg"
  GO_DOMAIN="go-staging.pickket.kr"
  IMAGE_LATEST_TAG="staging-latest"
fi
SERVICE="organizer"
COMMIT_SHA=$(git rev-parse HEAD)
IMAGE_URI="${ECR_REGISTRY}/${ECR_REPOSITORY}:${COMMIT_SHA}"
LATEST_URI="${ECR_REGISTRY}/${ECR_REPOSITORY}:${IMAGE_LATEST_TAG}"

echo "🎯 배포 시작"
echo "   환경: $ENV"
echo "   클러스터: $CLUSTER"
echo "   도메인: $GO_DOMAIN"
echo "   커밋: ${COMMIT_SHA:0:7}"
echo ""

# ─── 3. ECR 로그인 ───────────────────────────────────────────────────
echo "🔑 ECR 로그인..."
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"

# ─── 4. Docker 빌드 + push ───────────────────────────────────────────
echo ""
echo "🏗  Docker 이미지 빌드 + push (linux/amd64, 10~20분 소요)..."
docker buildx build \
  --platform linux/amd64 \
  --build-arg "NEXT_PUBLIC_APP_URL=https://${GO_DOMAIN}" \
  --build-arg "NEXT_PUBLIC_COMPANY_NAME=${NEXT_PUBLIC_COMPANY_NAME}" \
  --build-arg "NEXT_PUBLIC_COMPANY_ADDRESS=${NEXT_PUBLIC_COMPANY_ADDRESS}" \
  --build-arg "NEXT_PUBLIC_CONTACT_EMAIL=${NEXT_PUBLIC_CONTACT_EMAIL}" \
  --build-arg "NEXT_PUBLIC_OWNER_NAME=${NEXT_PUBLIC_OWNER_NAME}" \
  --build-arg "NEXT_PUBLIC_BUSINESS_NUMBER=${NEXT_PUBLIC_BUSINESS_NUMBER}" \
  --build-arg "NEXT_PUBLIC_ECOMMERCE_NUMBER=${NEXT_PUBLIC_ECOMMERCE_NUMBER}" \
  --build-arg "NEXT_PUBLIC_BANK_NAME=${NEXT_PUBLIC_BANK_NAME}" \
  --build-arg "NEXT_PUBLIC_BANK_ACCOUNT=${NEXT_PUBLIC_BANK_ACCOUNT}" \
  --build-arg "NEXT_PUBLIC_BANK_HOLDER=${NEXT_PUBLIC_BANK_HOLDER}" \
  -f Dockerfile \
  -t "$IMAGE_URI" \
  -t "$LATEST_URI" \
  --push \
  .

echo "✅ 이미지 push 완료: $IMAGE_URI"

# ─── 5. 마이그레이션 (one-off ECS task) ──────────────────────────────
echo ""
echo "🗄  DB 마이그레이션 실행..."

CURRENT_TASKDEF_ARN=$(aws ecs describe-services \
  --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].taskDefinition' --output text)

CURRENT_TASKDEF=$(aws ecs describe-task-definition \
  --task-definition "$CURRENT_TASKDEF_ARN" \
  --query 'taskDefinition' --output json)

UPDATED=$(echo "$CURRENT_TASKDEF" | jq --arg img "$IMAGE_URI" '
  del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
      .compatibilities, .registeredAt, .registeredBy, .deregisteredAt) |
  .containerDefinitions[0].image = $img')

NEW_TASKDEF_ARN=$(aws ecs register-task-definition \
  --cli-input-json "$UPDATED" \
  --query 'taskDefinition.taskDefinitionArn' --output text)

echo "   새 task def: $NEW_TASKDEF_ARN"

NETWORK_CONFIG=$(aws ecs describe-services \
  --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].networkConfiguration' --output json)

TASK_ARN=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$NEW_TASKDEF_ARN" \
  --launch-type FARGATE \
  --network-configuration "$NETWORK_CONFIG" \
  --overrides '{"containerOverrides":[{"name":"organizer","command":["npx","tsx","scripts/migrate.ts"]}]}' \
  --query 'tasks[0].taskArn' --output text)

echo "   마이그레이션 task: $TASK_ARN"
echo "   완료 대기 중..."
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

EXIT_CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)

if [[ "$EXIT_CODE" != "0" ]]; then
  echo "❌ 마이그레이션 실패 (exit=$EXIT_CODE)"
  aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
    --query 'tasks[0].stoppedReason' --output text
  exit 1
fi
echo "✅ 마이그레이션 완료"

# ─── 6. 서비스 업데이트 ──────────────────────────────────────────────
echo ""
echo "🚀 서비스 업데이트..."
aws ecs update-service \
  --cluster "$CLUSTER" --service "$SERVICE" \
  --task-definition "$NEW_TASKDEF_ARN" \
  --force-new-deployment >/dev/null

echo "   배포 안정화 대기 (최대 20분)..."
for i in $(seq 1 80); do
  STATUS=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
    --query 'services[0].deployments[?status==`PRIMARY`].rolloutState' \
    --output text 2>/dev/null || echo "UNKNOWN")
  RUNNING=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
    --query 'services[0].{r:runningCount,d:desiredCount}' --output text 2>/dev/null || echo "0 0")
  echo "   [$i/80] rolloutState=$STATUS running/desired=$RUNNING"

  if [[ "$STATUS" == "COMPLETED" ]]; then
    echo "✅ 배포 완료"
    break
  fi
  if [[ "$STATUS" == "FAILED" ]]; then
    echo "❌ 배포 실패 — 수동 롤백 필요"
    exit 1
  fi
  sleep 15
done

# ─── 7. 스모크 테스트 ─────────────────────────────────────────────────
echo ""
echo "🩺 헬스체크..."
for i in $(seq 1 20); do
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" "https://${GO_DOMAIN}/api/health/ready" || echo "000")
  echo "   [$i/20] HTTP $HTTP"
  if [[ "$HTTP" == "200" ]]; then
    echo "✅ 헬스체크 통과"
    break
  fi
  sleep 10
done

echo ""
echo "🎉 배포 성공"
echo "   URL: https://${GO_DOMAIN}"
echo "   커밋: ${COMMIT_SHA:0:7}"
