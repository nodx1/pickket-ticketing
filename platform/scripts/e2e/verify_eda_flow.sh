#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# EDA (Event-Driven Architecture) Infrastructure Verification
# ---------------------------------------------------------------------------
# AWS SNS/SQS 기반 이벤트 파이프라인 전체 검증:
#   1. SNS 토픽 존재 및 활성 상태
#   2. SQS 큐 존재 및 메시지 수량
#   3. SNS->SQS 구독 확인 상태
#   4. 테스트 메시지 발행 -> 수신 검증
#   5. DLQ 깊이 확인 (0이어야 정상)
#   6. (선택) 테스트 메시지 정리
#
# Usage:
#   ./scripts/e2e/verify_eda_flow.sh
#   ./scripts/e2e/verify_eda_flow.sh --purge        # 테스트 후 메시지 정리
#   ./scripts/e2e/verify_eda_flow.sh --skip-publish  # 메시지 발행 건너뛰기
#   AWS_ACCOUNT_ID=123456789012 ./scripts/e2e/verify_eda_flow.sh
#
# Prerequisites:
#   - AWS CLI v2 installed and configured
#   - Appropriate IAM permissions (SNS:*, SQS:*)
# ---------------------------------------------------------------------------

AWS_REGION="${AWS_REGION:-ap-northeast-2}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")}"
PURGE_AFTER="${PURGE_AFTER:-false}"
SKIP_PUBLISH="${SKIP_PUBLISH:-false}"
WAIT_SECONDS="${WAIT_SECONDS:-5}"
ENV="${ENV:-stg}"  # stg or prod

# Parse CLI flags
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE_AFTER="true" ;;
    --skip-publish) SKIP_PUBLISH="true" ;;
    --env=*) ENV="${arg#--env=}" ;;
    --help|-h)
      sed -n '3,18p' "$0"
      exit 0
      ;;
  esac
done

# -- Resource prefix (stg → pickket-stg, prod → pickket-prod) ---------------
PREFIX="pickket-${ENV}"

# -- SNS Topics & SQS Queues ------------------------------------------------
SNS_TOPICS=(
  "${PREFIX}-order-events"
  "${PREFIX}-payment-events"
  "${PREFIX}-ticket-events"
  "${PREFIX}-seat-events"
  "${PREFIX}-queue-events"
)

SQS_QUEUES=(
  "${PREFIX}-order-processing"
  "${PREFIX}-payment-processing"
  "${PREFIX}-seat-sync"
  "${PREFIX}-ticket-notifications"
)

# Topic -> Queue mapping for publish/receive verification
declare -A TOPIC_QUEUE_MAP=(
  ["${PREFIX}-order-events"]="${PREFIX}-order-processing"
  ["${PREFIX}-payment-events"]="${PREFIX}-payment-processing"
  ["${PREFIX}-seat-events"]="${PREFIX}-seat-sync"
  ["${PREFIX}-ticket-events"]="${PREFIX}-ticket-notifications"
)

DLQ_SUFFIX="-dlq"

# -- Colors ------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
SKIP_COUNT=0

