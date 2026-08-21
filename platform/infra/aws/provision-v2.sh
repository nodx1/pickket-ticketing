#!/usr/bin/env bash
# =============================================================================
# Pickket v2 — 신규 AWS 인프라 프로비저닝 스크립트
# Option B: 완전 새 VPC + 전체 신규 리소스
# 도메인: v2.pickket.kr / api-v2.pickket.kr / studio-v2.pickket.kr / admin-v2.pickket.kr
#
# 사용법: bash infra/aws/provision-v2.sh
# 주의: DRY RUN이 기본값. 실행하려면 DRY_RUN=false 로 설정
# =============================================================================
set -euo pipefail

# ── 설정 ────────────────────────────────────────────────────────────────────
REGION="ap-northeast-2"
ACCOUNT_ID="794562054294"
PREFIX="pickket-v2"

VPC_CIDR="10.3.0.0/16"
PUB_SUBNET_A_CIDR="10.3.1.0/24"
PUB_SUBNET_C_CIDR="10.3.2.0/24"
PRIV_SUBNET_A_CIDR="10.3.10.0/24"
PRIV_SUBNET_C_CIDR="10.3.11.0/24"

AZ_A="${REGION}a"
AZ_C="${REGION}c"

DB_INSTANCE_CLASS="db.t3.micro"
DB_ENGINE="postgres"
DB_ENGINE_VERSION="16.4"
DB_NAME="pickket_v2"
DB_MASTER_USER="pickket_admin"

REDIS_NODE_TYPE="cache.t3.micro"
REDIS_ENGINE_VERSION="7.1"

DRY_RUN="${DRY_RUN:-true}"

# ── 헬퍼 함수 ──────────────────────────────────────────────────────────────
log() { echo "[$(date '+%H:%M:%S')] $*"; }

run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY RUN] $*"
  else
    eval "$@"
  fi
}

# ── Step 1: VPC ─────────────────────────────────────────────────────────────
log "=== Step 1: VPC 생성 ==="

run "VPC_ID=\$(aws ec2 create-vpc \
  --cidr-block $VPC_CIDR \
  --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=${PREFIX}-vpc}]' \
  --region $REGION \
  --query 'Vpc.VpcId' --output text)"

run "aws ec2 modify-vpc-attribute --vpc-id \$VPC_ID --enable-dns-support --region $REGION"
run "aws ec2 modify-vpc-attribute --vpc-id \$VPC_ID --enable-dns-hostnames --region $REGION"

# ── Step 2: 서브넷 ──────────────────────────────────────────────────────────
log "=== Step 2: 서브넷 생성 (퍼블릭 2 + 프라이빗 2) ==="

run "PUB_A=\$(aws ec2 create-subnet \
  --vpc-id \$VPC_ID --cidr-block $PUB_SUBNET_A_CIDR --availability-zone $AZ_A \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=${PREFIX}-pub-a}]' \
  --region $REGION --query 'Subnet.SubnetId' --output text)"

run "PUB_C=\$(aws ec2 create-subnet \
  --vpc-id \$VPC_ID --cidr-block $PUB_SUBNET_C_CIDR --availability-zone $AZ_C \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=${PREFIX}-pub-c}]' \
  --region $REGION --query 'Subnet.SubnetId' --output text)"

run "PRIV_A=\$(aws ec2 create-subnet \
  --vpc-id \$VPC_ID --cidr-block $PRIV_SUBNET_A_CIDR --availability-zone $AZ_A \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=${PREFIX}-priv-a}]' \
  --region $REGION --query 'Subnet.SubnetId' --output text)"

run "PRIV_C=\$(aws ec2 create-subnet \
  --vpc-id \$VPC_ID --cidr-block $PRIV_SUBNET_C_CIDR --availability-zone $AZ_C \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=${PREFIX}-priv-c}]' \
  --region $REGION --query 'Subnet.SubnetId' --output text)"

