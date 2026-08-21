################################################################################
# Pickket v2 — Monitoring Module Variables
################################################################################

variable "prefix" {
  description = "Resource name prefix (e.g. pickket-v2)"
  type        = string
}

variable "environment" {
  description = "Deployment environment (e.g. production, staging)"
  type        = string
}

variable "alb_arn_suffix" {
  description = "ALB ARN suffix for CloudWatch dimensions (app/lb-name/id)"
  type        = string
}

variable "db_cluster_id" {
  description = "Aurora DB cluster identifier"
  type        = string
}

variable "redis_replication_group_id" {
  description = "ElastiCache Redis replication group ID"
  type        = string
}

variable "ecs_cluster_name" {
  description = "ECS cluster name for service CPU alarms"
  type        = string
}

variable "ecs_service_names" {
  description = "List of ECS service names to monitor"
  type        = list(string)
  default     = ["ticket-gateway", "backend", "celery-worker"]
}
