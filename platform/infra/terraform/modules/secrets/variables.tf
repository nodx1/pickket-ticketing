###############################################################################
# Pickket v2 — Secrets Module Variables
###############################################################################

variable "environment" {
  description = "Deployment environment (prod | stg)"
  type        = string

  validation {
    condition     = contains(["prod", "stg"], var.environment)
    error_message = "environment must be 'prod' or 'stg'."
  }
}