# ── Step 3: Internet Gateway ────────────────────────────────────────────────
log "=== Step 3: Internet Gateway ==="

run "IGW=\$(aws ec2 create-internet-gateway \
  --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=${PREFIX}-igw}]' \
  --region $REGION --query 'InternetGateway.InternetGatewayId' --output text)"

run "aws ec2 attach-internet-gateway --internet-gateway-id \$IGW --vpc-id \$VPC_ID --region $REGION"

# ── Step 4: NAT Gateway ────────────────────────────────────────────────────
log "=== Step 4: NAT Gateway (프라이빗 서브넷 아웃바운드용) ==="

run "EIP_ALLOC=\$(aws ec2 allocate-address --domain vpc \
  --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Name,Value=${PREFIX}-nat-eip}]' \
  --region $REGION --query 'AllocationId' --output text)"

run "NAT_GW=\$(aws ec2 create-nat-gateway \
  --subnet-id \$PUB_A --allocation-id \$EIP_ALLOC \
  --tag-specifications 'ResourceType=natgateway,Tags=[{Key=Name,Value=${PREFIX}-nat}]' \
  --region $REGION --query 'NatGateway.NatGatewayId' --output text)"

log "  NAT Gateway 생성 대기 (2~3분)..."
run "aws ec2 wait nat-gateway-available --nat-gateway-ids \$NAT_GW --region $REGION"

# ── Step 5: 라우트 테이블 ──────────────────────────────────────────────────
log "=== Step 5: 라우트 테이블 ==="

# 퍼블릭 라우트 테이블
run "PUB_RT=\$(aws ec2 create-route-table --vpc-id \$VPC_ID \
  --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=${PREFIX}-pub-rt}]' \
  --region $REGION --query 'RouteTable.RouteTableId' --output text)"
run "aws ec2 create-route --route-table-id \$PUB_RT --destination-cidr-block 0.0.0.0/0 --gateway-id \$IGW --region $REGION"
run "aws ec2 associate-route-table --route-table-id \$PUB_RT --subnet-id \$PUB_A --region $REGION"
run "aws ec2 associate-route-table --route-table-id \$PUB_RT --subnet-id \$PUB_C --region $REGION"

# 프라이빗 라우트 테이블
run "PRIV_RT=\$(aws ec2 create-route-table --vpc-id \$VPC_ID \
  --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=${PREFIX}-priv-rt}]' \
  --region $REGION --query 'RouteTable.RouteTableId' --output text)"
run "aws ec2 create-route --route-table-id \$PRIV_RT --destination-cidr-block 0.0.0.0/0 --nat-gateway-id \$NAT_GW --region $REGION"
run "aws ec2 associate-route-table --route-table-id \$PRIV_RT --subnet-id \$PRIV_A --region $REGION"
run "aws ec2 associate-route-table --route-table-id \$PRIV_RT --subnet-id \$PRIV_C --region $REGION"

# ── Step 6: 보안 그룹 ──────────────────────────────────────────────────────
log "=== Step 6: 보안 그룹 ==="

# ALB SG — 80, 443 인바운드
run "ALB_SG=\$(aws ec2 create-security-group \
  --group-name ${PREFIX}-alb-sg --description 'ALB - HTTP/HTTPS' \
  --vpc-id \$VPC_ID --region $REGION --query 'GroupId' --output text)"
run "aws ec2 authorize-security-group-ingress --group-id \$ALB_SG --protocol tcp --port 80 --cidr 0.0.0.0/0 --region $REGION"
run "aws ec2 authorize-security-group-ingress --group-id \$ALB_SG --protocol tcp --port 443 --cidr 0.0.0.0/0 --region $REGION"

# ECS SG — ALB에서만 인바운드
run "ECS_SG=\$(aws ec2 create-security-group \
  --group-name ${PREFIX}-ecs-sg --description 'ECS tasks - from ALB only' \
  --vpc-id \$VPC_ID --region $REGION --query 'GroupId' --output text)"
