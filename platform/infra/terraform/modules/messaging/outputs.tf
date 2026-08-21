output "topic_arns" {
  description = "Map of SNS topic key to ARN"
  value       = { for k, v in aws_sns_topic.this : k => v.arn }
}

output "queue_urls" {
  description = "Map of SQS queue key to URL"
  value       = { for k, v in aws_sqs_queue.main : k => v.id }
}

output "queue_arns" {
  description = "Map of SQS queue key to ARN"
  value       = { for k, v in aws_sqs_queue.main : k => v.arn }
}

output "dlq_arns" {
  description = "Map of DLQ key to ARN"
  value       = { for k, v in aws_sqs_queue.dlq : k => v.arn }
}
