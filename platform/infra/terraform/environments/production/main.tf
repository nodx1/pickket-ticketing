###############################################################################
# Pickket v2 — Production Environment
###############################################################################

terraform {
  required_version = ">= 1.5"

  backend "s3" {
    bucket         = "pickket-terraform-state"
    key            = "production/terraform.tfstate"
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
      Project     = "pickket-v2"
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}

# ─── Modules ────────────────────────────────────────────────────────────────

module "iam" {
  source      = "../../modules/iam"
  environment = var.environment
}

module "networking" {
  source      = "../../modules/networking"
  environment = var.environment
}

module "certificate" {
  source      = "../../modules/certificate"
  environment = var.environment
}

module "secrets" {
  source      = "../../modules/secrets"
  environment = var.environment
}

module "database" {
  source = "../../modules/database"

  environment            = var.environment
  private_subnet_ids     = module.networking.private_subnet_ids
  rds_security_group_id  = module.networking.security_group_ids["rds"]
  rds_proxy_role_arn     = module.iam.rds_proxy_role_arn
  db_credentials_secret_arn = module.secrets.secret_arns["database-credentials"]
  aurora_min_capacity    = 0.5
  aurora_max_capacity    = 64
}

module "cache" {
  source = "../../modules/cache"

  environment          = var.environment
  private_subnet_ids   = module.networking.private_subnet_ids
  redis_security_group_id = module.networking.security_group_ids["redis"]
  node_type            = "cache.r7g.small"
  num_shards           = 3
  replicas_per_shard   = 1
}

module "messaging" {
  source      = "../../modules/messaging"
  environment = var.environment
}

module "loadbalancer" {
  source = "../../modules/loadbalancer"

  prefix               = "pickket-v2"
  environment          = var.environment
  vpc_id               = module.networking.vpc_id
  public_subnet_ids    = module.networking.public_subnet_ids
  alb_security_group_id = module.networking.security_group_ids["alb"]
  certificate_arn      = module.certificate.certificate_arn
}

module "compute" {
  source = "../../modules/compute"

  prefix               = "pickket-v2"
  environment          = var.environment
  execution_role_arn   = module.iam.ecs_execution_role_arn
  task_role_arn        = module.iam.ecs_task_role_arn
  private_subnet_ids   = module.networking.private_subnet_ids
  ecs_security_group_id = module.networking.security_group_ids["ecs"]
  target_group_arns = merge(
    module.loadbalancer.target_group_arns,
    {
      ticket-gateway = module.loadbalancer.target_group_arns["ticket-gw"]
      realtime-hub   = module.loadbalancer.target_group_arns["realtime-hub"]
    }
  )
}

module "monitoring" {
  source = "../../modules/monitoring"

  prefix                    = "pickket-v2"
  environment               = var.environment
  alb_arn_suffix            = replace(module.loadbalancer.alb_arn, "/.*:loadbalancer\\//", "")
  db_cluster_id             = module.database.cluster_id
  redis_replication_group_id = module.cache.replication_group_id
  ecs_cluster_name          = module.compute.cluster_name
  ecs_service_names         = ["ticket-gateway", "backend", "celery-worker"]
}

# ─── Autoscaling ─────────────────────────────────────────────────────────────

locals {
  autoscaling_services = {
    backend        = { min = 1, max = 6, cpu_target = 60 }
    ticket-gateway = { min = 1, max = 8, cpu_target = 60 }
    realtime-hub   = { min = 1, max = 4, cpu_target = 60 }
    consumer       = { min = 1, max = 4, cpu_target = 60 }
    celery-worker  = { min = 1, max = 4, cpu_target = 70 }
  }
}

resource "aws_appautoscaling_target" "ecs" {
  for_each           = local.autoscaling_services
  service_namespace  = "ecs"
  resource_id        = "service/pickket/prod-${each.key}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = each.value.min
  max_capacity       = each.value.max
}

resource "aws_appautoscaling_policy" "ecs_cpu" {
  for_each           = local.autoscaling_services
  name               = "prod-${each.key}-cpu-tracking"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.ecs[each.key].resource_id
  scalable_dimension = "ecs:service:DesiredCount"
  policy_type        = "TargetTrackingScaling"

  target_tracking_scaling_policy_configuration {
    target_value       = each.value.cpu_target
    scale_out_cooldown = 120
    scale_in_cooldown  = 300

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
