output "configuration_endpoint" {
  description = "Configuration endpoint for the Redis cluster"
  value       = aws_elasticache_replication_group.main.configuration_endpoint_address
}

output "replication_group_id" {
  description = "ID of the ElastiCache replication group"
  value       = aws_elasticache_replication_group.main.replication_group_id
}
