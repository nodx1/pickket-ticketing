################################################################################
# Database Module — Variables
################################################################################

variable "prefix" {
  description = "Resource name prefix"
  type        = string
  default     = "pickket-v2"
}

variable "environment" {
  description = "Deployment environment (staging / production)"
  type        = string
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs for DB and proxy placement"
  type        = list(string)
}

variable "rds_security_group_id" {
  description = "Security group ID for Aurora cluster and RDS Proxy"
  type        = string
}

variable "rds_proxy_role_arn" {
  description = "IAM role ARN for RDS Proxy to read Secrets Manager"
  type        = string
}

variable "db_credentials_secret_arn" {
  description = "Secrets Manager secret ARN containing DB credentials"
  type        = string
}

variable "aurora_min_capacity" {
  description = "Aurora Serverless v2 minimum ACU"
  type        = number
  default     = 0.5
}

variable "aurora_max_capacity" {
  description = "Aurora Serverless v2 maximum ACU"
  type        = number
  default     = 64
}
