variable "prefix" {
  description = "Project prefix for resource naming"
  type        = string
  default     = "pickket-v2"
}

variable "environment" {
  description = "Environment name (staging or production)"
  type        = string
  default     = "production"
}

variable "domain_name" {
  description = "Primary domain name for the certificate"
  type        = string
  default     = "pickket.kr"
}