run "aws ec2 authorize-security-group-ingress --group-id \$ECS_SG --protocol tcp --port 0-65535 --source-group \$ALB_SG --region $REGION"

# RDS SG — ECS에서만 5432
run "RDS_SG=\$(aws ec2 create-security-group \
  --group-name ${PREFIX}-rds-sg --description 'RDS - from ECS only' \
  --vpc-id \$VPC_ID --region $REGION --query 'GroupId' --output text)"
run "aws ec2 authorize-security-group-ingress --group-id \$RDS_SG --protocol tcp --port 5432 --source-group \$ECS_SG --region $REGION"

# Redis SG — ECS에서만 6379
run "REDIS_SG=\$(aws ec2 create-security-group \
  --group-name ${PREFIX}-redis-sg --description 'Redis - from ECS only' \
  --vpc-id \$VPC_ID --region $REGION --query 'GroupId' --output text)"
run "aws ec2 authorize-security-group-ingress --group-id \$REDIS_SG --protocol tcp --port 6379 --source-group \$ECS_SG --region $REGION"

# ── Step 7: RDS ─────────────────────────────────────────────────────────────
log "=== Step 7: RDS (PostgreSQL 16) ==="

run "aws rds create-db-subnet-group \
  --db-subnet-group-name ${PREFIX}-db-subnet \
  --db-subnet-group-description 'Pickket v2 DB subnets' \
  --subnet-ids \$PRIV_A \$PRIV_C \
  --region $REGION"

log "  DB 비밀번호를 Secrets Manager에 저장합니다..."
run "DB_PASSWORD=\$(openssl rand -base64 24 | tr -d '=/+')"
run "aws secretsmanager create-secret \
  --name ${PREFIX}/db-password \
  --secret-string \$DB_PASSWORD \
  --region $REGION"

# --- Aurora Serverless v2 Cluster ---
echo "Creating Aurora Serverless v2 cluster..."
run "aws rds create-db-cluster \
  --db-cluster-identifier pickket-aurora-v2 \
  --engine aurora-postgresql \
  --engine-version \"16.1\" \
  --master-username pickket_admin \
  --manage-master-user-password \
  --serverless-v2-scaling-configuration MinCapacity=0.5,MaxCapacity=64 \
  --vpc-security-group-ids \$RDS_SG \
  --db-subnet-group-name pickket-v2-db-subnet \
  --storage-encrypted \
  --backup-retention-period 7 \
  --region $REGION"

run "aws rds create-db-instance \
  --db-instance-identifier pickket-aurora-v2-writer \
  --db-cluster-identifier pickket-aurora-v2 \
  --engine aurora-postgresql \
  --db-instance-class db.serverless \
  --region $REGION"

run "aws rds create-db-instance \
  --db-instance-identifier pickket-aurora-v2-reader \
  --db-cluster-identifier pickket-aurora-v2 \
  --engine aurora-postgresql \
  --db-instance-class db.serverless \
  --promotion-tier 1 \
  --region $REGION"

echo "Creating RDS Proxy..."
run "aws rds create-db-proxy \
  --db-proxy-name pickket-db-proxy \
  --engine-family POSTGRESQL \
  --auth Description=\"pickket-proxy-auth\",AuthScheme=SECRETS,SecretArn=\"arn:aws:secretsmanager:\${REGION}:794562054294:secret:pickket-prod/database-credentials\",IAMAuth=DISABLED \
  --role-arn \"arn:aws:iam::794562054294:role/pickket-rds-proxy-role\" \
  --vpc-subnet-ids \$PRIV_A \$PRIV_C \
  --vpc-security-group-ids \$RDS_SG \
  --require-tls \
  --region $REGION"

run "aws rds register-db-proxy-targets \
  --db-proxy-name pickket-db-proxy \
  --db-cluster-identifiers pickket-aurora-v2 \
  --region $REGION"

