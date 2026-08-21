#!/usr/bin/env bash
# CloudWatch Logs Insights — Saved Queries for Pickket 운영
set -euo pipefail

REGION="ap-northeast-2"
LOG_GROUP="/ecs/pickket-prod/backend"

echo "=== Creating Saved Queries ==="

# 1. 최근 1시간 결제 에러
echo "  Creating: 결제 에러 (1시간)"
aws logs put-query-definition \
  --name "Pickket/결제 에러 (1시간)" \
  --log-group-names "$LOG_GROUP" \
  --query-string 'fields @timestamp, @message, status_code, request_path
| filter level = "ERROR" and @message like /payment|purchase|portone/
| sort @timestamp desc
| limit 50' \
  --region "$REGION"

# 2. 최근 1시간 느린 API 요청 (>1초)
echo "  Creating: 느린 API 요청 (1시간)"
aws logs put-query-definition \
  --name "Pickket/느린 API 요청 (>1s)" \
  --log-group-names "$LOG_GROUP" \
  --query-string 'fields @timestamp, request_path, duration_ms, method
| filter duration_ms > 1000
| sort duration_ms desc
| limit 50' \
  --region "$REGION"

# 3. 인증 실패 패턴
echo "  Creating: 인증 실패 패턴"
aws logs put-query-definition \
  --name "Pickket/인증 실패 패턴" \
  --log-group-names "$LOG_GROUP" \
  --query-string 'fields @timestamp, client_ip, request_path, status_code
| filter status_code = 401 or status_code = 403
| stats count() as fail_count by client_ip
| sort fail_count desc
| limit 20' \
  --region "$REGION"

# 4. 체크인 에러
echo "  Creating: 체크인 에러"
aws logs put-query-definition \
  --name "Pickket/체크인 에러" \
  --log-group-names "$LOG_GROUP" \
  --query-string 'fields @timestamp, @message, request_path, status_code
| filter @message like /checkin/ and level = "ERROR"
| sort @timestamp desc
| limit 50' \
  --region "$REGION"

# 5. 5xx 에러 상위 엔드포인트
echo "  Creating: 5xx 에러 상위 엔드포인트"
aws logs put-query-definition \
  --name "Pickket/5xx 에러 상위 엔드포인트" \
  --log-group-names "$LOG_GROUP" \
  --query-string 'fields @timestamp, request_path, status_code, @message
| filter status_code >= 500
| stats count() as error_count by request_path
| sort error_count desc
| limit 20' \
  --region "$REGION"

echo ""
echo "=== Done ==="
echo "5 saved queries created. Access via CloudWatch > Logs Insights > Saved queries."
