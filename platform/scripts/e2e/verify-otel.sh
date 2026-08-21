#!/usr/bin/env bash
# verify-otel.sh — OTel end-to-end verification for Pickket v2
# Usage: ./scripts/e2e/verify-otel.sh [API_BASE_URL]
#
# Prerequisites:
#   - AWS CLI configured with ap-northeast-2 credentials
#   - curl, jq installed
#   - Backend running with OTel instrumentation enabled

set -euo pipefail

REGION="ap-northeast-2"
API_BASE="${1:-http://localhost:8021}"
NAMESPACE="Pickket/Application"
LOG_GROUP_PREFIX="/ecs/pickket-v2"
PASS=0
FAIL=0
TOTAL=0

# Colors
GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[0;33m"
RESET="\033[0m"

result() {
  local label="$1" status="$2"
  TOTAL=$((TOTAL + 1))
  if [[ "$status" == "PASS" ]]; then
    PASS=$((PASS + 1))
    printf "  ${GREEN}[PASS]${RESET} %s\n" "$label"
  else
    FAIL=$((FAIL + 1))
    printf "  ${RED}[FAIL]${RESET} %s\n" "$label"
  fi
}

echo "============================================"
echo " Pickket v2 — OTel End-to-End Verification"
echo " Region : ${REGION}"
echo " API    : ${API_BASE}"
echo " Time   : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "============================================"
echo ""

# ---------------------------------------------------------------
# 1. Send test request with a synthetic trace ID
# ---------------------------------------------------------------
echo "1) Sending test request with trace header..."

TRACE_HEX=$(openssl rand -hex 16)
SPAN_HEX=$(openssl rand -hex 8)
# X-Ray trace format: 1-<unix epoch hex>-<96-bit random hex>
EPOCH_HEX=$(printf '%x' "$(date +%s)")
XRAY_TRACE_ID="1-${EPOCH_HEX}-${TRACE_HEX:0:24}"
# W3C traceparent: version-traceId-parentId-flags
TRACEPARENT="00-${EPOCH_HEX}${TRACE_HEX:0:24}0000-${SPAN_HEX}-01"

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "traceparent: ${TRACEPARENT}" \
  -H "X-Amzn-Trace-Id: Root=${XRAY_TRACE_ID}" \
  "${API_BASE}/health" 2>/dev/null || echo "000")

if [[ "$HTTP_STATUS" =~ ^2[0-9]{2}$ ]]; then
  result "API /health responded HTTP ${HTTP_STATUS}" "PASS"
else
  result "API /health responded HTTP ${HTTP_STATUS} (expected 2xx)" "FAIL"
fi

echo "   Trace ID (X-Ray) : ${XRAY_TRACE_ID}"
echo "   traceparent      : ${TRACEPARENT}"
echo ""

# Wait for trace propagation
echo "   Waiting 10s for trace propagation..."
sleep 10

# ---------------------------------------------------------------
# 2. Check X-Ray for the trace
# ---------------------------------------------------------------
echo "2) Checking AWS X-Ray for trace..."

START_TIME=$(date -u -d '2 minutes ago' +%s 2>/dev/null || date -u -v-2M +%s)
END_TIME=$(date -u +%s)

XRAY_RESULT=$(aws xray get-trace-summaries \
  --region "${REGION}" \
  --start-time "${START_TIME}" \
  --end-time "${END_TIME}" \
  --filter-expression "annotation.service = \"pickket-v2\" OR http.url CONTAINS \"health\"" \
  --output json 2>/dev/null || echo '{"TraceSummaries":[]}')

TRACE_COUNT=$(echo "${XRAY_RESULT}" | jq '.TraceSummaries | length')

if [[ "${TRACE_COUNT}" -gt 0 ]]; then
  result "X-Ray traces found (${TRACE_COUNT} in last 2 min)" "PASS"
