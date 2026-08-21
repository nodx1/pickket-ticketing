resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.prefix}-redis-subnet"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name        = "${var.prefix}-redis-subnet"
    Environment = var.environment
  }
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${var.prefix}-redis-cluster"
  description          = "Pickket v2 Redis Cluster"

  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.node_type
  port                 = 6379
  parameter_group_name = "default.redis7.cluster.on"

  num_node_groups         = var.num_shards
  replicas_per_node_group = var.replicas_per_shard

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [var.redis_security_group_id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auto_minor_version_upgrade = true
  automatic_failover_enabled = true

  tags = {
    Name        = "${var.prefix}-redis-cluster"
    Environment = var.environment
  }
}
