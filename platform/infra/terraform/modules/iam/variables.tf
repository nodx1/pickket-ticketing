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
