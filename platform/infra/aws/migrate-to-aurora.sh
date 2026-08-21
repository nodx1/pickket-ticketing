#!/usr/bin/env bash
# Aurora Serverless v2 Migration Script
# Usage: ./migrate-to-aurora.sh [prepare|execute|rollback]
set -euo pipefail

REGION="ap-northeast-2"
CLUSTER_ID="pickket-aurora-v2"
DB_NAME="pickket_v2"
MASTER_USER="pickket_admin"
OLD_RDS_ID="pickket-db"
PROXY_NAME="pickket-db-proxy"
SECRET_ARN="arn:aws:secretsmanager:${REGION}:794562054294:secret:pickket-prod/database-credentials"

case "${1:-}" in
  prepare)
    echo "=== Phase 1: Create Aurora Serverless v2 Cluster ==="

    aws rds create-db-cluster \
      --region "$REGION" \
      --db-cluster-identifier "$CLUSTER_ID" \
      --engine aurora-postgresql \
      --engine-version "16.1" \
      --master-username "$MASTER_USER" \
      --manage-master-user-password \
      --serverless-v2-scaling-configuration MinCapacity=0.5,MaxCapacity=64 \
      --vpc-security-group-ids "$(aws rds describe-db-instances --db-instance-identifier $OLD_RDS_ID --query 'DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId' --output text)" \
      --db-subnet-group-name "$(aws rds describe-db-instances --db-instance-identifier $OLD_RDS_ID --query 'DBInstances[0].DBSubnetGroup.DBSubnetGroupName' --output text)" \
      --storage-encrypted \
      --backup-retention-period 7 \
      --tags Key=Environment,Value=production Key=Project,Value=pickket

    echo "Creating writer instance..."
    aws rds create-db-instance \
      --region "$REGION" \
      --db-instance-identifier "${CLUSTER_ID}-writer" \
      --db-cluster-identifier "$CLUSTER_ID" \
      --engine aurora-postgresql \
      --db-instance-class db.serverless

    echo "Creating reader instance..."
    aws rds create-db-instance \
      --region "$REGION" \
      --db-instance-identifier "${CLUSTER_ID}-reader" \
      --db-cluster-identifier "$CLUSTER_ID" \
      --engine aurora-postgresql \
      --db-instance-class db.serverless \
      --promotion-tier 1

    echo "Waiting for cluster to be available..."
    aws rds wait db-cluster-available --db-cluster-identifier "$CLUSTER_ID" --region "$REGION"

    echo "Creating RDS Proxy..."
    aws rds create-db-proxy \
      --region "$REGION" \
      --db-proxy-name "$PROXY_NAME" \
      --engine-family POSTGRESQL \
      --auth Description="pickket-proxy-auth",AuthScheme=SECRETS,SecretArn="$SECRET_ARN",IAMAuth=DISABLED \
      --role-arn "arn:aws:iam::794562054294:role/pickket-rds-proxy-role" \
      --vpc-subnet-ids "$(aws rds describe-db-instances --db-instance-identifier $OLD_RDS_ID --query 'DBInstances[0].DBSubnetGroup.Subnets[*].SubnetIdentifier' --output text)" \
      --require-tls

    aws rds register-db-proxy-targets \
      --region "$REGION" \
      --db-proxy-name "$PROXY_NAME" \
      --db-cluster-identifiers "$CLUSTER_ID"

    echo "=== Preparation complete. Run initial pg_dump next. ==="
    echo "WRITER: $(aws rds describe-db-clusters --db-cluster-identifier $CLUSTER_ID --query 'DBClusters[0].Endpoint' --output text)"
    echo "READER: $(aws rds describe-db-clusters --db-cluster-identifier $CLUSTER_ID --query 'DBClusters[0].ReaderEndpoint' --output text)"
    echo "PROXY:  $(aws rds describe-db-proxies --db-proxy-name $PROXY_NAME --query 'DBProxies[0].Endpoint' --output text)"
    ;;

  execute)
    echo "=== Phase 2: Migration Execution (Maintenance Window) ==="
    echo "WARNING: This will cause ~30 minutes of downtime."
    read -p "Continue? (yes/no): " confirm
    [[ "$confirm" != "yes" ]] && exit 1

    WRITER_ENDPOINT=$(aws rds describe-db-clusters --db-cluster-identifier "$CLUSTER_ID" --query 'DBClusters[0].Endpoint' --output text)
    OLD_ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier "$OLD_RDS_ID" --query 'DBInstances[0].Endpoint.Address' --output text)
    PROXY_ENDPOINT=$(aws rds describe-db-proxies --db-proxy-name "$PROXY_NAME" --query 'DBProxies[0].Endpoint' --output text)

    echo "1. Terminating active connections on old RDS..."
    PGPASSWORD="$DB_PASSWORD" psql -h "$OLD_ENDPOINT" -U "$MASTER_USER" -d postgres \
      -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB_NAME' AND pid <> pg_backend_pid();"

    echo "2. Final pg_dump from old RDS..."
    PGPASSWORD="$DB_PASSWORD" pg_dump -h "$OLD_ENDPOINT" -U "$MASTER_USER" -d "$DB_NAME" \
      --no-owner --no-privileges -Fc -f /tmp/final_dump.sql

    echo "3. Creating database on Aurora..."
    PGPASSWORD="$DB_PASSWORD" psql -h "$WRITER_ENDPOINT" -U "$MASTER_USER" -d postgres \
      -c "DROP DATABASE IF EXISTS $DB_NAME; CREATE DATABASE $DB_NAME;"

    echo "4. Restoring to Aurora..."
    PGPASSWORD="$DB_PASSWORD" pg_restore -h "$WRITER_ENDPOINT" -U "$MASTER_USER" -d "$DB_NAME" \
      --no-owner --no-privileges /tmp/final_dump.sql

    echo "5. Updating Secrets Manager..."
    aws secretsmanager update-secret \
      --secret-id "pickket-prod/database-url" \
      --secret-string "postgresql+asyncpg://${MASTER_USER}:${DB_PASSWORD}@${PROXY_ENDPOINT}:5432/${DB_NAME}?ssl=require"

    aws secretsmanager update-secret \
      --secret-id "pickket-prod/database-url-sync" \
      --secret-string "postgresql+psycopg2://${MASTER_USER}:${DB_PASSWORD}@${PROXY_ENDPOINT}:5432/${DB_NAME}?sslmode=require"

    READER_ENDPOINT=$(aws rds describe-db-clusters --db-cluster-identifier "$CLUSTER_ID" --query 'DBClusters[0].ReaderEndpoint' --output text)
    aws secretsmanager put-secret-value \
      --secret-id "pickket-prod/database-read-url" \
      --secret-string "postgresql+asyncpg://${MASTER_USER}:${DB_PASSWORD}@${READER_ENDPOINT}:5432/${DB_NAME}?ssl=require" || \
    aws secretsmanager create-secret \
      --name "pickket-prod/database-read-url" \
      --secret-string "postgresql+asyncpg://${MASTER_USER}:${DB_PASSWORD}@${READER_ENDPOINT}:5432/${DB_NAME}?ssl=require"

    echo "6. Force redeploying ECS services..."
    for svc in backend celery-worker celery-beat; do
      aws ecs update-service --cluster pickket --service "pickket-prod-${svc}" --force-new-deployment --region "$REGION"
    done

    echo "7. Waiting for services to stabilize..."
    aws ecs wait services-stable --cluster pickket --services pickket-prod-backend --region "$REGION"

    echo "=== Migration complete! Verify /health/detailed ==="
    ;;

  rollback)
    echo "=== Rollback: Reverting to old RDS ==="
    OLD_ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier "$OLD_RDS_ID" --query 'DBInstances[0].Endpoint.Address' --output text)

    aws secretsmanager update-secret \
      --secret-id "pickket-prod/database-url" \
      --secret-string "postgresql+asyncpg://${MASTER_USER}:${DB_PASSWORD}@${OLD_ENDPOINT}:5432/${DB_NAME}"

    aws secretsmanager update-secret \
      --secret-id "pickket-prod/database-url-sync" \
      --secret-string "postgresql+psycopg2://${MASTER_USER}:${DB_PASSWORD}@${OLD_ENDPOINT}:5432/${DB_NAME}"

    for svc in backend celery-worker celery-beat; do
      aws ecs update-service --cluster pickket --service "pickket-prod-${svc}" --force-new-deployment --region "$REGION"
    done

    echo "=== Rollback complete ==="
    ;;

  *)
    echo "Usage: $0 [prepare|execute|rollback]"
    exit 1
    ;;
esac
