#!/usr/bin/env bash
# Verify Multi-AZ distribution for all Pickket infrastructure
set -euo pipefail

REGION="ap-northeast-2"
CLUSTER="pickket"

echo "=== ECS Service Subnet Distribution ==="
for svc in backend consumer ticket-gateway realtime-hub celery-worker admin; do
  SUBNETS=$(aws ecs describe-services \
    --cluster "$CLUSTER" \
    --services "pickket-prod-${svc}" \
    --query 'services[0].networkConfiguration.awsvpcConfiguration.subnets' \
    --output text --region "$REGION" 2>/dev/null || echo "NOT_FOUND")
  printf "  %-20s %s\n" "$svc" "$SUBNETS"
done

echo ""
echo "=== Running Task AZ Distribution ==="
for svc in backend consumer ticket-gateway; do
  TASK_ARNS=$(aws ecs list-tasks --cluster "$CLUSTER" \
    --service-name "pickket-prod-${svc}" \
    --query 'taskArns' --output text --region "$REGION" 2>/dev/null || echo "")
  if [ -n "$TASK_ARNS" ] && [ "$TASK_ARNS" != "None" ]; then
    AZ_DIST=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks $TASK_ARNS \
      --query 'tasks[*].availabilityZone' --output text --region "$REGION" 2>/dev/null || echo "N/A")
    printf "  %-20s %s\n" "$svc" "$AZ_DIST"
  else
    printf "  %-20s %s\n" "$svc" "NO_TASKS"
  fi
done

echo ""
echo "=== Aurora Cluster Instances ==="
aws rds describe-db-instances \
  --filters Name=db-cluster-id,Values=pickket-aurora-v2 \
  --query 'DBInstances[*].{Instance:DBInstanceIdentifier,AZ:AvailabilityZone,Role:DBInstanceStatus}' \
  --output table --region "$REGION" 2>/dev/null || echo "  Aurora cluster not found"

echo ""
echo "=== Redis Cluster Nodes ==="
aws elasticache describe-replication-groups \
  --replication-group-id pickket-redis-cluster \
  --query 'ReplicationGroups[0].NodeGroups[*].NodeGroupMembers[*].{Node:CacheNodeId,AZ:PreferredAvailabilityZone,Role:CurrentRole}' \
  --output table --region "$REGION" 2>/dev/null || echo "  Redis cluster not found"

echo ""
echo "=== ALB Subnets ==="
aws elbv2 describe-load-balancers \
  --names pickket-v2-alb \
  --query 'LoadBalancers[0].AvailabilityZones[*].{Zone:ZoneName,Subnet:SubnetId}' \
  --output table --region "$REGION" 2>/dev/null || echo "  ALB not found"

echo ""
echo "=== Done ==="
