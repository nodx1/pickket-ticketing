#!/usr/bin/env bash
# CloudWatch Metric Filters — 구조화 JSON 로그 기반 알림 메트릭
# 사전 조건: 로그 그룹이 존재해야 함
set -euo pipefail

REGION="ap-northeast-2"
LOG_GROUP="/ecs/pickket-prod/backend"
NAMESPACE="Pickket/Custom"

echo "=== CloudWatch Metric Filters ==="

# 1. 결제 에러 수
echo "  Creating: PaymentErrors"
aws logs put-metric-filter \
  --log-group-name "$LOG_GROUP" \
  --filter-name PaymentErrors \
  --filter-pattern '{ $.level = "ERROR" && $.message = "*payment*" }' \
  --metric-transformations \
    metricName=PaymentErrorCount,metricNamespace="$NAMESPACE",metricValue=1,defaultValue=0 \
  --region "$REGION"

# 2. 인증 실패 폭증 (브루트포스 감지)
echo "  Creating: AuthFailureSpike"
aws logs put-metric-filter \
  --log-group-name "$LOG_GROUP" \
  --filter-name AuthFailureSpike \
  --filter-pattern '{ $.status_code = 401 || $.status_code = 403 }' \
  --metric-transformations \
    metricName=AuthFailureCount,metricNamespace="$NAMESPACE",metricValue=1,defaultValue=0 \
  --region "$REGION"

# 3. 체크인 에러
echo "  Creating: CheckinErrors"
aws logs put-metric-filter \
  --log-group-name "$LOG_GROUP" \
  --filter-name CheckinErrors \
  --filter-pattern '{ $.level = "ERROR" && $.message = "*checkin*" }' \
  --metric-transformations \
    metricName=CheckinErrorCount,metricNamespace="$NAMESPACE",metricValue=1,defaultValue=0 \
  --region "$REGION"

# 4. 느린 쿼리 (>1초)
echo "  Creating: SlowQueries"
aws logs put-metric-filter \
  --log-group-name "$LOG_GROUP" \
  --filter-name SlowQueries \
  --filter-pattern '{ $.level = "WARNING" && $.message = "*slow*query*" }' \
  --metric-transformations \
    metricName=SlowQueryCount,metricNamespace="$NAMESPACE",metricValue=1,defaultValue=0 \
  --region "$REGION"

echo ""
echo "=== Creating Alarms for Metric Filters ==="

SNS_TOPIC_ARN=$(aws sns list-topics --region "$REGION" --query "Topics[?contains(TopicArn, 'pickket-ops-alerts')].TopicArn" --output text)

if [ -z "$SNS_TOPIC_ARN" ]; then
  echo "WARNING: SNS topic 'pickket-ops-alerts' not found. Alarms will be created without actions."
  SNS_TOPIC_ARN=""
fi

# 결제 에러 5건/5분 → critical
echo "  Creating alarm: pickket-payment-errors"
aws cloudwatch put-metric-alarm \
  --alarm-name pickket-payment-errors \
  --namespace "$NAMESPACE" \
  --metric-name PaymentErrorCount \
  --threshold 5 \
  --period 300 \
  --evaluation-periods 1 \
  --comparison-operator GreaterThanThreshold \
  --statistic Sum \
  ${SNS_TOPIC_ARN:+--alarm-actions "$SNS_TOPIC_ARN" --ok-actions "$SNS_TOPIC_ARN"} \
  --region "$REGION"

# 인증 실패 50건/5분 → warning (브루트포스 의심)
echo "  Creating alarm: pickket-auth-failure-spike"
aws cloudwatch put-metric-alarm \
  --alarm-name pickket-auth-failure-spike \
  --namespace "$NAMESPACE" \
  --metric-name AuthFailureCount \
  --threshold 50 \
  --period 300 \
  --evaluation-periods 1 \
  --comparison-operator GreaterThanThreshold \
  --statistic Sum \
  ${SNS_TOPIC_ARN:+--alarm-actions "$SNS_TOPIC_ARN" --ok-actions "$SNS_TOPIC_ARN"} \
  --region "$REGION"

echo ""
echo "=== Done ==="
echo "Metric filters and alarms created successfully."
