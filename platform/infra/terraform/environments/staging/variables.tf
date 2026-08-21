###############################################################################
# Pickket v2 — Staging Environment Variables
###############################################################################

variable "environment" {
  description = "Deployment environment identifier"
  type        = string
  default     = "stg"
}
