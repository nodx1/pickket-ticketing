variable "prefix" {
  description = "Resource name prefix"
  type        = string
  default     = "pickket-v2"
}

variable "environment" {
  description = "Deployment environment (e.g. dev, staging, prod)"
  type        = string
}