else
  # Fallback: search without filter
  XRAY_FALLBACK=$(aws xray get-trace-summaries \
    --region "${REGION}" \
    --start-time "${START_TIME}" \
    --end-time "${END_TIME}" \
    --output json 2>/dev/null || echo '{"TraceSummaries":[]}')

  FALLBACK_COUNT=$(echo "${XRAY_FALLBACK}" | jq '.TraceSummaries | length')
  if [[ "${FALLBACK_COUNT}" -gt 0 ]]; then
    result "X-Ray traces found (${FALLBACK_COUNT} unfiltered in last 2 min)" "PASS"
  else
    result "No X-Ray traces found in last 2 min" "FAIL"
  fi
fi
echo ""

# ---------------------------------------------------------------
# 3. Verify CloudWatch custom metrics in Pickket/Application
# ---------------------------------------------------------------
echo "3) Checking CloudWatch custom metrics (${NAMESPACE})..."

METRICS_RESULT=$(aws cloudwatch list-metrics \
  --region "${REGION}" \
  --namespace "${NAMESPACE}" \
  --output json 2>/dev/null || echo '{"Metrics":[]}')

METRIC_COUNT=$(echo "${METRICS_RESULT}" | jq '.Metrics | length')

if [[ "${METRIC_COUNT}" -gt 0 ]]; then
  result "Custom metrics found: ${METRIC_COUNT} metric(s) in ${NAMESPACE}" "PASS"

  # List metric names
  echo "${METRICS_RESULT}" | jq -r '.Metrics[].MetricName' | sort -u | while read -r m; do
    printf "     - %s\n" "$m"
  done
else
  result "No custom metrics in namespace ${NAMESPACE}" "FAIL"
fi
echo ""

# ---------------------------------------------------------------
# 4. Check CloudWatch log groups for recent entries
# ---------------------------------------------------------------
echo "4) Checking CloudWatch log groups (${LOG_GROUP_PREFIX}/*)..."

LOG_GROUPS=$(aws logs describe-log-groups \
  --region "${REGION}" \
  --log-group-name-prefix "${LOG_GROUP_PREFIX}" \
  --output json 2>/dev/null || echo '{"logGroups":[]}')

GROUP_COUNT=$(echo "${LOG_GROUPS}" | jq '.logGroups | length')

if [[ "${GROUP_COUNT}" -eq 0 ]]; then
  result "No log groups found with prefix ${LOG_GROUP_PREFIX}" "FAIL"
else
  result "Found ${GROUP_COUNT} log group(s)" "PASS"

  FIFTEEN_MIN_AGO_MS=$(( ($(date +%s) - 900) * 1000 ))

  echo "${LOG_GROUPS}" | jq -r '.logGroups[].logGroupName' | while read -r lg; do
    RECENT=$(aws logs filter-log-events \
      --region "${REGION}" \
      --log-group-name "${lg}" \
      --start-time "${FIFTEEN_MIN_AGO_MS}" \
      --limit 1 \
      --output json 2>/dev/null || echo '{"events":[]}')

    EVENT_COUNT=$(echo "${RECENT}" | jq '.events | length')
    if [[ "${EVENT_COUNT}" -gt 0 ]]; then
      result "Log group ${lg} has recent entries (last 15 min)" "PASS"
    else
      result "Log group ${lg} has NO recent entries (last 15 min)" "FAIL"
    fi
  done
fi
echo ""

# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------
echo "============================================"
echo " Summary"
echo "============================================"
printf "  Total : %d\n" "${TOTAL}"
printf "  ${GREEN}PASS${RESET}  : %d\n" "${PASS}"
printf "  ${RED}FAIL${RESET}  : %d\n" "${FAIL}"
echo ""

if [[ "${FAIL}" -gt 0 ]]; then
  printf "${YELLOW}Some checks failed. Review output above.${RESET}\n"
  exit 1
else
  printf "${GREEN}All checks passed.${RESET}\n"
  exit 0
fi