# -- Helpers -----------------------------------------------------------------
pass_step() {
  echo -e "  ${GREEN}PASS${RESET}  $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail_step() {
  echo -e "  ${RED}FAIL${RESET}  $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

warn_step() {
  echo -e "  ${YELLOW}WARN${RESET}  $1"
  WARN_COUNT=$((WARN_COUNT + 1))
}

skip_step() {
  echo -e "  ${YELLOW}SKIP${RESET}  $1"
  SKIP_COUNT=$((SKIP_COUNT + 1))
}

info() {
  echo -e "  ${DIM}$1${RESET}"
}

separator() {
  echo -e "${DIM}$(printf '%.0s-' {1..70})${RESET}"
}

get_topic_arn() {
  echo "arn:aws:sns:${AWS_REGION}:${AWS_ACCOUNT_ID}:$1"
}

get_queue_url() {
  aws sqs get-queue-url \
    --queue-name "$1" \
    --region "$AWS_REGION" \
    --output text --query 'QueueUrl' 2>/dev/null || echo ""
}

get_queue_attrs() {
  local queue_url="$1"
  aws sqs get-queue-attributes \
    --queue-url "$queue_url" \
    --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible ApproximateNumberOfMessagesDelayed \
    --region "$AWS_REGION" \
    --output json 2>/dev/null || echo "{}"
}

# -- Pre-flight checks ------------------------------------------------------
echo -e "\n${BOLD}============================================================${RESET}"
echo -e "${BOLD}  Pickket v2 EDA Infrastructure Verification${RESET}"
echo -e "${BOLD}============================================================${RESET}"
echo -e "  Region:       ${CYAN}${AWS_REGION}${RESET}"
echo -e "  Account:      ${CYAN}${AWS_ACCOUNT_ID:-UNKNOWN}${RESET}"
echo -e "  Purge after:  ${CYAN}${PURGE_AFTER}${RESET}"
echo -e "  Timestamp:    ${CYAN}$(date -u '+%Y-%m-%dT%H:%M:%SZ')${RESET}"
echo ""

if ! command -v aws >/dev/null 2>&1; then
  echo -e "${RED}ERROR: AWS CLI not found. Install it first.${RESET}"
  exit 1
fi

if [[ -z "$AWS_ACCOUNT_ID" ]]; then
  echo -e "${RED}ERROR: Cannot determine AWS Account ID.${RESET}"
  echo -e "${RED}Set AWS_ACCOUNT_ID or configure AWS credentials.${RESET}"
  exit 1
fi

# Verify credentials work
if ! aws sts get-caller-identity --region "$AWS_REGION" >/dev/null 2>&1; then
  echo -e "${RED}ERROR: AWS credentials invalid or expired.${RESET}"
  exit 1
fi
pass_step "AWS credentials valid"
echo ""

# ===========================================================================
# STEP 1: SNS Topics
# ===========================================================================
separator
echo -e "${BOLD}[1/6] SNS Topics - Existence & Status${RESET}"
separator

TOPIC_ARNS_OK=()

for topic in "${SNS_TOPICS[@]}"; do
  topic_arn=$(get_topic_arn "$topic")

  attrs=$(aws sns get-topic-attributes \
    --topic-arn "$topic_arn" \
    --region "$AWS_REGION" \
    --output json 2>/dev/null || echo "")

  if [[ -n "$attrs" && "$attrs" != "" ]]; then
    sub_count=$(echo "$attrs" | python3 -c "import json,sys; print(json.load(sys.stdin).get('Attributes',{}).get('SubscriptionsConfirmed','0'))" 2>/dev/null || echo "?")
    pass_step "SNS topic exists: ${topic} (${sub_count} confirmed subs)"
    TOPIC_ARNS_OK+=("$topic_arn")
  else
    fail_step "SNS topic missing: ${topic}"
  fi
done
echo ""

# ===========================================================================
# STEP 2: SQS Queues - Existence & Message Counts
# ===========================================================================
separator
echo -e "${BOLD}[2/6] SQS Queues - Existence & Message Counts${RESET}"
separator

declare -A QUEUE_URLS=()

for queue in "${SQS_QUEUES[@]}"; do
  queue_url=$(get_queue_url "$queue")

  if [[ -n "$queue_url" ]]; then
    attrs_json=$(get_queue_attrs "$queue_url")
    msg_visible=$(echo "$attrs_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('Attributes',{}).get('ApproximateNumberOfMessages','?'))" 2>/dev/null || echo "?")
    msg_inflight=$(echo "$attrs_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('Attributes',{}).get('ApproximateNumberOfMessagesNotVisible','?'))" 2>/dev/null || echo "?")
    msg_delayed=$(echo "$attrs_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('Attributes',{}).get('ApproximateNumberOfMessagesDelayed','?'))" 2>/dev/null || echo "?")

    pass_step "SQS queue exists: ${queue}"
    info "  Messages: visible=${msg_visible}  in-flight=${msg_inflight}  delayed=${msg_delayed}"
    QUEUE_URLS["$queue"]="$queue_url"
  else
    fail_step "SQS queue missing: ${queue}"
  fi
done
echo ""

# ===========================================================================
# STEP 3: SNS -> SQS Subscriptions
# ===========================================================================
separator
echo -e "${BOLD}[3/6] SNS -> SQS Subscriptions${RESET}"
separator

for topic in "${SNS_TOPICS[@]}"; do
  topic_arn=$(get_topic_arn "$topic")

  subs=$(aws sns list-subscriptions-by-topic \
    --topic-arn "$topic_arn" \
    --region "$AWS_REGION" \
    --output json 2>/dev/null || echo '{"Subscriptions":[]}')

  sub_count=$(echo "$subs" | python3 -c "
import json, sys
data = json.load(sys.stdin)
subs = data.get('Subscriptions', [])
confirmed = [s for s in subs if s.get('SubscriptionArn','').startswith('arn:')]
pending = [s for s in subs if s.get('SubscriptionArn','') == 'PendingConfirmation']
print(f'{len(confirmed)} {len(pending)}')
" 2>/dev/null || echo "0 0")

  confirmed=$(echo "$sub_count" | cut -d' ' -f1)
  pending=$(echo "$sub_count" | cut -d' ' -f2)

  if [[ "$confirmed" -gt 0 && "$pending" -eq 0 ]]; then
    pass_step "Subscriptions OK: ${topic} (${confirmed} confirmed, ${pending} pending)"
  elif [[ "$pending" -gt 0 ]]; then
    fail_step "Subscriptions PENDING: ${topic} (${confirmed} confirmed, ${pending} pending)"
  elif [[ "$confirmed" -eq 0 ]]; then
    warn_step "No subscriptions: ${topic}"
  fi

  # Show subscription endpoints
  echo "$subs" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for s in data.get('Subscriptions', []):
    proto = s.get('Protocol', '?')
    endpoint = s.get('Endpoint', '?')
    arn = s.get('SubscriptionArn', '?')
    status = 'confirmed' if arn.startswith('arn:') else 'pending'
    # Shorten endpoint for display
    short = endpoint.split(':')[-1] if ':' else endpoint
    print(f'    -> [{proto}] {short} ({status})')
" 2>/dev/null || true
done
echo ""

# ===========================================================================
# STEP 4: Test Message Publish & Receive
# ===========================================================================
separator
echo -e "${BOLD}[4/6] Test Message Publish -> Receive${RESET}"
separator

TEST_CORRELATION_ID="eda-verify-$(date +%s)-$$"

if [[ "$SKIP_PUBLISH" == "true" ]]; then
  skip_step "Message publish skipped (--skip-publish)"
  echo ""
else
  # Publish test messages to each topic that has a mapped queue
  PUBLISHED_TOPICS=()

  for topic in "${!TOPIC_QUEUE_MAP[@]}"; do
    topic_arn=$(get_topic_arn "$topic")
    target_queue="${TOPIC_QUEUE_MAP[$topic]}"

    test_message=$(cat <<MSGEOF
{
  "source": "eda-verify",
  "correlation_id": "${TEST_CORRELATION_ID}",
  "topic": "${topic}",
  "target_queue": "${target_queue}",
  "timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "test": true,
  "data": {"verification": "pickket-v2-eda-e2e"}
}
MSGEOF
)

    msg_id=$(aws sns publish \
      --topic-arn "$topic_arn" \
      --message "$test_message" \
      --message-attributes '{"test":{"DataType":"String","StringValue":"true"},"correlation_id":{"DataType":"String","StringValue":"'"${TEST_CORRELATION_ID}"'"}}' \
      --region "$AWS_REGION" \
      --output text --query 'MessageId' 2>/dev/null || echo "")

    if [[ -n "$msg_id" ]]; then
      pass_step "Published to ${topic} (MessageId: ${msg_id:0:12}...)"
      PUBLISHED_TOPICS+=("$topic")
    else
      fail_step "Failed to publish to ${topic}"
    fi
  done

  echo ""
  echo -e "  ${DIM}Waiting ${WAIT_SECONDS}s for message propagation...${RESET}"
  sleep "$WAIT_SECONDS"
  echo ""

  # ===========================================================================
  # STEP 5: Verify Messages Arrived in Queues
  # ===========================================================================
  separator
  echo -e "${BOLD}[5/6] Verify Messages Arrived in Target Queues${RESET}"
  separator

  for topic in "${PUBLISHED_TOPICS[@]}"; do
    target_queue="${TOPIC_QUEUE_MAP[$topic]}"
    queue_url="${QUEUE_URLS[$target_queue]:-}"

    if [[ -z "$queue_url" ]]; then
      fail_step "Cannot verify ${target_queue}: queue URL not found"
      continue
    fi

    # Receive messages and look for our test correlation ID
    received=$(aws sqs receive-message \
      --queue-url "$queue_url" \
      --max-number-of-messages 10 \
      --wait-time-seconds 2 \
      --message-attribute-names "All" \
      --region "$AWS_REGION" \
      --output json 2>/dev/null || echo '{"Messages":[]}')

    found=$(echo "$received" | python3 -c "
import json, sys
data = json.load(sys.stdin)
msgs = data.get('Messages', [])
cid = '${TEST_CORRELATION_ID}'
for m in msgs:
    body = m.get('Body', '')
    try:
        # SNS wraps message in its own envelope
        parsed = json.loads(body)
        inner = parsed.get('Message', body)
        inner_parsed = json.loads(inner) if isinstance(inner, str) else inner
        if inner_parsed.get('correlation_id') == cid:
            print('FOUND|' + m.get('ReceiptHandle', ''))
            break
    except:
        pass
else:
    print('NOT_FOUND|')
" 2>/dev/null || echo "ERROR|")

    found_status=$(echo "$found" | cut -d'|' -f1)
    receipt_handle=$(echo "$found" | cut -d'|' -f2)

    if [[ "$found_status" == "FOUND" ]]; then
      pass_step "Message received in ${target_queue} (from ${topic})"
      # Delete the test message to clean up
      if [[ -n "$receipt_handle" ]]; then
        aws sqs delete-message \
          --queue-url "$queue_url" \
          --receipt-handle "$receipt_handle" \
          --region "$AWS_REGION" 2>/dev/null || true
        info "  Test message cleaned up"
      fi
    elif [[ "$found_status" == "NOT_FOUND" ]]; then
      fail_step "Message NOT received in ${target_queue} (from ${topic})"
      info "  Message may still be in-flight or subscription is misconfigured"
    else
      fail_step "Error checking ${target_queue}"
    fi
  done
  echo ""
fi

# ===========================================================================
# STEP 6: DLQ Depth Check
# ===========================================================================
separator
echo -e "${BOLD}[6/6] Dead Letter Queue (DLQ) Depth Check${RESET}"
separator

DLQ_CLEAN=true

for queue in "${SQS_QUEUES[@]}"; do
  dlq_name="${queue}${DLQ_SUFFIX}"
  dlq_url=$(get_queue_url "$dlq_name")

  if [[ -z "$dlq_url" ]]; then
    warn_step "DLQ not found: ${dlq_name}"
    continue
  fi

  dlq_attrs=$(get_queue_attrs "$dlq_url")
  dlq_depth=$(echo "$dlq_attrs" | python3 -c "import json,sys; print(json.load(sys.stdin).get('Attributes',{}).get('ApproximateNumberOfMessages','0'))" 2>/dev/null || echo "?")

  if [[ "$dlq_depth" == "0" ]]; then
    pass_step "DLQ empty: ${dlq_name} (depth: 0)"
  else
    fail_step "DLQ has messages: ${dlq_name} (depth: ${dlq_depth})"
    DLQ_CLEAN=false
    info "  Run: ./scripts/e2e/dlq-redrive.sh --peek ${dlq_name}"
  fi
done
echo ""

# ===========================================================================
# Optional: Purge test messages from all queues
# ===========================================================================
if [[ "$PURGE_AFTER" == "true" ]]; then
  separator
  echo -e "${BOLD}[Cleanup] Purging test messages${RESET}"
  separator

  for queue in "${SQS_QUEUES[@]}"; do
    queue_url="${QUEUE_URLS[$queue]:-}"
    if [[ -n "$queue_url" ]]; then
      aws sqs purge-queue \
        --queue-url "$queue_url" \
        --region "$AWS_REGION" 2>/dev/null && \
        info "Purged: ${queue}" || \
        warn_step "Failed to purge: ${queue}"
    fi
  done
  echo ""
fi

# ===========================================================================
# Summary
# ===========================================================================
separator
echo -e "${BOLD}SUMMARY${RESET}"
separator

TOTAL=$((PASS_COUNT + FAIL_COUNT + WARN_COUNT + SKIP_COUNT))

echo -e "  ${GREEN}Passed:  ${PASS_COUNT}${RESET}"
echo -e "  ${RED}Failed:  ${FAIL_COUNT}${RESET}"
echo -e "  ${YELLOW}Warned:  ${WARN_COUNT}${RESET}"
echo -e "  ${YELLOW}Skipped: ${SKIP_COUNT}${RESET}"
echo -e "  Total:   ${TOTAL}"
echo ""

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo -e "${RED}${BOLD}  EDA VERIFICATION FAILED${RESET}"
  echo -e "${DIM}  ${FAIL_COUNT} check(s) failed. Review output above.${RESET}"
  echo ""
  exit 1
elif [[ "$WARN_COUNT" -gt 0 ]]; then
  echo -e "${YELLOW}${BOLD}  EDA VERIFICATION PASSED WITH WARNINGS${RESET}"
  echo ""
  exit 0
else
  echo -e "${GREEN}${BOLD}  EDA VERIFICATION PASSED${RESET}"
  echo ""
  exit 0
fi
