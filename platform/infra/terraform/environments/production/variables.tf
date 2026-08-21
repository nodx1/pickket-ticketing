###############################################################################
# Pickket v2 — Production Environment Variables
###############################################################################

variable "environment" {
  description = "Deployment environment identifier"
  type        = string
  default     = "prod"
}
