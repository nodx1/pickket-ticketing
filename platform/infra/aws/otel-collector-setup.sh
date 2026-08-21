#!/usr/bin/env bash
# OTEL Collector ECS Service Setup
set -euo pipefail

REGION="ap-northeast-2"
CLUSTER="pickket"

echo "=== Creating OTEL Collector Log Group ==="
aws logs create-log-group --log-group-name /ecs/pickket-prod/otel-collector --region "$REGION" 2>/dev/null || true
aws logs put-retention-policy --log-group-name /ecs/pickket-prod/otel-collector --retention-in-days 14 --region "$REGION"

echo "=== Registering Task Definition ==="
aws ecs register-task-definition \
  --cli-input-json file://infra/aws/task-definitions/otel-collector.json \
  --region "$REGION"

echo "=== Creating ECS Service ==="
ECS_SG=$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=pickket-v2-ecs-sg" \
  --query "SecurityGroups[0].GroupId" --output text --region "$REGION")

SUBNETS=$(aws ec2 describe-subnets \
  --filters "Name=tag:Name,Values=pickket-v2-priv-*" \
  --query "Subnets[*].SubnetId" --output text --region "$REGION" | tr '\t' ',')

aws ecs create-service \
  --cluster "$CLUSTER" \
  --service-name pickket-prod-otel-collector \
  --task-definition pickket-prod-otel-collector \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$ECS_SG],assignPublicIp=DISABLED}" \
  --region "$REGION"

echo "=== Done ==="
echo "OTLP endpoint: http://pickket-prod-otel-collector.pickket:4317 (gRPC)"
echo "OTLP endpoint: http://pickket-prod-otel-collector.pickket:4318 (HTTP)"
echo ""
echo "Set in backend/Go services:"
echo "  OTEL_EXPORTER_OTLP_ENDPOINT=http://pickket-prod-otel-collector.pickket:4317"
