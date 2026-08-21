output "ecs_execution_role_arn" {
  description = "ARN of the ECS execution role"
  value       = aws_iam_role.ecs_execution.arn
}

output "ecs_task_role_arn" {
  description = "ARN of the ECS task role"
  value       = aws_iam_role.ecs_task.arn
}

output "rds_proxy_role_arn" {
  description = "ARN of the RDS Proxy role"
  value       = aws_iam_role.rds_proxy.arn
}
