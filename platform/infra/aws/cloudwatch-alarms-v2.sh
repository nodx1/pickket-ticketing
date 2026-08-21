#!/usr/bin/env bash
# CloudWatch Alarms for Pickket v2 — ENV별 (stg|prod) 파라미터화
#
# 사용법:
#   ENV=stg  bash infra/aws/cloudwatch-alarms-v2.sh
#   ENV=prod bash infra/aws/cloudwatch-alarms-v2.sh
#
# 2026-04-08: 실제 AWS 리소스 이름에 맞게 재작성. 이전 버전은 존재하지
# 않는 리소스(pickket-v2-alb, pickket-aurora-v2 등)를 참조해 동작 안 함.

set -euo pipefail

ENV="${ENV:-stg}"
REGION="${REGION:-ap-northeast-2}"

case "$ENV" in
  stg)
    ALARM_PREFIX="pickket-stg"
    SNS_TOPIC="pickket-stg-ops-alerts"
    CLUSTER="pickket-stg"
    ECS_SERVICES=(backend celery-worker consumer studio admin ticket-gateway realtime-hub)
    ALB_NAME="pickket-stg-alb"
    AURORA_CLUSTER="pickket-stg-aurora"
    REDIS_GROUP="pickket-stg-redis"
    RDS_PROXY="pickket-stg-db-proxy"
    ;;
  prod)
    ALARM_PREFIX="pickket-prod"
    SNS_TOPIC="pickket-prod-ops-alerts"
    CLUSTER="pickket"
    ECS_SERVICES=(prod-backend prod-celery-worker prod-consumer prod-studio prod-admin)
    ALB_NAME="pickket-alb"
    AURORA_CLUSTER=""            # prod는 아직 Aurora 아님 (db.t3.micro)
    REDIS_GROUP="pickket-redis-std"
    RDS_PROXY=""                 # prod에 RDS Proxy 없음
    ;;
  *)
    echo "Usage: ENV=stg|prod $0" >&2
    exit 1
    ;;
esac

echo "=== Environment: $ENV ==="
echo "Cluster:      $CLUSTER"
echo "ALB:          $ALB_NAME"
echo "Region:       $REGION"
echo "Alarm prefix: $ALARM_PREFIX"
echo ""

echo "=== SNS Topic ==="
ALERT_TOPIC_ARN=$(aws sns create-topic --name "$SNS_TOPIC" --region "$REGION" --query 'TopicArn' --output text)
echo "Alert topic: $ALERT_TOPIC_ARN"
echo ""

create_alarm() {
  local name="$1"
  local namespace="$2"
  local metric="$3"
  local threshold="$4"
  local period="$5"
  local eval_periods="$6"
  local comparison="$7"
  local statistic="${8:-Average}"
  local dimensions="${9:-}"

  echo "  Creating alarm: ${ALARM_PREFIX}-${name}"

  local stat_flag="--statistic ${statistic}"
  # percentile 통계는 --extended-statistic 사용
  if [[ "$statistic" =~ ^p[0-9]+(\.[0-9]+)?$ ]]; then
    stat_flag="--extended-statistic ${statistic}"
  fi

  local cmd="aws cloudwatch put-metric-alarm \
    --alarm-name ${ALARM_PREFIX}-${name} \
    --namespace ${namespace} \
    --metric-name ${metric} \
    --threshold ${threshold} \
    --period ${period} \
    --evaluation-periods ${eval_periods} \
    --comparison-operator ${comparison} \
    ${stat_flag} \
    --alarm-actions ${ALERT_TOPIC_ARN} \
    --ok-actions ${ALERT_TOPIC_ARN} \
    --region ${REGION}"

  if [ -n "$dimensions" ]; then
    cmd="$cmd --dimensions $dimensions"
  fi

  eval "$cmd"
}

echo "=== ALB Alarms ==="
ALB_SUFFIX=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --query 'LoadBalancers[0].LoadBalancerArn' --output text --region "$REGION" 2>/dev/null | sed 's|.*loadbalancer/||' || echo "")
if [ -n "$ALB_SUFFIX" ]; then
  create_alarm "p99-latency" "AWS/ApplicationELB" "TargetResponseTime" 2 60 3 "GreaterThanThreshold" "p99" "Name=LoadBalancer,Value=${ALB_SUFFIX}"
  create_alarm "5xx-rate" "AWS/ApplicationELB" "HTTPCode_Target_5XX_Count" 50 60 2 "GreaterThanThreshold" "Sum" "Name=LoadBalancer,Value=${ALB_SUFFIX}"
  create_alarm "alb-unhealthy-targets" "AWS/ApplicationELB" "UnHealthyHostCount" 1 60 2 "GreaterThanOrEqualToThreshold" "Maximum" "Name=LoadBalancer,Value=${ALB_SUFFIX}"
else
  echo "  (skipped — ALB $ALB_NAME not found)"
fi
echo ""

echo "=== Aurora Alarms ==="
if [ -n "$AURORA_CLUSTER" ]; then
  create_alarm "db-connections" "AWS/RDS" "DatabaseConnections" 160 300 2 "GreaterThanThreshold" "Average" "Name=DBClusterIdentifier,Value=${AURORA_CLUSTER}"
  create_alarm "db-acu-high" "AWS/RDS" "ServerlessDatabaseCapacity" 14 300 1 "GreaterThanThreshold" "Average" "Name=DBClusterIdentifier,Value=${AURORA_CLUSTER}"
else
  echo "  (skipped — no Aurora cluster for $ENV)"
fi
echo ""

echo "=== Redis Alarms ==="
create_alarm "redis-memory" "AWS/ElastiCache" "DatabaseMemoryUsagePercentage" 80 300 2 "GreaterThanThreshold" "Average" "Name=ReplicationGroupId,Value=${REDIS_GROUP}"
create_alarm "redis-cpu" "AWS/ElastiCache" "EngineCPUUtilization" 80 300 2 "GreaterThanThreshold" "Average" "Name=ReplicationGroupId,Value=${REDIS_GROUP}"
echo ""

echo "=== ECS CPU + Memory Alarms ==="
for service in "${ECS_SERVICES[@]}"; do
  create_alarm "ecs-cpu-${service}" "AWS/ECS" "CPUUtilization" 90 180 1 "GreaterThanThreshold" "Average" "Name=ClusterName,Value=${CLUSTER} Name=ServiceName,Value=${service}"
  create_alarm "ecs-memory-${service}" "AWS/ECS" "MemoryUtilization" 85 180 2 "GreaterThanThreshold" "Average" "Name=ClusterName,Value=${CLUSTER} Name=ServiceName,Value=${service}"
done
echo ""

echo "=== RDS Proxy Alarms ==="
if [ -n "$RDS_PROXY" ]; then
  create_alarm "rds-proxy-connections" "AWS/RDS" "DatabaseConnectionsCurrentlyBorrowed" 200 300 2 "GreaterThanThreshold" "Average" "Name=ProxyName,Value=${RDS_PROXY}"
else
  echo "  (skipped — no RDS Proxy for $ENV)"
fi
echo ""

echo "=== Done ==="
aws cloudwatch describe-alarms --alarm-name-prefix "$ALARM_PREFIX" --query 'MetricAlarms[*].AlarmName' --output table --region "$REGION"
