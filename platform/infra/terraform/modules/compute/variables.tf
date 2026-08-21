################################################################################
# Compute Module — Variables
################################################################################

variable "prefix" {
  description = "Resource name prefix (e.g. pickket-v2)"
  type        = string
}

variable "environment" {
  description = "Deployment environment (e.g. prod, staging)"
  type        = string
}

variable "execution_role_arn" {
  description = "ARN of the ECS task execution IAM role"
  type        = string
}

variable "task_role_arn" {
  description = "ARN of the ECS task IAM role"
  type        = string
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs for ECS service networking"
  type        = list(string)
}

variable "ecs_security_group_id" {
  description = "Security group ID attached to ECS tasks"
  type        = string
}

variable "target_group_arns" {
  description = "Map of service name to ALB target group ARN (only for services with port > 0)"
  type        = map(string)
  default     = {}
}

variable "ecr_images" {
  description = "Map of service name to ECR image URI"
  type        = map(string)
  default = {
    backend        = "PLACEHOLDER"
    consumer       = "PLACEHOLDER"
    studio         = "PLACEHOLDER"
    admin          = "PLACEHOLDER"
    celery-worker  = "PLACEHOLDER"
    celery-beat    = "PLACEHOLDER"
    ticket-gateway = "PLACEHOLDER"
    realtime-hub   = "PLACEHOLDER"
  }
}

variable "scheduled_scaling_actions" {
  description = "Map of scheduled scaling actions for pre-warming before ticket open events"
  type = map(object({
    service_key  = string
    prewarm_at   = string  # UTC ISO 8601: "2026-04-10T04:55:00Z"
    scaledown_at = string  # UTC ISO 8601: "2026-04-10T05:30:00Z"
    prewarm_min  = number
    prewarm_max  = number
    restore_min  = number
    restore_max  = number
  }))
  default = {}
}
