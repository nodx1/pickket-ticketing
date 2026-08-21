###############################################################################
# Pickket v2 — Secrets Manager Module
# Creates secret shells (no values) grouped by deployment phase.
###############################################################################

locals {
  prefix = "pickket-${var.environment}"

  # ── Phase 0: Data Layer ──────────────────────────────────────────────────
  phase0_secrets = {
    "database-credentials" = "RDS master credentials (JSON: host, port, username, password, dbname)"
    "database-read-url"    = "Read-replica connection string"
    "redis-cluster-nodes"  = "ElastiCache cluster node endpoints (comma-separated)"
    "s3-access-key"        = "S3 IAM access key ID for media uploads"
    "s3-secret-key"        = "S3 IAM secret access key for media uploads"
    "db-password"          = "RDS master password (plain text)"
  }

  # ── Phase 1: External Services & Derived URLs ───────────────────────────
  phase1_secrets = {
    "portone-api-secret"     = "PortOne (PG) API secret key"
    "portone-webhook-secret" = "PortOne webhook verification secret"
    "ncp-sms-secret-key"     = "NCP SMS (SENS) secret key"
    "sentry-dsn"             = "Sentry DSN for error tracking"
    "secret-key"             = "Application SECRET_KEY (JWT signing, CSRF)"
    "database-url"           = "Async database URL (postgresql+asyncpg://...)"
    "database-url-sync"      = "Sync database URL (postgresql+psycopg2://...)"
    "redis-url"              = "Redis connection URL (redis://...)"
    "celery-broker-url"      = "Celery broker URL (redis://...)"
    "celery-result-backend"  = "Celery result backend URL (redis://...)"
  }

  # ── Phase 2: Go Services ────────────────────────────────────────────────
  phase2_secrets = {
    "redis-password"       = "Redis AUTH password for Go micro-services"
    "sns-topic-purchase"   = "SNS topic ARN — purchase events (Go publisher)"
    "sns-topic-seat-hold"  = "SNS topic ARN — seat-hold events (Go publisher)"
    "sns-topic-admission"  = "SNS topic ARN — admission events (Go publisher)"
  }

  # ── Phase 4: EDA (SNS / SQS) ───────────────────────────────────────────
  phase4_secrets = {
    "sns-order-topic-arn"          = "SNS topic ARN — order domain events"
    "sns-payment-topic-arn"        = "SNS topic ARN — payment domain events"
    "sns-ticket-topic-arn"         = "SNS topic ARN — ticket domain events"
    "sns-seat-topic-arn"           = "SNS topic ARN — seat domain events"
    "sns-queue-topic-arn"          = "SNS topic ARN — queue domain events"
    "sqs-order-processing-url"     = "SQS queue URL — order processing"
    "sqs-payment-processing-url"   = "SQS queue URL — payment processing"
    "sqs-seat-sync-url"            = "SQS queue URL — seat sync"
    "sqs-ticket-notifications-url" = "SQS queue URL — ticket notifications"
  }

  # ── Phase 6: TOTP ──────────────────────────────────────────────────────
  phase6_secrets = {
    "totp-encryption-key" = "AES-256 key for TOTP secret encryption at rest"
  }

  # ── Merged map (single for_each) ────────────────────────────────────────
  all_secrets = merge(
    local.phase0_secrets,
    local.phase1_secrets,
    local.phase2_secrets,
    local.phase4_secrets,
    local.phase6_secrets,
  )
}

resource "aws_secretsmanager_secret" "this" {
  for_each = local.all_secrets

  name        = "${local.prefix}/${each.key}"
  description = each.value

  tags = {
    Phase = (
      contains(keys(local.phase0_secrets), each.key) ? "0-data-layer" :
      contains(keys(local.phase1_secrets), each.key) ? "1-external-services" :
      contains(keys(local.phase2_secrets), each.key) ? "2-go-services" :
      contains(keys(local.phase4_secrets), each.key) ? "4-eda" :
      "6-totp"
    )
  }
}
