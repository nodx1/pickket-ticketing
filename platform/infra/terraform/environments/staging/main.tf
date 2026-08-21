###############################################################################
# Pickket — Staging Environment
#
# 전략: 기존 리소스는 data source로 참조, 신규 리소스만 Terraform 관리
# - 기존: VPC, Subnets, SGs, ALB, TGs, ECS cluster, ECS services, IAM, ACM, Secrets
# - 신규: Aurora, RDS Proxy, SNS/SQS, CloudWatch Alarms, Go service task-defs
###############################################################################

terraform {
  required_version = ">= 1.5"

  backend "s3" {
    bucket         = "pickket-terraform-state"
    key            = "staging/terraform.tfstate"
    region         = "ap-northeast-2"
    dynamodb_table = "pickket-terraform-locks"
    encrypt        = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "ap-northeast-2"

  default_tags {
    tags = {
      Project     = "pickket"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

# ─── Data Sources: 기존 인프라 참조 ─────────────────────────────────────────

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# VPC
data "aws_vpc" "staging" {
  id = "vpc-0fa14282af91859ef"
}

# Subnets
data "aws_subnet" "pub_a" {
  id = "subnet-05805d69d59ef95dc"
}
data "aws_subnet" "pub_c" {
  id = "subnet-04137bf2662ea4b65"
}
data "aws_subnet" "priv_a" {
  id = "subnet-01d24a1a5a16107b2"
}
data "aws_subnet" "priv_c" {
  id = "subnet-0a9550b966fa2b0f8"
}

locals {
  vpc_id             = data.aws_vpc.staging.id
  public_subnet_ids  = [data.aws_subnet.pub_a.id, data.aws_subnet.pub_c.id]
  private_subnet_ids = [data.aws_subnet.priv_a.id, data.aws_subnet.priv_c.id]
  prefix             = "pickket-stg"
  account_id         = data.aws_caller_identity.current.account_id
  region             = data.aws_region.current.name
}

# Security Groups
data "aws_security_group" "alb" {
  id = "sg-05ba750eb004f136c"
}
data "aws_security_group" "ecs" {
  id = "sg-01161490251f2047d"
}
data "aws_security_group" "rds" {
  id = "sg-0175ce1746ea8c64a"
}
data "aws_security_group" "redis" {
  id = "sg-08b82cda46789b3fa"
}

# IAM Roles (기존)
data "aws_iam_role" "ecs_execution" {
  name = "pickket-ecs-execution-role"
}
data "aws_iam_role" "ecs_task" {
  name = "pickket-ecs-task-role"
}

# ACM Certificate (기존)
data "aws_acm_certificate" "main" {
  domain   = "pickket.kr"
  statuses = ["ISSUED"]
}

# ECS Cluster (기존)
data "aws_ecs_cluster" "staging" {
  cluster_name = "pickket-stg"
}

# ALB (기존)
data "aws_lb" "staging" {
  name = "pickket-stg-alb"
}

# ─── 신규 리소스: RDS Proxy IAM Role ────────────────────────────────────────

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
  name               = "pickket-rds-proxy-role"
  assume_role_policy = data.aws_iam_policy_document.rds_assume.json
}

data "aws_iam_policy_document" "rds_proxy_secrets" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [
      "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:pickket-stg/database-*",
      "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:pickket-prod/database-*",
    ]
  }
}

resource "aws_iam_role_policy" "rds_proxy_secrets" {
  name   = "secrets-read"
  role   = aws_iam_role.rds_proxy.id
  policy = data.aws_iam_policy_document.rds_proxy_secrets.json
}

# ─── 신규: Messaging (SNS + SQS) ────────────────────────────────────────────

module "messaging" {
  source      = "../../modules/messaging"
  prefix      = local.prefix
  environment = "staging"
}

# ─── 신규: CloudWatch Monitoring ─────────────────────────────────────────────
# 참고: Aurora/Redis Cluster 생성 후 monitoring 모듈 활성화
# 현재는 ALB + ECS 알람만 가능 (DB/Redis는 기존 standalone이므로 다른 차원)

resource "aws_sns_topic" "ops_alerts" {
  name = "${local.prefix}-ops-alerts"
}

# ALB 5xx alarm
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.prefix}-alb-5xx-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_ELB_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = 50
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops_alerts.arn]

  dimensions = {
    LoadBalancer = "app/pickket-stg-alb/083a4aaf61d1bc12"
  }
}

# ECS CPU alarms for key services
resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  for_each = toset(["backend", "consumer", "studio"])

  alarm_name          = "${local.prefix}-${each.key}-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops_alerts.arn]

  dimensions = {
    ClusterName = "pickket-stg"
    ServiceName = each.key
  }
}

# ─── 신규: database-credentials Secret (Aurora용) ────────────────────────────

resource "aws_secretsmanager_secret" "db_credentials" {
  name        = "pickket-stg/database-credentials"
  description = "Aurora Serverless v2 DB credentials for staging"
}

