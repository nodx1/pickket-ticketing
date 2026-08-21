################################################################################
# Compute Module — Outputs
################################################################################

output "cluster_id" {
  description = "ECS cluster ID"
  value       = aws_ecs_cluster.main.id
}

output "cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.main.name
}

output "service_names" {
  description = "Map of service key to ECS service name"
  value = {
    for k, v in aws_ecs_service.services : k => v.name
  }
}