# ── Step 8: ElastiCache (Redis) ─────────────────────────────────────────────
log "=== Step 8: ElastiCache Redis ==="

run "aws elasticache create-cache-subnet-group \
  --cache-subnet-group-name ${PREFIX}-redis-subnet \
  --cache-subnet-group-description 'Pickket v2 Redis subnets' \
  --subnet-ids \$PRIV_A \$PRIV_C \
  --region $REGION"

# --- Redis Cluster Mode Enabled ---
echo "Creating Redis Cluster (3 shards x 2 nodes)..."
run "aws elasticache create-replication-group \
  --replication-group-id pickket-redis-cluster \
  --replication-group-description 'Pickket v2 Redis Cluster' \
  --engine redis \
  --engine-version \"7.1\" \
  --cache-node-type cache.r7g.small \
  --num-node-groups 3 \
  --replicas-per-node-group 1 \
  --cache-subnet-group-name pickket-v2-redis-subnet \
  --security-group-ids \$REDIS_SG \
  --at-rest-encryption-enabled \
  --transit-encryption-enabled \
  --auto-minor-version-upgrade \
  --region $REGION"

# ── Step 9: ECR (기존 pickket-* 레포 재사용 — v2 태그로 구분) ────────────
log "=== Step 9: ECR ==="
log "  기존 pickket-backend/consumer/studio/admin 레포 재사용 (v2-latest 태그)"

# Go 서비스용 ECR 레포 생성
for REPO in pickket/ticket-gateway pickket/realtime-hub; do
  run "aws ecr describe-repositories --repository-names $REPO --region $REGION 2>/dev/null || \
  aws ecr create-repository --repository-name $REPO --region $REGION \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=AES256 \
    --tags Key=Project,Value=pickket-v2"
done

# ── Step 10: ECS 클러스터 ──────────────────────────────────────────────────
log "=== Step 10: ECS 클러스터 ==="

run "aws ecs create-cluster \
  --cluster-name ${PREFIX} \
  --capacity-providers FARGATE FARGATE_SPOT \
  --default-capacity-provider-strategy capacityProvider=FARGATE,weight=1 \
  --setting name=containerInsights,value=enabled \
  --tags key=Project,value=pickket-v2 \
  --region $REGION"

# ── Step 11: ALB ────────────────────────────────────────────────────────────
log "=== Step 11: ALB + 타겟그룹 ==="

run "ALB_ARN=\$(aws elbv2 create-load-balancer \
  --name ${PREFIX}-alb \
  --subnets \$PUB_A \$PUB_C \
  --security-groups \$ALB_SG \
  --scheme internet-facing \
  --type application \
  --tags Key=Project,Value=pickket-v2 \
  --region $REGION \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)"