resource "aws_secretsmanager_secret_version" "db_credentials" {
  secret_id = aws_secretsmanager_secret.db_credentials.id
  secret_string = jsonencode({
    username = "pickket_admin"
    password = "CHANGE_ME_AFTER_AURORA_CREATION"
    engine   = "postgres"
    host     = "pending-aurora-creation"
    port     = 5432
    dbname   = "pickket"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ─── 신규: Aurora Serverless v2 + RDS Proxy ──────────────────────────────────

resource "aws_db_subnet_group" "aurora" {
  name       = "${local.prefix}-aurora-subnet"
  subnet_ids = local.private_subnet_ids

  tags = {
    Name = "${local.prefix}-aurora-subnet"
  }
}

resource "aws_rds_cluster" "aurora" {
  cluster_identifier = "${local.prefix}-aurora"
  engine             = "aurora-postgresql"
  engine_version     = "16.4"
  engine_mode        = "provisioned"

  master_username             = "pickket_admin"
  manage_master_user_password = true

  serverlessv2_scaling_configuration {
    min_capacity = 0.5
    max_capacity = 8
  }

  vpc_security_group_ids = [data.aws_security_group.rds.id]
  db_subnet_group_name   = aws_db_subnet_group.aurora.name

  storage_encrypted       = true
  # 2026-04-21 프로덕션 감사 Phase 5: PIPA/금융 준수 30일로 상향 (기존 7일)
  backup_retention_period = 30
  skip_final_snapshot     = true

  tags = {
    Name        = "${local.prefix}-aurora"
    Environment = "staging"
  }
}

resource "aws_rds_cluster_instance" "writer" {
  identifier         = "${local.prefix}-aurora-writer"
  cluster_identifier = aws_rds_cluster.aurora.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.aurora.engine
  engine_version     = aws_rds_cluster.aurora.engine_version

  tags = {
    Name = "${local.prefix}-aurora-writer"
  }
}

resource "aws_rds_cluster_instance" "reader" {
  identifier         = "${local.prefix}-aurora-reader"
  cluster_identifier = aws_rds_cluster.aurora.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.aurora.engine
  engine_version     = aws_rds_cluster.aurora.engine_version
  promotion_tier     = 1

  tags = {
    Name = "${local.prefix}-aurora-reader"
  }
}

resource "aws_db_proxy" "main" {
  name          = "${local.prefix}-db-proxy"
  engine_family = "POSTGRESQL"
  role_arn      = aws_iam_role.rds_proxy.arn
  require_tls   = true

  vpc_subnet_ids         = local.private_subnet_ids
  vpc_security_group_ids = [data.aws_security_group.rds.id]

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_secretsmanager_secret.db_credentials.arn
  }

  tags = {
    Name        = "${local.prefix}-db-proxy"
    Environment = "staging"
  }

  depends_on = [aws_rds_cluster_instance.writer]
}

resource "aws_db_proxy_default_target_group" "main" {
  db_proxy_name = aws_db_proxy.main.name

  connection_pool_config {
    max_connections_percent      = 100
    max_idle_connections_percent = 50
  }
}

resource "aws_db_proxy_target" "main" {
  db_proxy_name         = aws_db_proxy.main.name
  target_group_name     = aws_db_proxy_default_target_group.main.name
  db_cluster_identifier = aws_rds_cluster.aurora.id
}

# ─── Outputs ─────────────────────────────────────────────────────────────────

output "aurora_cluster_endpoint" {
  value = aws_rds_cluster.aurora.endpoint
}

output "aurora_reader_endpoint" {
  value = aws_rds_cluster.aurora.reader_endpoint
}

output "rds_proxy_endpoint" {
  value = aws_db_proxy.main.endpoint
}

output "sns_topic_arns" {
  value = module.messaging.topic_arns
}

output "sqs_queue_urls" {
  value = module.messaging.queue_urls
}

output "ops_alerts_topic_arn" {
  value = aws_sns_topic.ops_alerts.arn
}

# ─── ECS Auto Scaling ──────────────────────────────────────────────────────

locals {
  autoscaling_services = {
    backend         = { min = 1, max = 6, cpu_target = 60 }
    ticket-gateway  = { min = 1, max = 8, cpu_target = 60 }
    realtime-hub    = { min = 1, max = 4, cpu_target = 60 }
    consumer        = { min = 1, max = 4, cpu_target = 60 }
    celery-worker   = { min = 1, max = 4, cpu_target = 70 }
  }
}

resource "aws_appautoscaling_target" "ecs" {
  for_each           = local.autoscaling_services
  max_capacity       = each.value.max
  min_capacity       = each.value.min
  resource_id        = "service/${local.prefix}/${each.key}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "ecs_cpu" {
  for_each           = local.autoscaling_services
  name               = "${each.key}-cpu-tracking"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[each.key].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[each.key].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = each.value.cpu_target
    scale_out_cooldown = 60
    scale_in_cooldown  = 300

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
