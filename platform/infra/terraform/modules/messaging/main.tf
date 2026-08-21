locals {
  topics = {
    "order-events"   = {}
    "payment-events" = {}
    "ticket-events"  = {}
    "seat-events"    = {}
    "queue-events"   = {}
  }

  queues = {
    "order-processing" = {
      visibility = 30
      topic      = "order-events"
    }
    "payment-processing" = {
      visibility = 60
      topic      = "payment-events"
    }
    "seat-sync" = {
      visibility = 30
      topic      = "seat-events"
    }
    "ticket-notifications" = {
      visibility = 30
      topic      = "ticket-events"
    }
  }
}

# --- SNS Topics ---

resource "aws_sns_topic" "this" {
  for_each = local.topics

  name = "${var.prefix}-${each.key}"

  tags = {
    Environment = var.environment
    Module      = "messaging"
  }
}

# --- SQS Dead-Letter Queues ---

resource "aws_sqs_queue" "dlq" {
  for_each = local.queues

  name                       = "${var.prefix}-${each.key}-dlq"
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 3600

  tags = {
    Environment = var.environment
    Module      = "messaging"
    Role        = "dlq"
  }
}

# --- SQS Main Queues ---

resource "aws_sqs_queue" "main" {
  for_each = local.queues

  name                       = "${var.prefix}-${each.key}"
  visibility_timeout_seconds = each.value.visibility
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = 3
  })

  tags = {
    Environment = var.environment
    Module      = "messaging"
  }
}

# --- SNS → SQS Subscriptions ---

resource "aws_sns_topic_subscription" "sqs" {
  for_each = local.queues

  topic_arn = aws_sns_topic.this[each.value.topic].arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.main[each.key].arn
}

# --- SQS Queue Policy (allow SNS to send messages) ---

data "aws_iam_policy_document" "allow_sns" {
  for_each = local.queues

  statement {
    sid       = "AllowSNSSendMessage"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.main[each.key].arn]

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.this[each.value.topic].arn]
    }
  }
}

resource "aws_sqs_queue_policy" "allow_sns" {
  for_each = local.queues

  queue_url = aws_sqs_queue.main[each.key].id
  policy    = data.aws_iam_policy_document.allow_sns[each.key].json
}
