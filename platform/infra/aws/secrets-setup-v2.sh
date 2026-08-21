#!/usr/bin/env bash
# Secrets Manager setup for all phases
set -euo pipefail

REGION="ap-northeast-2"

create_or_update_secret() {
  local name="$1"
  local desc="$2"
  local value="${3:-PLACEHOLDER_REPLACE_ME}"

  if aws secretsmanager describe-secret --secret-id "$name" --region "$REGION" 2>/dev/null; then
    echo "  Updating: $name"
    aws secretsmanager update-secret --secret-id "$name" --description "$desc" --region "$REGION"
  else
    echo "  Creating: $name"
    aws secretsmanager create-secret \
      --name "$name" \
      --description "$desc" \
      --secret-string "$value" \
      --region "$REGION" \
      --tags Key=Project,Value=pickket Key=Environment,Value=production
  fi
}

echo "=== Phase 0: Data Layer Secrets ==="
create_or_update_secret "pickket-prod/database-credentials" "Aurora master credentials (managed by RDS)"
create_or_update_secret "pickket-prod/database-read-url" "Aurora reader endpoint URL"
create_or_update_secret "pickket-prod/redis-cluster-nodes" "Redis cluster configuration endpoint"

echo ""
echo "=== P0: Migrated from plaintext ==="
create_or_update_secret "pickket-prod/s3-access-key" "Cloudflare R2 access key"
create_or_update_secret "pickket-prod/s3-secret-key" "Cloudflare R2 secret key"
create_or_update_secret "pickket-prod/db-password" "Production DB password"
create_or_update_secret "pickket-prod/stg-db-password" "Staging DB password (for migration tasks)"

echo ""
echo "=== Phase 1: External Service Secrets ==="
create_or_update_secret "pickket-prod/portone-api-secret" "PortOne API secret"
create_or_update_secret "pickket-prod/portone-webhook-secret" "PortOne webhook verification secret"
create_or_update_secret "pickket-prod/ncp-sms-secret-key" "NCP SMS secret key"
create_or_update_secret "pickket-prod/sentry-dsn" "Sentry DSN for error tracking"

echo ""
echo "=== Phase 4: Event Bus (SNS/SQS) Secrets ==="
create_or_update_secret "pickket-prod/sns-order-topic-arn" "SNS order events topic ARN"
create_or_update_secret "pickket-prod/sns-payment-topic-arn" "SNS payment events topic ARN"
create_or_update_secret "pickket-prod/sns-ticket-topic-arn" "SNS ticket events topic ARN"
create_or_update_secret "pickket-prod/sns-seat-topic-arn" "SNS seat events topic ARN"
create_or_update_secret "pickket-prod/sns-queue-topic-arn" "SNS queue events topic ARN"
create_or_update_secret "pickket-prod/sqs-order-processing-url" "SQS order processing queue URL"
create_or_update_secret "pickket-prod/sqs-payment-processing-url" "SQS payment processing queue URL"
create_or_update_secret "pickket-prod/sqs-seat-sync-url" "SQS seat sync queue URL"
create_or_update_secret "pickket-prod/sqs-ticket-notifications-url" "SQS ticket notifications queue URL"

echo ""
echo "=== Phase 2: Go Service Secrets ==="
create_or_update_secret "pickket-prod/redis-password" "Redis cluster auth password"
create_or_update_secret "pickket-prod/sns-topic-purchase" "SNS topic ARN for purchase events (Go)"
create_or_update_secret "pickket-prod/sns-topic-seat-hold" "SNS topic ARN for seat hold events (Go)"
create_or_update_secret "pickket-prod/sns-topic-admission" "SNS topic ARN for admission events (Go)"

echo ""
echo "=== Phase 6: TOTP ==="
create_or_update_secret "pickket-prod/totp-encryption-key" "Fernet key for TOTP seed encryption"

echo ""
echo "=== Done. Update placeholder values in AWS Console or via CLI. ==="
echo "Total secrets managed: $(aws secretsmanager list-secrets --region $REGION --query 'length(SecretList)' --output text)"
