################################################################################
# Pickket v2 — Monitoring Module
# Converted from cloudwatch-alarms-v2.sh
################################################################################

# ------------------------------------------------------------------------------
# SNS Topic
# ------------------------------------------------------------------------------
resource "aws_sns_topic" "ops_alerts" {
  name = "pickket-ops-alerts"

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ------------------------------------------------------------------------------
# ALB Alarms
# ------------------------------------------------------------------------------
locals {
  alb_alarms = {
    "p99-latency" = {
      metric     = "TargetResponseTime"
      threshold  = 2
      stat       = "p99"
      period     = 60
      eval       = 3
      comparison = "GreaterThanThreshold"
    }
    "5xx-rate" = {
      metric     = "HTTPCode_Target_5XX_Count"
      threshold  = 50
      stat       = "Sum"
      period     = 60
      eval       = 2
      comparison = "GreaterThanThreshold"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "alb" {
  for_each = local.alb_alarms

  alarm_name          = "${var.prefix}-alb-${each.key}"
  alarm_description   = "ALB alarm: ${each.key} (${each.value.metric} ${each.value.comparison} ${each.value.threshold})"
  namespace           = "AWS/ApplicationELB"
  metric_name         = each.value.metric
  statistic           = each.value.stat != "p99" ? each.value.stat : null
  extended_statistic  = each.value.stat == "p99" ? "p99" : null
  threshold           = each.value.threshold
  comparison_operator = each.value.comparison
  evaluation_periods  = each.value.eval
  period              = each.value.period
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
  }

  alarm_actions = [aws_sns_topic.ops_alerts.arn]
  ok_actions    = [aws_sns_topic.ops_alerts.arn]

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ------------------------------------------------------------------------------
# Database (Aurora Serverless) Alarms
# ------------------------------------------------------------------------------
locals {
  db_alarms = {
    "db-connections" = {
      metric    = "DatabaseConnections"
      threshold = 160
      stat      = "Average"
      period    = 300
      eval      = 2
    }
    "db-acu-high" = {
      metric    = "ServerlessDatabaseCapacity"
      threshold = 56
      stat      = "Average"
      period    = 300
      eval      = 1
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "db" {
  for_each = local.db_alarms

  alarm_name          = "${var.prefix}-${each.key}"
  alarm_description   = "Database alarm: ${each.key} (${each.value.metric} > ${each.value.threshold})"
  namespace           = "AWS/RDS"
  metric_name         = each.value.metric
  statistic           = each.value.stat
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = each.value.eval
  period              = each.value.period
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBClusterIdentifier = var.db_cluster_id
  }

  alarm_actions = [aws_sns_topic.ops_alerts.arn]
  ok_actions    = [aws_sns_topic.ops_alerts.arn]

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ------------------------------------------------------------------------------
# Redis Memory Alarm
# ------------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "redis_memory" {
  alarm_name          = "${var.prefix}-redis-memory-high"
  alarm_description   = "Redis memory usage > 80%"
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseMemoryUsagePercentage"
  statistic           = "Average"
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  period              = 300
  treat_missing_data  = "notBreaching"

  dimensions = {
    ReplicationGroupId = var.redis_replication_group_id
  }

  alarm_actions = [aws_sns_topic.ops_alerts.arn]
  ok_actions    = [aws_sns_topic.ops_alerts.arn]

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ------------------------------------------------------------------------------
# SQS Dead-Letter Queue Alarms
# ------------------------------------------------------------------------------
locals {
  dlq_queues = toset([
    "order-processing",
    "payment-processing",
    "seat-sync",
    "ticket-notifications",
  ])
}

resource "aws_cloudwatch_metric_alarm" "sqs_dlq" {
  for_each = local.dlq_queues

  alarm_name          = "${var.prefix}-dlq-${each.key}"
  alarm_description   = "DLQ ${each.key}: messages visible > 5"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Sum"
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  period              = 300
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = "${var.prefix}-${each.key}-dlq"
  }

  alarm_actions = [aws_sns_topic.ops_alerts.arn]
  ok_actions    = [aws_sns_topic.ops_alerts.arn]

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ------------------------------------------------------------------------------
# ECS CPU Utilization Alarms
# ------------------------------------------------------------------------------
locals {
  ecs_services = toset([
    "ticket-gateway",
    "backend",
    "celery-worker",
  ])
}

resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  for_each = local.ecs_services

  alarm_name          = "${var.prefix}-ecs-cpu-${each.key}"
  alarm_description   = "ECS ${each.key} CPU > 90%"
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  threshold           = 90
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  period              = 60
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = "${var.prefix}-${each.key}"
  }

  alarm_actions = [aws_sns_topic.ops_alerts.arn]
  ok_actions    = [aws_sns_topic.ops_alerts.arn]

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}
