#!/usr/bin/env bash
# ECS Auto-scaling Setup for all Pickket services
set -euo pipefail

REGION="ap-northeast-2"
CLUSTER="pickket"

register_scaling() {
  local service="$1"
  local min="$2"
  local max="$3"
  local cpu_target="${4:-60}"

  echo "  Registering: ${service} (min=${min}, max=${max}, CPU=${cpu_target}%)"

  aws application-autoscaling register-scalable-target \
    --service-namespace ecs \
    --resource-id "service/${CLUSTER}/pickket-prod-${service}" \
    --scalable-dimension "ecs:service:DesiredCount" \
    --min-capacity "$min" \
    --max-capacity "$max" \
    --region "$REGION"

  # CPU target tracking
  aws application-autoscaling put-scaling-policy \
    --service-namespace ecs \
    --resource-id "service/${CLUSTER}/pickket-prod-${service}" \
    --scalable-dimension "ecs:service:DesiredCount" \
    --policy-name "${service}-cpu-tracking" \
    --policy-type TargetTrackingScaling \
    --target-tracking-scaling-policy-configuration "{
      \"TargetValue\": ${cpu_target},
      \"PredefinedMetricSpecification\": {
        \"PredefinedMetricType\": \"ECSServiceAverageCPUUtilization\"
      },
      \"ScaleOutCooldown\": 60,
      \"ScaleInCooldown\": 300
    }" \
    --region "$REGION"
}

register_alb_scaling() {
  local service="$1"
  local target_group_arn="$2"
  local request_count="$3"

  echo "  ALB request scaling: ${service} (${request_count} req/target)"

  ALB_ARN_SUFFIX=$(echo "$target_group_arn" | sed 's|.*targetgroup/||')

  aws application-autoscaling put-scaling-policy \
    --service-namespace ecs \
    --resource-id "service/${CLUSTER}/pickket-prod-${service}" \
    --scalable-dimension "ecs:service:DesiredCount" \
    --policy-name "${service}-alb-request-tracking" \
    --policy-type TargetTrackingScaling \
    --target-tracking-scaling-policy-configuration "{
      \"TargetValue\": ${request_count},
      \"PredefinedMetricSpecification\": {
        \"PredefinedMetricType\": \"ALBRequestCountPerTarget\",
        \"ResourceLabel\": \"${ALB_ARN_SUFFIX}\"
      },
      \"ScaleOutCooldown\": 60,
      \"ScaleInCooldown\": 300
    }" \
    --region "$REGION"
}

register_sqs_step_scaling() {
  local service="$1"

  echo "  SQS step scaling: ${service}"

  # Scale based on SQS queue depth
  aws application-autoscaling put-scaling-policy \
    --service-namespace ecs \
    --resource-id "service/${CLUSTER}/pickket-prod-${service}" \
    --scalable-dimension "ecs:service:DesiredCount" \
    --policy-name "${service}-sqs-step" \
    --policy-type StepScaling \
    --step-scaling-policy-configuration "{
      \"AdjustmentType\": \"ChangeInCapacity\",
      \"StepAdjustments\": [
        {\"MetricIntervalLowerBound\": 0, \"MetricIntervalUpperBound\": 500, \"ScalingAdjustment\": 2},
        {\"MetricIntervalLowerBound\": 500, \"ScalingAdjustment\": 4}
      ],
      \"Cooldown\": 60
    }" \
    --region "$REGION"
}

echo "=== ECS Auto-scaling Configuration ==="
echo ""

echo "Hot path services:"
register_scaling "ticket-gateway" 2 30 60
register_scaling "realtime-hub" 1 10 60

echo ""
echo "Backend services:"
register_scaling "backend" 2 20 60
register_scaling "celery-worker" 1 8 70

echo ""
echo "Frontend services:"
register_scaling "consumer" 2 10 60
register_scaling "admin" 1 2 60

echo ""
echo "=== ALB Request-based Scaling ==="
TG_TICKETGW_ARN=$(aws elbv2 describe-target-groups \
  --names pickket-v2-ticket-gw-tg \
  --query 'TargetGroups[0].TargetGroupArn' --output text --region "$REGION" 2>/dev/null || echo "")

TG_BACKEND_ARN=$(aws elbv2 describe-target-groups \
  --names pickket-v2-backend-tg \
  --query 'TargetGroups[0].TargetGroupArn' --output text --region "$REGION" 2>/dev/null || echo "")

if [ -n "$TG_TICKETGW_ARN" ] && [ "$TG_TICKETGW_ARN" != "None" ]; then
  register_alb_scaling "ticket-gateway" "$TG_TICKETGW_ARN" 1000
else
  echo "  [SKIP] ticket-gateway target group not found — run after ALB setup"
fi

if [ -n "$TG_BACKEND_ARN" ] && [ "$TG_BACKEND_ARN" != "None" ]; then
  register_alb_scaling "backend" "$TG_BACKEND_ARN" 500
else
  echo "  [SKIP] backend target group not found — run after ALB setup"
fi

echo ""
echo "=== SQS-based Scaling for Celery ==="
register_sqs_step_scaling "celery-worker"

STEP_POLICY_ARN=$(aws application-autoscaling describe-scaling-policies \
  --service-namespace ecs \
  --resource-id "service/${CLUSTER}/pickket-prod-celery-worker" \
  --policy-name "celery-worker-sqs-step" \
  --query 'ScalingPolicies[0].PolicyARN' --output text --region "$REGION" 2>/dev/null || echo "")

if [ -n "$STEP_POLICY_ARN" ] && [ "$STEP_POLICY_ARN" != "None" ]; then
  aws cloudwatch put-metric-alarm \
    --alarm-name pickket-celery-sqs-depth \
    --namespace AWS/SQS \
    --metric-name ApproximateNumberOfMessagesVisible \
    --dimensions Name=QueueName,Value=pickket-v2-order-processing \
    --threshold 100 --period 60 --evaluation-periods 1 \
    --comparison-operator GreaterThanThreshold \
    --statistic Sum \
    --alarm-actions "$STEP_POLICY_ARN" \
    --region "$REGION"
  echo "  Created SQS depth alarm → celery-worker step scaling"
else
  echo "  [SKIP] Step scaling policy not found — register scalable target first"
fi

echo ""
echo "=== Done ==="
aws application-autoscaling describe-scalable-targets \
  --service-namespace ecs \
  --region "$REGION" \
  --query 'ScalableTargets[*].{Service:ResourceId,Min:MinCapacity,Max:MaxCapacity}' \
  --output table
