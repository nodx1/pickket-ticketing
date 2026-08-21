#!/usr/bin/env bash
# Staging Load Test Environment Setup
# Provisions Aurora Serverless v2 (small), Redis Cluster (small), and k6 runner
set -euo pipefail

REGION="ap-northeast-2"
STG_PREFIX="pickket-stg"

case "${1:-}" in
  provision)
    echo "=== Staging Load Test Environment ==="

    # --- Staging Aurora Serverless v2 (small) ---
    echo ""
    echo "1. Creating staging Aurora cluster (0.5-8 ACU)..."

    VPC_ID=$(aws ec2 describe-vpcs --filters "Name=tag:Name,Values=pickket-v2-vpc" \
      --query "Vpcs[0].VpcId" --output text --region "$REGION")

    RDS_SG=$(aws ec2 describe-security-groups \
      --filters "Name=group-name,Values=pickket-v2-rds-sg" \
      --query "SecurityGroups[0].GroupId" --output text --region "$REGION")

    aws rds create-db-cluster \
      --db-cluster-identifier "${STG_PREFIX}-aurora" \
      --engine aurora-postgresql \
      --engine-version "16.1" \
      --master-username pickket_admin \
      --manage-master-user-password \
      --serverless-v2-scaling-configuration MinCapacity=0.5,MaxCapacity=8 \
      --vpc-security-group-ids "$RDS_SG" \
      --db-subnet-group-name pickket-v2-db-subnet \
      --storage-encrypted \
      --tags Key=Environment,Value=staging Key=Project,Value=pickket \
      --region "$REGION" 2>/dev/null || echo "  (cluster may already exist)"

    aws rds create-db-instance \
      --db-instance-identifier "${STG_PREFIX}-aurora-writer" \
      --db-cluster-identifier "${STG_PREFIX}-aurora" \
      --engine aurora-postgresql \
      --db-instance-class db.serverless \
      --region "$REGION" 2>/dev/null || echo "  (writer may already exist)"

    echo "  Waiting for Aurora cluster..."
    aws rds wait db-cluster-available --db-cluster-identifier "${STG_PREFIX}-aurora" --region "$REGION" 2>/dev/null || true

    # --- Staging Redis Cluster (small) ---
    echo ""
    echo "2. Creating staging Redis cluster (3 shards, t3.small)..."

    REDIS_SG=$(aws ec2 describe-security-groups \
      --filters "Name=group-name,Values=pickket-v2-redis-sg" \
      --query "SecurityGroups[0].GroupId" --output text --region "$REGION")

    aws elasticache create-replication-group \
      --replication-group-id "${STG_PREFIX}-redis" \
      --replication-group-description "Pickket staging Redis Cluster" \
      --engine redis \
      --engine-version "7.1" \
      --cache-node-type cache.t3.small \
      --num-node-groups 3 \
      --replicas-per-node-group 1 \
      --cache-subnet-group-name pickket-v2-redis-subnet \
      --security-group-ids "$REDIS_SG" \
      --at-rest-encryption-enabled \
      --transit-encryption-enabled \
      --tags Key=Environment,Value=staging Key=Project,Value=pickket \
      --region "$REGION" 2>/dev/null || echo "  (cluster may already exist)"

    # --- k6 Runner (Spot EC2) ---
    echo ""
    echo "3. Creating k6 runner instance (c5.xlarge spot)..."

    # Create security group for k6 runner
    K6_SG=$(aws ec2 create-security-group \
      --group-name "${STG_PREFIX}-k6-runner-sg" \
      --description "k6 load test runner" \
      --vpc-id "$VPC_ID" \
      --query "GroupId" --output text \
      --region "$REGION" 2>/dev/null || \
      aws ec2 describe-security-groups \
        --filters "Name=group-name,Values=${STG_PREFIX}-k6-runner-sg" \
        --query "SecurityGroups[0].GroupId" --output text --region "$REGION")

    # Allow SSH access
    aws ec2 authorize-security-group-ingress \
      --group-id "$K6_SG" \
      --protocol tcp --port 22 --cidr 0.0.0.0/0 \
      --region "$REGION" 2>/dev/null || true

    # Allow k6 runner to access ECS services (add to ECS SG inbound)
    ECS_SG=$(aws ec2 describe-security-groups \
      --filters "Name=group-name,Values=pickket-v2-ecs-sg" \
      --query "SecurityGroups[0].GroupId" --output text --region "$REGION")

    aws ec2 authorize-security-group-ingress \
      --group-id "$ECS_SG" \
      --protocol tcp --port 0-65535 --source-group "$K6_SG" \
      --region "$REGION" 2>/dev/null || true

    # Get latest Amazon Linux 2023 AMI
    AMI_ID=$(aws ec2 describe-images \
      --owners amazon \
      --filters "Name=name,Values=al2023-ami-2023*-x86_64" "Name=state,Values=available" \
      --query "sort_by(Images, &CreationDate)[-1].ImageId" \
      --output text --region "$REGION")

    # Get public subnet
    PUB_SUBNET=$(aws ec2 describe-subnets \
      --filters "Name=tag:Name,Values=pickket-v2-pub-a" \
      --query "Subnets[0].SubnetId" --output text --region "$REGION")

    # User data script to install k6
    cat > /tmp/k6-userdata.sh << 'UDEOF'
