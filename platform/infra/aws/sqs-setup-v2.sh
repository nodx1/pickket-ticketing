#!/usr/bin/env bash
# SQS Queues + DLQ + SNS Topics + Subscriptions
set -euo pipefail

REGION="ap-northeast-2"
PREFIX="pickket-v2"

create_queue_pair() {
  local name="$1"
  local visibility="${2:-30}"

  echo "  Creating DLQ: ${PREFIX}-${name}-dlq"
  DLQ_ARN=$(aws sqs create-queue \
    --queue-name "${PREFIX}-${name}-dlq" \
    --attributes "{\"MessageRetentionPeriod\":\"1209600\",\"VisibilityTimeout\":\"3600\"}" \
    --region "$REGION" \
    --query 'QueueUrl' --output text)

  DLQ_ARN_FULL=$(aws sqs get-queue-attributes \
    --queue-url "$DLQ_ARN" \
    --attribute-names QueueArn \
    --query 'Attributes.QueueArn' --output text --region "$REGION")

  echo "  Creating main: ${PREFIX}-${name}"
  QUEUE_URL=$(aws sqs create-queue \
    --queue-name "${PREFIX}-${name}" \
    --attributes "{
      \"VisibilityTimeout\":\"${visibility}\",
      \"MessageRetentionPeriod\":\"345600\",
      \"ReceiveMessageWaitTimeSeconds\":\"20\",
      \"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN_FULL}\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"
    }" \
    --region "$REGION" \
    --query 'QueueUrl' --output text)

  echo "    Queue URL: $QUEUE_URL"
  echo "    DLQ ARN: $DLQ_ARN_FULL"
}

create_sns_topic() {
  local name="$1"

  echo "  Creating topic: ${PREFIX}-${name}"
  TOPIC_ARN=$(aws sns create-topic \
    --name "${PREFIX}-${name}" \
    --region "$REGION" \
    --query 'TopicArn' --output text)

  echo "    Topic ARN: $TOPIC_ARN"
}

subscribe_sqs_to_sns() {
  local topic_name="$1"
  local queue_name="$2"
  local filter="${3:-}"

  TOPIC_ARN=$(aws sns list-topics --region "$REGION" --query "Topics[?contains(TopicArn,'${PREFIX}-${topic_name}')].TopicArn" --output text)
  QUEUE_URL=$(aws sqs get-queue-url --queue-name "${PREFIX}-${queue_name}" --region "$REGION" --query 'QueueUrl' --output text)
  QUEUE_ARN=$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text --region "$REGION")

  echo "  Subscribing ${queue_name} to ${topic_name}"
  SUB_ARN=$(aws sns subscribe \
    --topic-arn "$TOPIC_ARN" \
    --protocol sqs \
    --notification-endpoint "$QUEUE_ARN" \
    --region "$REGION" \
    --query 'SubscriptionArn' --output text)

  # Allow SNS to send to SQS
  aws sqs set-queue-attributes \
    --queue-url "$QUEUE_URL" \
    --attributes "{\"Policy\":\"{\\\"Statement\\\":[{\\\"Effect\\\":\\\"Allow\\\",\\\"Principal\\\":{\\\"Service\\\":\\\"sns.amazonaws.com\\\"},\\\"Action\\\":\\\"sqs:SendMessage\\\",\\\"Resource\\\":\\\"${QUEUE_ARN}\\\",\\\"Condition\\\":{\\\"ArnEquals\\\":{\\\"aws:SourceArn\\\":\\\"${TOPIC_ARN}\\\"}}}]}\"}" \
    --region "$REGION"

  echo "    Subscription: $SUB_ARN"
}

echo "=== Creating SQS Queues (4 main + 4 DLQ) ==="
create_queue_pair "order-processing" 30
create_queue_pair "payment-processing" 60
create_queue_pair "seat-sync" 30
create_queue_pair "ticket-notifications" 30

echo ""
echo "=== Creating SNS Topics (5) ==="
create_sns_topic "order-events"
create_sns_topic "payment-events"
create_sns_topic "ticket-events"
create_sns_topic "seat-events"
create_sns_topic "queue-events"

echo ""
echo "=== Creating SNS → SQS Subscriptions ==="
subscribe_sqs_to_sns "order-events" "order-processing"
subscribe_sqs_to_sns "payment-events" "payment-processing"
subscribe_sqs_to_sns "seat-events" "seat-sync"
subscribe_sqs_to_sns "ticket-events" "ticket-notifications"

echo ""
echo "=== Done ==="
echo "Queues:"
aws sqs list-queues --queue-name-prefix "$PREFIX" --region "$REGION" --query 'QueueUrls' --output table
echo ""
echo "Topics:"
aws sns list-topics --region "$REGION" --query "Topics[?contains(TopicArn,'${PREFIX}')]" --output table
