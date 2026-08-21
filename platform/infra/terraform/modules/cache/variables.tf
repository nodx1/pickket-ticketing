variable "prefix" {
  description = "Resource name prefix"
  type        = string
  default     = "pickket-v2"
}

variable "environment" {
  description = "Deployment environment (e.g. production, staging)"
  type        = string
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs for the Redis subnet group"
  type        = list(string)
}

variable "redis_security_group_id" {
  description = "Security group ID to attach to the Redis cluster"
  type        = string
}

variable "node_type" {
  description = "ElastiCache node instance type"
  type        = string
  default     = "cache.r7g.small"
}

variable "num_shards" {
  description = "Number of node groups (shards) in the cluster"
  type        = number
  default     = 3
}

variable "replicas_per_shard" {
  description = "Number of replica nodes per shard"
  type        = number
  default     = 1
}
