################################################################################
# Compute Module — ECS Cluster, Services, Task Definitions, Auto-Scaling
################################################################################

locals {
  services = {
    backend        = { cpu = 1024, memory = 2048, port = 8000, min = 2, max = 20, cpu_target = 60 }
    consumer       = { cpu = 512, memory = 1024, port = 3000, min = 2, max = 10, cpu_target = 60 }
    studio         = { cpu = 512, memory = 1024, port = 3000, min = 1, max = 4, cpu_target = 60 }
    admin          = { cpu = 256, memory = 512, port = 3000, min = 1, max = 2, cpu_target = 60 }
    celery-worker  = { cpu = 512, memory = 1024, port = 0, min = 1, max = 8, cpu_target = 70 }
    celery-beat    = { cpu = 256, memory = 512, port = 0, min = 1, max = 1, cpu_target = 60 }
    ticket-gateway = { cpu = 512, memory = 1024, port = 8030, min = 2, max = 30, cpu_target = 60 }
    realtime-hub   = { cpu = 512, memory = 1024, port = 8031, min = 1, max = 10, cpu_target = 60 }
  }

  # Services that need auto-scaling (exclude celery-beat since max=1)
  scalable_services = {
    for k, v in local.services : k => v if v.max > 1
  }
}

# ------------------------------------------------------------------------------
# ECS Cluster
# ------------------------------------------------------------------------------

resource "aws_ecs_cluster" "main" {
  name = var.prefix

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# ------------------------------------------------------------------------------
# CloudWatch Log Groups
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "services" {
  for_each = local.services

  name              = "/ecs/${var.prefix}/${each.key}"
  retention_in_days = 30
}

# ------------------------------------------------------------------------------
# ECS Task Definitions
# ------------------------------------------------------------------------------

resource "aws_ecs_task_definition" "services" {
  for_each = local.services

  family                   = "${var.prefix}-${var.environment}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  container_definitions = jsonencode([
    {
      name      = each.key
      image     = var.ecr_images[each.key]
      essential = true

      portMappings = each.value.port > 0 ? [
        {
          containerPort = each.value.port
          protocol      = "tcp"
        }
      ] : []

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.services[each.key].name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])
}

data "aws_region" "current" {}

# ------------------------------------------------------------------------------
# ECS Services
# ------------------------------------------------------------------------------

resource "aws_ecs_service" "services" {
  for_each = local.services

  cluster         = aws_ecs_cluster.main.id
  name            = "${var.prefix}-${var.environment}-${each.key}"
  task_definition = aws_ecs_task_definition.services[each.key].arn
  desired_count   = each.value.min
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_security_group_id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = each.value.port > 0 && contains(keys(var.target_group_arns), each.key) ? [1] : []
    content {
      target_group_arn = var.target_group_arns[each.key]
      container_name   = each.key
      container_port   = each.value.port
    }
  }

  # 120s grace period lets FastAPI finish DB+Redis warm-up before ALB marks
  # the task unhealthy (DR drill 2026-04-04 observed 33/33 health check failures
  # during rolling deploys because the default grace=0 raced the cold start).
  health_check_grace_period_seconds = (each.value.port > 0 && contains(keys(var.target_group_arns), each.key)) ? 120 : null

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}

# ------------------------------------------------------------------------------
# Auto-Scaling — Target & CPU Tracking Policy
# ------------------------------------------------------------------------------

resource "aws_appautoscaling_target" "services" {
  for_each = local.scalable_services

  max_capacity       = each.value.max
  min_capacity       = each.value.min
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.services[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu_tracking" {
  for_each = local.scalable_services

  name               = "${var.prefix}-${each.key}-cpu-tracking"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.services[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.services[each.key].scalable_dimension
  service_namespace  = aws_appautoscaling_target.services[each.key].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value = each.value.cpu_target
  }
}

# ------------------------------------------------------------------------------
# Scheduled Scaling — Pre-warm before ticket open events
# ------------------------------------------------------------------------------
# Usage: pass scheduled_scaling_actions from root module, e.g.:
#   scheduled_scaling_actions = {
#     "evt_abc123-backend" = {
#       service_key  = "backend"
#       prewarm_at   = "2026-04-10T04:55:00Z"   # UTC (5min before open)
#       scaledown_at = "2026-04-10T05:30:00Z"    # UTC (30min after open)
#       prewarm_min  = 20
#       prewarm_max  = 20
#       restore_min  = 2      # original min
#       restore_max  = 20     # original max
#     }
#   }

resource "aws_appautoscaling_scheduled_action" "prewarm" {
  for_each = var.scheduled_scaling_actions

  name               = "prewarm-${each.key}"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.services[each.value.service_key].resource_id
  scalable_dimension = "ecs:service:DesiredCount"
  schedule           = "at(${replace(each.value.prewarm_at, "Z", "")})"

  scalable_target_action {
    min_capacity = each.value.prewarm_min
    max_capacity = each.value.prewarm_max
  }
}

resource "aws_appautoscaling_scheduled_action" "scaledown" {
  for_each = var.scheduled_scaling_actions

  name               = "scaledown-${each.key}"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.services[each.value.service_key].resource_id
  scalable_dimension = "ecs:service:DesiredCount"
  schedule           = "at(${replace(each.value.scaledown_at, "Z", "")})"

  scalable_target_action {
    min_capacity = each.value.restore_min
    max_capacity = each.value.restore_max
  }
}
