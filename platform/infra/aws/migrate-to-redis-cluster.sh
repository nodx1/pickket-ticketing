#!/usr/bin/env bash
# Redis Cluster Mode Migration
set -euo pipefail

REGION="ap-northeast-2"
REPL_GROUP="pickket-redis-cluster"

case "${1:-}" in
  create)
    echo "=== Creating Redis Cluster Mode Enabled ==="

    SUBNET_GROUP=$(aws elasticache describe-cache-subnet-groups \
      --query "CacheSubnetGroups[?contains(CacheSubnetGroupName,'pickket')].CacheSubnetGroupName" \
      --output text --region "$REGION")

    SG_ID=$(aws ec2 describe-security-groups \
      --filters "Name=group-name,Values=pickket-v2-redis-sg" \
      --query "SecurityGroups[0].GroupId" --output text --region "$REGION")

    aws elasticache create-replication-group \
      --region "$REGION" \
      --replication-group-id "$REPL_GROUP" \
      --replication-group-description "Pickket v2 Redis Cluster" \
      --engine redis \
      --engine-version "7.1" \
      --cache-node-type "cache.r7g.small" \
      --num-node-groups 3 \
      --replicas-per-node-group 1 \
      --cache-subnet-group-name "$SUBNET_GROUP" \
      --security-group-ids "$SG_ID" \
      --at-rest-encryption-enabled \
      --transit-encryption-enabled \
      --auto-minor-version-upgrade \
      --tags Key=Environment,Value=production Key=Project,Value=pickket

    echo "Waiting for cluster to be available (this may take 10-15 minutes)..."
    aws elasticache wait replication-group-available \
      --replication-group-id "$REPL_GROUP" --region "$REGION"

    CONFIG_ENDPOINT=$(aws elasticache describe-replication-groups \
      --replication-group-id "$REPL_GROUP" \
      --query "ReplicationGroups[0].ConfigurationEndpoint.Address" \
      --output text --region "$REGION")

    echo "=== Cluster ready ==="
    echo "Configuration endpoint: ${CONFIG_ENDPOINT}:6379"
    echo ""
    echo "Next steps:"
    echo "1. Update Secrets Manager: pickket-prod/redis-url"
    echo "2. Set REDIS_CLUSTER_MODE=true in task definitions"
    echo "3. Set REDIS_CLUSTER_NODES=${CONFIG_ENDPOINT}:6379"
    echo "4. Force redeploy all ECS services"
    ;;

  switch)
    echo "=== Switching to Redis Cluster ==="
    CONFIG_ENDPOINT=$(aws elasticache describe-replication-groups \
      --replication-group-id "$REPL_GROUP" \
      --query "ReplicationGroups[0].ConfigurationEndpoint.Address" \
      --output text --region "$REGION")

    aws secretsmanager update-secret \
      --secret-id "pickket-prod/redis-url" \
      --secret-string "redis://${CONFIG_ENDPOINT}:6379/0"

    aws secretsmanager update-secret \
      --secret-id "pickket-prod/redis-cluster-nodes" \
      --secret-string "${CONFIG_ENDPOINT}:6379"

    echo "Force redeploying all services..."
    for svc in backend celery-worker celery-beat ticket-gateway realtime-hub consumer admin; do
      aws ecs update-service --cluster pickket --service "pickket-prod-${svc}" --force-new-deployment --region "$REGION" 2>/dev/null || true
    done

    echo "=== Switch complete. Redis data is non-persistent — no migration needed. ==="
    ;;

  rollback)
    echo "=== Rolling back to standalone Redis ==="
    OLD_ENDPOINT="master.pickket-redis-std.mpakkf.apn2.cache.amazonaws.com"

    aws secretsmanager update-secret \
      --secret-id "pickket-prod/redis-url" \
      --secret-string "redis://${OLD_ENDPOINT}:6379/0"

    for svc in backend celery-worker celery-beat ticket-gateway realtime-hub; do
      aws ecs update-service --cluster pickket --service "pickket-prod-${svc}" --force-new-deployment --region "$REGION" 2>/dev/null || true
    done

    echo "=== Rollback complete ==="
    ;;

  *)
    echo "Usage: $0 [create|switch|rollback]"
    exit 1
    ;;
esac
