#!/usr/bin/env bash
# =============================================================================
# Pickket v2 — Terraform import script for existing AWS resources
# 기존 AWS 리소스를 Terraform 상태에 흡수
#
# 사용법:
#   cd infra/terraform/environments/staging  (또는 production)
#   bash ../../../../scripts/tf-import-existing.sh
#
# 주의: terraform init을 먼저 실행해야 합니다.
# =============================================================================
set -euo pipefail

REGION="ap-northeast-2"
ACCOUNT_ID="794562054294"
PREFIX="pickket-v2"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

import_if_exists() {
  local resource_addr="$1"
  local resource_id="$2"
  local check_cmd="${3:-}"

  # 이미 import 되어 있으면 스킵
  if terraform state show "$resource_addr" &>/dev/null; then
    log "  [SKIP] $resource_addr — 이미 상태에 존재"
    return 0
  fi

  # 리소스 존재 여부 확인 (선택적)
  if [[ -n "$check_cmd" ]]; then
    if ! eval "$check_cmd" &>/dev/null; then
      log "  [SKIP] $resource_addr — AWS에 리소스 없음"
      return 0
    fi
  fi

  log "  [IMPORT] $resource_addr ← $resource_id"
  terraform import "$resource_addr" "$resource_id" || {
    log "  [WARN] $resource_addr import 실패 — 수동 확인 필요"
    return 0
  }
}

# =============================================================================
# IAM Roles
# =============================================================================
log "=== IAM Roles ==="
import_if_exists \
  "module.iam.aws_iam_role.ecs_execution" \
  "pickket-ecs-execution-role" \
  "aws iam get-role --role-name pickket-ecs-execution-role --region $REGION"

import_if_exists \
  "module.iam.aws_iam_role.ecs_task" \
  "pickket-ecs-task-role" \
  "aws iam get-role --role-name pickket-ecs-task-role --region $REGION"

import_if_exists \
  "module.iam.aws_iam_role.rds_proxy" \
  "pickket-rds-proxy-role" \
  "aws iam get-role --role-name pickket-rds-proxy-role --region $REGION"

# =============================================================================
# VPC + Networking
# =============================================================================
log "=== VPC ==="
VPC_ID=$(aws ec2 describe-vpcs \
  --filters "Name=tag:Name,Values=${PREFIX}-vpc" \
  --query 'Vpcs[0].VpcId' --output text --region "$REGION" 2>/dev/null || echo "None")

if [[ "$VPC_ID" != "None" && "$VPC_ID" != "" ]]; then
  import_if_exists "module.networking.aws_vpc.main" "$VPC_ID"

  # Subnets
  for name_suffix in pub-a pub-c priv-a priv-c; do
    SUBNET_ID=$(aws ec2 describe-subnets \
      --filters "Name=tag:Name,Values=${PREFIX}-${name_suffix}" \
      --query 'Subnets[0].SubnetId' --output text --region "$REGION" 2>/dev/null || echo "None")
    if [[ "$SUBNET_ID" != "None" && "$SUBNET_ID" != "" ]]; then
      # Map name suffix to terraform resource name
      case "$name_suffix" in
        pub-a)  tf_name="public_a" ;;
        pub-c)  tf_name="public_c" ;;
        priv-a) tf_name="private_a" ;;
        priv-c) tf_name="private_c" ;;
      esac
      import_if_exists "module.networking.aws_subnet.${tf_name}" "$SUBNET_ID"
    fi
  done

  # Internet Gateway
  IGW_ID=$(aws ec2 describe-internet-gateways \
    --filters "Name=tag:Name,Values=${PREFIX}-igw" \
    --query 'InternetGateways[0].InternetGatewayId' --output text --region "$REGION" 2>/dev/null || echo "None")
  if [[ "$IGW_ID" != "None" && "$IGW_ID" != "" ]]; then
    import_if_exists "module.networking.aws_internet_gateway.main" "$IGW_ID"
  fi

  # Security Groups
  for sg_name in alb-sg ecs-sg rds-sg redis-sg; do
    SG_ID=$(aws ec2 describe-security-groups \
      --filters "Name=group-name,Values=${PREFIX}-${sg_name}" "Name=vpc-id,Values=${VPC_ID}" \
      --query 'SecurityGroups[0].GroupId' --output text --region "$REGION" 2>/dev/null || echo "None")
    if [[ "$SG_ID" != "None" && "$SG_ID" != "" ]]; then
      case "$sg_name" in
        alb-sg)   tf_name="alb" ;;
        ecs-sg)   tf_name="ecs" ;;
        rds-sg)   tf_name="rds" ;;
        redis-sg) tf_name="redis" ;;
      esac
      import_if_exists "module.networking.aws_security_group.${tf_name}" "$SG_ID"
    fi
  done
else
  log "  [SKIP] VPC ${PREFIX}-vpc 없음 — networking 모듈 import 생략"
fi

# =============================================================================
# Secrets Manager
# =============================================================================
log "=== Secrets Manager ==="
ENV="${TF_VAR_environment:-prod}"
SECRET_PREFIX="pickket-${ENV}"

SECRETS=(
  "database-credentials" "database-read-url" "redis-cluster-nodes"
  "s3-access-key" "s3-secret-key" "db-password"
  "portone-api-secret" "portone-webhook-secret" "ncp-sms-secret-key" "sentry-dsn"
  "secret-key" "database-url" "database-url-sync" "redis-url"
  "celery-broker-url" "celery-result-backend"
  "sns-order-topic-arn" "sns-payment-topic-arn" "sns-ticket-topic-arn"
  "sns-seat-topic-arn" "sns-queue-topic-arn"
  "sqs-order-processing-url" "sqs-payment-processing-url"
  "sqs-seat-sync-url" "sqs-ticket-notifications-url"
  "redis-password" "sns-topic-purchase" "sns-topic-seat-hold" "sns-topic-admission"
  "totp-encryption-key"
)

for secret_name in "${SECRETS[@]}"; do
  full_name="${SECRET_PREFIX}/${secret_name}"
  import_if_exists \
    "module.secrets.aws_secretsmanager_secret.secrets[\"${secret_name}\"]" \
    "$full_name" \
    "aws secretsmanager describe-secret --secret-id $full_name --region $REGION"
done

# =============================================================================
# ECS Cluster
# =============================================================================
log "=== ECS Cluster ==="
import_if_exists \
  "module.compute.aws_ecs_cluster.main" \
  "${PREFIX}" \
  "aws ecs describe-clusters --clusters ${PREFIX} --region $REGION --query 'clusters[0].status' --output text | grep -q ACTIVE"

# =============================================================================
# ACM Certificate
# =============================================================================
log "=== ACM Certificate ==="
CERT_ARN=$(aws acm list-certificates \
  --query "CertificateSummaryList[?DomainName=='pickket.kr'].CertificateArn | [0]" \
  --output text --region "$REGION" 2>/dev/null || echo "None")
if [[ "$CERT_ARN" != "None" && "$CERT_ARN" != "" ]]; then
  import_if_exists "module.certificate.aws_acm_certificate.main" "$CERT_ARN"
fi

# =============================================================================
log ""
log "=============================="
log "  Import 완료!"
log "=============================="
log ""
log "다음 단계: terraform plan 으로 drift 확인"
