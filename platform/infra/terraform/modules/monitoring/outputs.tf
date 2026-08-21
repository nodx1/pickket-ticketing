################################################################################
# Pickket v2 — Monitoring Module Outputs
################################################################################

output "ops_alerts_topic_arn" {
  description = "ARN of the ops alerts SNS topic"
  value       = aws_sns_topic.ops_alerts.arn
}
