#!/usr/bin/env bash
# Aurora Serverless v2 Pre-warming via EventBridge + Lambda
set -euo pipefail

REGION="ap-northeast-2"
CLUSTER_ID="pickket-aurora-v2"
FUNCTION_NAME="pickket-aurora-warming"
RULE_NAME="pickket-aurora-warmup"

case "${1:-}" in
  deploy)
    echo "=== Deploying Aurora Warming Lambda ==="

    # Create Lambda function inline
    cat > /tmp/aurora_warming.py << 'PYEOF'
import boto3
import os
import json

def handler(event, context):
    rds = boto3.client('rds', region_name=os.environ['AWS_REGION'])
    cluster_id = os.environ['CLUSTER_ID']
    action = event.get('action', 'warmup')

    if action == 'warmup':
        min_capacity = float(event.get('min_capacity', 16))
        print(f"Warming up {cluster_id} to min {min_capacity} ACU")
        rds.modify_db_cluster(
            DBClusterIdentifier=cluster_id,
            ServerlessV2ScalingConfiguration={'MinCapacity': min_capacity, 'MaxCapacity': 64}
        )
    elif action == 'cooldown':
        print(f"Cooling down {cluster_id} to min 0.5 ACU")
        rds.modify_db_cluster(
            DBClusterIdentifier=cluster_id,
            ServerlessV2ScalingConfiguration={'MinCapacity': 0.5, 'MaxCapacity': 64}
        )

    return {'statusCode': 200, 'body': json.dumps(f'{action} complete for {cluster_id}')}
PYEOF

    cd /tmp && zip -j aurora_warming.zip aurora_warming.py

    aws lambda create-function \
      --function-name "$FUNCTION_NAME" \
      --runtime python3.12 \
      --handler aurora_warming.handler \
      --zip-file fileb:///tmp/aurora_warming.zip \
      --role "arn:aws:iam::794562054294:role/pickket-lambda-role" \
      --environment "Variables={CLUSTER_ID=$CLUSTER_ID}" \
      --timeout 30 \
      --region "$REGION" 2>/dev/null || \
    aws lambda update-function-code \
      --function-name "$FUNCTION_NAME" \
      --zip-file fileb:///tmp/aurora_warming.zip \
      --region "$REGION"

    echo "Lambda deployed: $FUNCTION_NAME"
    echo ""
    echo "To schedule warmup before an event:"
    echo "  aws events put-rule --name $RULE_NAME --schedule-expression 'cron(30 14 25 3 ? 2026)' --region $REGION"
    echo "  aws events put-targets --rule $RULE_NAME --targets 'Id=warmup,Arn=<lambda-arn>,Input={\"action\":\"warmup\",\"min_capacity\":16}'"
    ;;

  warmup-now)
    echo "=== Immediate warmup to 16 ACU ==="
    aws lambda invoke \
      --function-name "$FUNCTION_NAME" \
      --payload '{"action":"warmup","min_capacity":16}' \
      --region "$REGION" /tmp/warmup_response.json
    cat /tmp/warmup_response.json
    ;;

  cooldown-now)
    echo "=== Immediate cooldown to 0.5 ACU ==="
    aws lambda invoke \
      --function-name "$FUNCTION_NAME" \
      --payload '{"action":"cooldown"}' \
      --region "$REGION" /tmp/cooldown_response.json
    cat /tmp/cooldown_response.json
    ;;

  *)
    echo "Usage: $0 [deploy|warmup-now|cooldown-now]"
    exit 1
    ;;
esac
