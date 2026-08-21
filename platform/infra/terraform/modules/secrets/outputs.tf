###############################################################################
# Pickket v2 — Secrets Module Outputs
###############################################################################

output "secret_arns" {
  description = "Map of secret short name → ARN"
  value       = { for k, v in aws_secretsmanager_secret.this : k => v.arn }
}

output "secret_names" {
  description = "Map of secret short name → full Secrets Manager name"
  value       = { for k, v in aws_secretsmanager_secret.this : k => v.name }
}

output "phase0_arns" {
  description = "ARNs for Phase 0 (Data Layer) secrets"
  value = {
    for k, v in aws_secretsmanager_secret.this : k => v.arn
    if contains(keys(local.phase0_secrets), k)
  }
}

output "phase1_arns" {
  description = "ARNs for Phase 1 (External Services) secrets"
  value = {
    for k, v in aws_secretsmanager_secret.this : k => v.arn
    if contains(keys(local.phase1_secrets), k)
  }
}

output "phase2_arns" {
  description = "ARNs for Phase 2 (Go Services) secrets"
  value = {
    for k, v in aws_secretsmanager_secret.this : k => v.arn
    if contains(keys(local.phase2_secrets), k)
  }
}

output "phase4_arns" {
  description = "ARNs for Phase 4 (EDA) secrets"
  value = {
    for k, v in aws_secretsmanager_secret.this : k => v.arn
    if contains(keys(local.phase4_secrets), k)
  }
}

output "phase6_arns" {
  description = "ARNs for Phase 6 (TOTP) secrets"
  value = {
    for k, v in aws_secretsmanager_secret.this : k => v.arn
    if contains(keys(local.phase6_secrets), k)
  }
}
