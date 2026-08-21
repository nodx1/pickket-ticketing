#!/bin/bash
# Pickket CloudWatch Alarms Setup (Idempotent)
# Usage: ./setup-alarms.sh [--region ap-northeast-2]

set -euo pipefail

REGION="${1:-ap-northeast-2}"
SNS_TOPIC="arn:aws:sns:${REGION}:$(aws sts get-caller-identity --query Account --output text):pickket-alerts"
CLUSTER_ID="pickket-v2-cluster"
ALB_ARN_SUFFIX=$(aws elbv2 describe-load-balancers --names pickket-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null | sed 's|.*loadbalancer/||' || echo "PLACEHOLDER")

echo "Setting up CloudWatch alarms (region: $REGION)..."

# 1. API 5xx Error Rate
aws cloudwatch put-metric-alarm --region "$REGION" \
  --alarm-name "pickket-api-error-rate-high" \
  --alarm-description "API 5xx 에러 50건/5분 초과" \
  --namespace "AWS/ApplicationELB" \
  --metric-name "HTTPCode_Target_5XX_Count" \
  --statistic Sum \
  --period 300 \
  --evaluation-periods 2 \
  --threshold 50 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "$SNS_TOPIC" \
  --ok-actions "$SNS_TOPIC"

# 2. DB Connections High
aws cloudwatch put-metric-alarm --region "$REGION" \
  --alarm-name "pickket-db-connections-high" \
  --alarm-description "DB 커넥션 80% 초과" \
  --namespace "AWS/RDS" \
  --metric-name "DatabaseConnections" \
  --dimensions Name=DBClusterIdentifier,Value="$CLUSTER_ID" \
  --statistic Average \
  --period 300 \
  --evaluation-periods 2 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "$SNS_TOPIC"

# 3. DB CPU High
aws cloudwatch put-metric-alarm --region "$REGION" \
  --alarm-name "pickket-db-cpu-high" \
  --alarm-description "DB CPU 90% 초과 15분" \
  --namespace "AWS/RDS" \
  --metric-name "CPUUtilization" \
  --dimensions Name=DBClusterIdentifier,Value="$CLUSTER_ID" \
  --statistic Average \
  --period 300 \
  --evaluation-periods 3 \
  --threshold 90 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "$SNS_TOPIC"

# 4. Redis Memory High
aws cloudwatch put-metric-alarm --region "$REGION" \
  --alarm-name "pickket-redis-memory-high" \
  --alarm-description "Redis 메모리 80% 초과" \
  --namespace "AWS/ElastiCache" \
  --metric-name "BytesUsedForCache" \
  --statistic Average \
  --period 300 \
  --evaluation-periods 2 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "$SNS_TOPIC"

# 5. Payment Failure Rate
# 실재 발행 메트릭에 정렬: cloudwatch-log-alerts.sh의 metric filter 'PaymentErrors'가
# 네임스페이스 Pickket/Custom 에 PaymentErrorCount 를 발행한다(구조화 로그 ERROR + *payment*).
# 기존 정의(Custom/Pickket / PaymentFailures)는 발행자가 0건이라 영구 INSUFFICIENT_DATA였음.
# 전제: setup-cloudwatch-log-alerts(metric filter) 적용 필요 — 운영팀 적용 항목.
aws cloudwatch put-metric-alarm --region "$REGION" \
  --alarm-name "pickket-payment-failure-rate" \
  --alarm-description "결제 에러 10건/10분 초과 (로그 메트릭 PaymentErrorCount 기준)" \
  --namespace "Pickket/Custom" \
  --metric-name "PaymentErrorCount" \
  --statistic Sum \
  --period 600 \
  --evaluation-periods 1 \
  --threshold 10 \
  --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "$SNS_TOPIC"

# 6. API Latency P95
aws cloudwatch put-metric-alarm --region "$REGION" \
  --alarm-name "pickket-api-latency-p95" \
  --alarm-description "API P95 응답시간 5초 초과" \
  --namespace "AWS/ApplicationELB" \
  --metric-name "TargetResponseTime" \
  --extended-statistic p95 \
  --period 300 \
  --evaluation-periods 2 \
  --threshold 5.0 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "$SNS_TOPIC"

echo "All alarms configured successfully."
