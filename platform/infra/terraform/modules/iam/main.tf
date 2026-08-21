###############################################################################
# IAM Roles for Pickket v2 ECS + RDS Proxy
###############################################################################

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
  tags = {
    Project = var.prefix
  }
}

# =============================================================================
# 1. ECS Execution Role
#    Used by ECS agent to pull images, push logs, read secrets
# =============================================================================

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_execution" {
  name               = "${var.prefix}-ecs-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "secrets_access" {
  statement {
    sid    = "SecretsAccess"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
    ]
    resources = [
      "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:pickket-prod/*",
      "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:pickket-stg/*",
    ]
  }
}

resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name   = "secrets-access"
  role   = aws_iam_role.ecs_execution.id
  policy = data.aws_iam_policy_document.secrets_access.json
}

data "aws_iam_policy_document" "ecr_logs" {
  statement {
    sid    = "ECRLogs"
    effect = "Allow"
    actions = [
      "ecr:GetAuthorizationToken",
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:CreateLogGroup",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ecs_execution_ecr_logs" {
  name   = "ecr-logs"
  role   = aws_iam_role.ecs_execution.id
  policy = data.aws_iam_policy_document.ecr_logs.json
}

# =============================================================================
# 2. ECS Task Role
#    Assumed by running containers for AWS service access
# =============================================================================

resource "aws_iam_role" "ecs_task" {
  name               = "${var.prefix}-ecs-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "sns_sqs" {
  statement {
    sid    = "SNSPublish"
    effect = "Allow"
    actions = [
      "sns:Publish",
    ]
    resources = [
      "arn:aws:sns:${local.region}:${local.account_id}:pickket-*",
    ]
  }

  statement {
    sid    = "SQSAccess"
    effect = "Allow"
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [
      "arn:aws:sqs:${local.region}:${local.account_id}:pickket-*",
    ]
  }
}

resource "aws_iam_role_policy" "ecs_task_sns_sqs" {
  name   = "sns-sqs"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.sns_sqs.json
}

data "aws_iam_policy_document" "s3_upload" {
  statement {
    sid    = "S3Upload"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
    ]
    resources = [
      "arn:aws:s3:::pickket-uploads/*",
    ]
  }
}

resource "aws_iam_role_policy" "ecs_task_s3_upload" {
  name   = "s3-upload"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.s3_upload.json
}

data "aws_iam_policy_document" "xray" {
  statement {
    sid    = "XRayAccess"
    effect = "Allow"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ecs_task_xray" {
  name   = "xray"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.xray.json
}

# =============================================================================
# 3. RDS Proxy Role
#    Used by RDS Proxy to read database credentials from Secrets Manager
# =============================================================================

data "aws_iam_policy_document" "rds_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_proxy" {
  name               = "${var.prefix}-rds-proxy-role"
  assume_role_policy = data.aws_iam_policy_document.rds_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "secrets_read" {
  statement {
    sid    = "SecretsRead"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
    ]
    resources = [
      "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:pickket-prod/database-*",
    ]
  }
}

resource "aws_iam_role_policy" "rds_proxy_secrets_read" {
  name   = "secrets-read"
  role   = aws_iam_role.rds_proxy.id
  policy = data.aws_iam_policy_document.secrets_read.json
}