#!/bin/bash
dnf install -y https://dl.k6.io/rpm/repo.rpm
dnf install -y k6
echo "k6 installed successfully" > /tmp/k6-ready
UDEOF

    INSTANCE_ID=$(aws ec2 run-instances \
      --image-id "$AMI_ID" \
      --instance-type c5.xlarge \
      --instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"one-time"}}' \
      --subnet-id "$PUB_SUBNET" \
      --security-group-ids "$K6_SG" \
      --associate-public-ip-address \
      --user-data file:///tmp/k6-userdata.sh \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${STG_PREFIX}-k6-runner},{Key=Environment,Value=staging},{Key=Project,Value=pickket}]" \
      --query "Instances[0].InstanceId" --output text \
      --region "$REGION" 2>/dev/null || echo "SPOT_UNAVAILABLE")

    if [ "$INSTANCE_ID" != "SPOT_UNAVAILABLE" ]; then
      echo "  Instance: $INSTANCE_ID"
      echo "  Waiting for instance to start..."
      aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"
      PUBLIC_IP=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
        --query "Reservations[0].Instances[0].PublicIpAddress" --output text --region "$REGION")
      echo "  Public IP: $PUBLIC_IP"
    else
      echo "  Spot instance unavailable. Use on-demand or run k6 locally."
    fi

    echo ""
    echo "=== Staging Environment Ready ==="
    echo ""
    echo "Aurora endpoint:"
    aws rds describe-db-clusters --db-cluster-identifier "${STG_PREFIX}-aurora" \
      --query "DBClusters[0].Endpoint" --output text --region "$REGION" 2>/dev/null || echo "  (pending)"
    echo ""
    echo "Redis endpoint:"
    aws elasticache describe-replication-groups --replication-group-id "${STG_PREFIX}-redis" \
      --query "ReplicationGroups[0].ConfigurationEndpoint.Address" --output text --region "$REGION" 2>/dev/null || echo "  (pending)"
    ;;

  run-tests)
    echo "=== Running k6 Load Tests ==="
    echo ""

    STG_API="${STG_API_URL:-http://localhost:8030}"
    STG_WS="${STG_WS_URL:-ws://localhost:8031}"
    STG_BACKEND="${STG_BACKEND_URL:-http://localhost:8021}"

    echo "Target: $STG_API"
    echo ""

    for test in \
      "tests/load/ticket-gateway-rps.js" \
      "tests/load/seat-hold-concurrency.js" \
      "tests/load/cart-flow.js" \
      "tests/load/queue-simulation.js" \
      "tests/load/websocket-stress.js" \
      "tests/load/eda-e2e.js"; do

      echo "--- Running: $(basename $test) ---"
      k6 run \
        -e BASE_URL="$STG_API" \
        -e WS_URL="$STG_WS" \
        -e GW_URL="$STG_API" \
        -e API_URL="$STG_BACKEND" \
        -e EVENT_ID="loadtest-event-001" \
        -e TOKEN="loadtest-token" \
        --out json="/tmp/k6-$(basename $test .js).json" \
        "$test" || echo "  FAILED: $test"
      echo ""
    done

    echo "=== All tests complete. Results in /tmp/k6-*.json ==="
    ;;

  teardown)
    echo "=== Tearing down staging load test environment ==="

    # Terminate k6 runner
    INSTANCE_ID=$(aws ec2 describe-instances \
      --filters "Name=tag:Name,Values=${STG_PREFIX}-k6-runner" "Name=instance-state-name,Values=running" \
      --query "Reservations[0].Instances[0].InstanceId" --output text --region "$REGION" 2>/dev/null)

    if [ "$INSTANCE_ID" != "None" ] && [ -n "$INSTANCE_ID" ]; then
      echo "  Terminating k6 runner: $INSTANCE_ID"
      aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION"
    fi

    # Delete staging Redis
    echo "  Deleting staging Redis cluster..."
    aws elasticache delete-replication-group \
      --replication-group-id "${STG_PREFIX}-redis" \
      --no-final-snapshot-identifier \
      --region "$REGION" 2>/dev/null || echo "  (already deleted)"

    # Delete staging Aurora
    echo "  Deleting staging Aurora instances..."
    aws rds delete-db-instance \
      --db-instance-identifier "${STG_PREFIX}-aurora-writer" \
      --skip-final-snapshot \
      --region "$REGION" 2>/dev/null || echo "  (already deleted)"

    echo "  Deleting staging Aurora cluster..."
    aws rds delete-db-cluster \
      --db-cluster-identifier "${STG_PREFIX}-aurora" \
      --skip-final-snapshot \
      --region "$REGION" 2>/dev/null || echo "  (already deleted)"

    # Cleanup security group
    echo "  Cleaning up k6 security group..."
    K6_SG=$(aws ec2 describe-security-groups \
      --filters "Name=group-name,Values=${STG_PREFIX}-k6-runner-sg" \
      --query "SecurityGroups[0].GroupId" --output text --region "$REGION" 2>/dev/null)
    if [ "$K6_SG" != "None" ] && [ -n "$K6_SG" ]; then
      aws ec2 delete-security-group --group-id "$K6_SG" --region "$REGION" 2>/dev/null || true
    fi

    echo "=== Teardown complete ==="
    ;;

  status)
    echo "=== Staging Environment Status ==="
    echo ""
    echo "Aurora:"
    aws rds describe-db-clusters --db-cluster-identifier "${STG_PREFIX}-aurora" \
      --query "DBClusters[0].{Status:Status,Endpoint:Endpoint,ACU:ServerlessV2ScalingConfiguration}" \
      --output table --region "$REGION" 2>/dev/null || echo "  Not found"
    echo ""
    echo "Redis:"
    aws elasticache describe-replication-groups --replication-group-id "${STG_PREFIX}-redis" \
      --query "ReplicationGroups[0].{Status:Status,Endpoint:ConfigurationEndpoint.Address}" \
      --output table --region "$REGION" 2>/dev/null || echo "  Not found"
    echo ""
    echo "k6 Runner:"
    aws ec2 describe-instances \
      --filters "Name=tag:Name,Values=${STG_PREFIX}-k6-runner" "Name=instance-state-name,Values=running" \
      --query "Reservations[0].Instances[0].{ID:InstanceId,IP:PublicIpAddress,Type:InstanceType}" \
      --output table --region "$REGION" 2>/dev/null || echo "  Not running"
    ;;

  *)
    echo "Usage: $0 [provision|run-tests|teardown|status]"
    echo ""
    echo "  provision  - Create staging Aurora, Redis, and k6 runner"
    echo "  run-tests  - Execute all k6 load test scenarios"
    echo "  teardown   - Destroy all staging resources"
    echo "  status     - Check current environment status"
    exit 1
    ;;
esac