# 타겟그룹: backend (8000), consumer (3000), studio (3000), admin (3000)
for svc_port in "backend:8000" "consumer:3000" "studio:3000" "admin:3000"; do
  SVC=\${svc_port%%:*}
  PORT=\${svc_port##*:}
  run "TG_\${SVC^^}=\$(aws elbv2 create-target-group \
    --name ${PREFIX}-\$SVC-tg \
    --protocol HTTP --port \$PORT \
    --vpc-id \$VPC_ID \
    --target-type ip \
    --health-check-path /health \
    --health-check-interval-seconds 30 \
    --healthy-threshold-count 2 \
    --unhealthy-threshold-count 3 \
    --region $REGION \
    --query 'TargetGroups[0].TargetGroupArn' --output text)"
done

# HTTPS 리스너 (인증서는 ACM에서 수동 생성 필요)
log "  [주의] HTTPS 리스너는 ACM 인증서 생성 후 수동 설정 필요"
log "  필요 도메인: v2.pickket.kr, api-v2.pickket.kr, studio-v2.pickket.kr, admin-v2.pickket.kr"

# HTTP → HTTPS 리다이렉트 리스너
run "aws elbv2 create-listener \
  --load-balancer-arn \$ALB_ARN \
  --protocol HTTP --port 80 \
  --default-actions Type=redirect,RedirectConfig='{Protocol=HTTPS,Port=443,StatusCode=HTTP_301}' \
  --region $REGION"

# --- Go Service Target Groups ---
echo "Creating ticket-gateway target group..."
TG_TICKETGW_ARN=$(aws elbv2 create-target-group \
  --name pickket-v2-ticket-gw-tg \
  --protocol HTTP --port 8030 \
  --vpc-id "$VPC_ID" \
  --target-type ip \
  --health-check-path /health \
  --health-check-interval-seconds 30 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --region "$REGION" \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

echo "Creating realtime-hub target group..."
TG_REALTIMEHUB_ARN=$(aws elbv2 create-target-group \
  --name pickket-v2-realtime-hub-tg \
  --protocol HTTP --port 8031 \
  --vpc-id "$VPC_ID" \
  --target-type ip \
  --health-check-path /health \
  --health-check-interval-seconds 30 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --region "$REGION" \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

# --- Path-based Routing Rules ---
HTTPS_LISTENER_ARN=$(aws elbv2 describe-listeners \
  --load-balancer-arn "$ALB_ARN" \
  --query "Listeners[?Port==\`443\`].ListenerArn" --output text --region "$REGION")

echo "Adding routing rules..."

# P10: Purchase paths → ticket-gateway
aws elbv2 create-rule \
  --listener-arn "$HTTPS_LISTENER_ARN" \
  --priority 10 \
  --conditions '[{"Field":"path-pattern","Values":["/api/v1/*/purchase","/api/v1/*/tiers/*/purchase"]}]' \
  --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"$TG_TICKETGW_ARN\"}]" \
  --region "$REGION"

# P20: Queue paths → ticket-gateway
aws elbv2 create-rule \
  --listener-arn "$HTTPS_LISTENER_ARN" \
  --priority 20 \
  --conditions '[{"Field":"path-pattern","Values":["/api/v1/*/queue/*"]}]' \
  --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"$TG_TICKETGW_ARN\"}]" \
  --region "$REGION"

# P30: Seat paths → ticket-gateway
aws elbv2 create-rule \
  --listener-arn "$HTTPS_LISTENER_ARN" \
  --priority 30 \
  --conditions '[{"Field":"path-pattern","Values":["/api/v1/*/seats/*"]}]' \
  --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"$TG_TICKETGW_ARN\"}]" \
  --region "$REGION"

# P40: Cart paths → ticket-gateway
aws elbv2 create-rule \
  --listener-arn "$HTTPS_LISTENER_ARN" \
  --priority 40 \
  --conditions '[{"Field":"path-pattern","Values":["/api/v1/cart/*"]}]' \
  --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"$TG_TICKETGW_ARN\"}]" \
  --region "$REGION"

# P50: Waiting room → ticket-gateway
aws elbv2 create-rule \
  --listener-arn "$HTTPS_LISTENER_ARN" \
  --priority 50 \
  --conditions '[{"Field":"path-pattern","Values":["/api/v1/waiting-room/*"]}]' \
  --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"$TG_TICKETGW_ARN\"}]" \
  --region "$REGION"

# P60: WebSocket → realtime-hub (with stickiness)
aws elbv2 create-rule \
  --listener-arn "$HTTPS_LISTENER_ARN" \
  --priority 60 \
  --conditions '[{"Field":"path-pattern","Values":["/ws/*"]}]' \
  --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"$TG_REALTIMEHUB_ARN\",\"ForwardConfig\":{\"TargetGroupStickinessConfig\":{\"Enabled\":true,\"DurationSeconds\":3600}}}]" \
  --region "$REGION"

# --- ECS Services for Go services ---
echo "Creating ticket-gateway ECS service..."
aws ecs create-service \
  --cluster "$CLUSTER_NAME" \
  --service-name pickket-prod-ticket-gateway \
  --task-definition pickket-prod-ticket-gateway \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNET_A,$PRIV_SUBNET_C],securityGroups=[$ECS_SG],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=$TG_TICKETGW_ARN,containerName=ticket-gateway,containerPort=8030" \
  --region "$REGION"

echo "Creating realtime-hub ECS service..."
aws ecs create-service \
  --cluster "$CLUSTER_NAME" \
  --service-name pickket-prod-realtime-hub \
  --task-definition pickket-prod-realtime-hub \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_SUBNET_A,$PRIV_SUBNET_C],securityGroups=[$ECS_SG],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=$TG_REALTIMEHUB_ARN,containerName=realtime-hub,containerPort=8031" \
  --region "$REGION"

# --- CloudWatch Log Groups for Go services (matches task-def awslogs-group) ---
aws logs create-log-group --log-group-name /ecs/pickket/ticket-gateway --region "$REGION" 2>/dev/null || true
aws logs put-retention-policy --log-group-name /ecs/pickket/ticket-gateway --retention-in-days 30 --region "$REGION"
aws logs create-log-group --log-group-name /ecs/pickket/realtime-hub --region "$REGION" 2>/dev/null || true
aws logs put-retention-policy --log-group-name /ecs/pickket/realtime-hub --retention-in-days 30 --region "$REGION"

# ── Step 12: CloudWatch 로그그룹 ──────────────────────────────────────────
log "=== Step 12: CloudWatch 로그그룹 ==="

for svc in backend consumer studio admin celery-worker celery-beat; do
  run "aws logs create-log-group --log-group-name /ecs/${PREFIX}/$svc --region $REGION --tags Project=pickket-v2"
  run "aws logs put-retention-policy --log-group-name /ecs/${PREFIX}/$svc --retention-in-days 30 --region $REGION"
done

# ── Step 13: ECS 실행 역할 (기존 재사용 가능) ───────────────────────────────
log "=== Step 13: IAM 역할 ==="
log "  기존 ecsTaskExecutionRole / ecsTaskRole 재사용"
log "  Secrets Manager 접근 정책만 추가 필요: ${PREFIX}/db-password"

# ── Step 14: CloudWatch 알람 ──────────────────────────────────────────────────
log "=== Step 14: CloudWatch 알람 설정 ==="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/cloudwatch-alarms-v2.sh" ]; then
  bash "$SCRIPT_DIR/cloudwatch-alarms-v2.sh"
  log "  CloudWatch 알람 설정 완료"
else
  log "  [SKIP] cloudwatch-alarms-v2.sh 파일 없음 — 수동 실행 필요"
fi

# ── 완료 ────────────────────────────────────────────────────────────────────
log ""
log "=============================="
log "  프로비저닝 완료!"
log "=============================="
log ""
log "남은 수동 작업:"
log "  1. ACM에서 v2.pickket.kr *.v2.pickket.kr 인증서 생성 (또는 기존 *.pickket.kr 사용)"
log "  2. ALB에 HTTPS 리스너 + 호스트 기반 라우팅 규칙 추가"
log "  3. Cloudflare DNS에 v2/api-v2/studio-v2/admin-v2 CNAME → ALB DNS"
log "  4. Secrets Manager에 나머지 시크릿 등록 (PortOne, OAuth, SES 등)"
log "  5. GitHub Secrets에 V2 관련 값 추가"
log "  6. ECS 태스크 정의 등록 + 서비스 생성"
log ""
log "ALB DNS: (위 스크립트 실행 후 확인)"
log "DB Endpoint: ${PREFIX}-db.xxxx.ap-northeast-2.rds.amazonaws.com"
log "Redis Endpoint: ${PREFIX}-redis.xxxx.cache.amazonaws.com"
