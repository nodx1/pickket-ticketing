#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# DLQ Monitoring & Redrive Utility
# ---------------------------------------------------------------------------
# Dead Letter Queue 모니터링, 메시지 검사, 재드라이브 도구
#
# Usage:
#   ./scripts/e2e/dlq-redrive.sh                          # DLQ 깊이 전체 조회
#   ./scripts/e2e/dlq-redrive.sh --peek <dlq-name>        # DLQ 메시지 엿보기
#   ./scripts/e2e/dlq-redrive.sh --peek <dlq-name> -n 5   # 최대 5개 엿보기
#   ./scripts/e2e/dlq-redrive.sh --redrive <dlq-name>     # DLQ -> 메인 큐 재드라이브
#   ./scripts/e2e/dlq-redrive.sh --redrive <dlq-name> -n 10  # 최대 10개 재드라이브
#   ./scripts/e2e/dlq-redrive.sh --purge <dlq-name>       # DLQ 전체 비우기
#
# Environment:
#   AWS_REGION       (default: ap-northeast-2)
#   AWS_ACCOUNT_ID   (auto-detected)
# ---------------------------------------------------------------------------

AWS_REGION="${AWS_REGION:-ap-northeast-2}"

# -- DLQ -> Main Queue mapping -----------------------------------------------
declare -A DLQ_TO_MAIN=(
  ["pickket-v2-order-processing-dlq"]="pickket-v2-order-processing"
  ["pickket-v2-payment-processing-dlq"]="pickket-v2-payment-processing"
  ["pickket-v2-seat-sync-dlq"]="pickket-v2-seat-sync"
  ["pickket-v2-ticket-notifications-dlq"]="pickket-v2-ticket-notifications"
)

ALL_DLQS=(
  "pickket-v2-order-processing-dlq"
  "pickket-v2-payment-processing-dlq"
  "pickket-v2-seat-sync-dlq"
  "pickket-v2-ticket-notifications-dlq"
)

# -- Colors ------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# -- Helpers -----------------------------------------------------------------
get_queue_url() {
  aws sqs get-queue-url \
    --queue-name "$1" \
    --region "$AWS_REGION" \
    --output text --query 'QueueUrl' 2>/dev/null || echo ""
}

get_queue_depth() {
  local queue_url="$1"
  aws sqs get-queue-attributes \
    --queue-url "$queue_url" \
    --attribute-names ApproximateNumberOfMessages \
    --region "$AWS_REGION" \
    --output text --query 'Attributes.ApproximateNumberOfMessages' 2>/dev/null || echo "?"
}

die() {
  echo -e "${RED}ERROR: $1${RESET}" >&2
  exit 1
}

usage() {
  sed -n '3,15p' "$0"
  exit 0
}

# -- Pre-flight --------------------------------------------------------------
if ! command -v aws >/dev/null 2>&1; then
  die "AWS CLI not found. Install it first."
fi

if ! aws sts get-caller-identity --region "$AWS_REGION" >/dev/null 2>&1; then
  die "AWS credentials invalid or expired."
fi

# -- Parse arguments ---------------------------------------------------------
ACTION="list"
TARGET_DLQ=""
MAX_MESSAGES=10

while [[ $# -gt 0 ]]; do
  case "$1" in
    --peek)
      ACTION="peek"
      TARGET_DLQ="${2:-}"
      shift 2 || die "--peek requires a DLQ name"
      ;;
    --redrive)
      ACTION="redrive"
      TARGET_DLQ="${2:-}"
      shift 2 || die "--redrive requires a DLQ name"
      ;;
    --purge)
      ACTION="purge"
      TARGET_DLQ="${2:-}"
      shift 2 || die "--purge requires a DLQ name"
      ;;
    -n|--max)
      MAX_MESSAGES="${2:-10}"
      shift 2 || die "-n requires a number"
      ;;
    --help|-h)
      usage
      ;;
    *)
      # If no flag but a queue name is given, treat as peek
      if [[ -z "$TARGET_DLQ" && "$ACTION" != "list" ]]; then
        TARGET_DLQ="$1"
      fi
      shift
      ;;
  esac
done

# ===========================================================================
# ACTION: list - Show all DLQ depths
# ===========================================================================
if [[ "$ACTION" == "list" ]]; then
  echo -e "\n${BOLD}============================================================${RESET}"
  echo -e "${BOLD}  Pickket v2 - Dead Letter Queue Status${RESET}"
  echo -e "${BOLD}============================================================${RESET}"
  echo -e "  Region:    ${CYAN}${AWS_REGION}${RESET}"
  echo -e "  Timestamp: ${CYAN}$(date -u '+%Y-%m-%dT%H:%M:%SZ')${RESET}"
  echo ""

  printf "  ${BOLD}%-45s %8s %s${RESET}\n" "DLQ Name" "Depth" "Status"
  echo -e "  ${DIM}$(printf '%.0s-' {1..65})${RESET}"

  total_depth=0
  has_messages=false

  for dlq in "${ALL_DLQS[@]}"; do
    dlq_url=$(get_queue_url "$dlq")

    if [[ -z "$dlq_url" ]]; then
      printf "  %-45s %8s %s\n" "$dlq" "N/A" "NOT FOUND"
      continue
    fi

    depth=$(get_queue_depth "$dlq_url")

    if [[ "$depth" == "0" ]]; then
      status="${GREEN}CLEAN${RESET}"
    else
      status="${RED}HAS MESSAGES${RESET}"
      has_messages=true
      total_depth=$((total_depth + depth))
    fi

    printf "  %-45s %8s " "$dlq" "$depth"
    echo -e "$status"
  done

  echo ""
  if [[ "$has_messages" == "true" ]]; then
    echo -e "  ${RED}${BOLD}Total messages in DLQs: ${total_depth}${RESET}"
    echo -e "  ${DIM}Use --peek <dlq-name> to inspect or --redrive <dlq-name> to reprocess${RESET}"
  else
    echo -e "  ${GREEN}${BOLD}All DLQs are clean.${RESET}"
  fi
  echo ""
  exit 0
fi

# -- Validate target DLQ ----------------------------------------------------
if [[ -z "$TARGET_DLQ" ]]; then
  die "DLQ name is required. Available DLQs:\n$(printf '  - %s\n' "${ALL_DLQS[@]}")"
fi

# Add -dlq suffix if not present
if [[ "$TARGET_DLQ" != *-dlq ]]; then
  TARGET_DLQ="${TARGET_DLQ}-dlq"
fi

DLQ_URL=$(get_queue_url "$TARGET_DLQ")
if [[ -z "$DLQ_URL" ]]; then
  die "DLQ not found: ${TARGET_DLQ}"
fi

MAIN_QUEUE="${DLQ_TO_MAIN[$TARGET_DLQ]:-}"

# ===========================================================================
# ACTION: peek - Inspect messages without consuming
# ===========================================================================
if [[ "$ACTION" == "peek" ]]; then
  echo -e "\n${BOLD}============================================================${RESET}"
  echo -e "${BOLD}  Peek: ${TARGET_DLQ}${RESET}"
  echo -e "${BOLD}============================================================${RESET}"

  depth=$(get_queue_depth "$DLQ_URL")
  echo -e "  Queue depth: ${CYAN}${depth}${RESET}"
  echo -e "  Fetching up to ${MAX_MESSAGES} messages (visibility timeout: 5s)..."
  echo ""

  if [[ "$depth" == "0" ]]; then
    echo -e "  ${GREEN}DLQ is empty. Nothing to peek.${RESET}"
    echo ""
    exit 0
  fi

  # Receive messages with short visibility timeout so they reappear
  messages=$(aws sqs receive-message \
    --queue-url "$DLQ_URL" \
    --max-number-of-messages "$MAX_MESSAGES" \
    --visibility-timeout 5 \
    --message-attribute-names "All" \
    --attribute-names "All" \
    --region "$AWS_REGION" \
    --output json 2>/dev/null || echo '{"Messages":[]}')

  msg_count=$(echo "$messages" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('Messages',[])))" 2>/dev/null || echo "0")

  if [[ "$msg_count" == "0" ]]; then
    echo -e "  ${YELLOW}No messages returned (they may be invisible from a prior receive).${RESET}"
    echo -e "  ${DIM}Wait a moment and try again.${RESET}"
    echo ""
    exit 0
  fi

  echo "$messages" | python3 -c "
import json, sys, textwrap

data = json.load(sys.stdin)
msgs = data.get('Messages', [])

for i, msg in enumerate(msgs, 1):
    msg_id = msg.get('MessageId', '?')
    body = msg.get('Body', '')
    attrs = msg.get('Attributes', {})
    msg_attrs = msg.get('MessageAttributes', {})

    sent_ts = attrs.get('SentTimestamp', '?')
    receive_count = attrs.get('ApproximateReceiveCount', '?')
    first_receive = attrs.get('ApproximateFirstReceiveTimestamp', '?')

    print(f'  --- Message {i}/{len(msgs)} ---')
    print(f'  MessageId:      {msg_id}')
    print(f'  ReceiveCount:   {receive_count}')
    print(f'  SentTimestamp:   {sent_ts}')

    if msg_attrs:
        print(f'  Attributes:')
        for k, v in msg_attrs.items():
            val = v.get('StringValue', v.get('BinaryValue', '?'))
            print(f'    {k}: {val}')

    # Pretty-print body (handle SNS envelope)
    try:
        parsed = json.loads(body)
        # If SNS envelope, show the inner message
        if 'Message' in parsed and 'TopicArn' in parsed:
            print(f'  SNS Topic:      {parsed.get(\"TopicArn\", \"?\").split(\":\")[-1]}')
            inner = parsed.get('Message', '')
            try:
                inner_parsed = json.loads(inner)
                formatted = json.dumps(inner_parsed, indent=2, ensure_ascii=False)
            except:
                formatted = inner
        else:
            formatted = json.dumps(parsed, indent=2, ensure_ascii=False)
    except:
        formatted = body

    print(f'  Body:')
    for line in formatted.split('\n'):
        print(f'    {line}')
    print()
" 2>/dev/null || echo "  Failed to parse messages"

  echo -e "  ${DIM}Messages will reappear in queue after visibility timeout (5s).${RESET}"
  echo ""
  exit 0
fi

# ===========================================================================
# ACTION: redrive - Move messages from DLQ back to main queue
# ===========================================================================
if [[ "$ACTION" == "redrive" ]]; then
  if [[ -z "$MAIN_QUEUE" ]]; then
    die "No main queue mapping found for ${TARGET_DLQ}"
  fi

  MAIN_QUEUE_URL=$(get_queue_url "$MAIN_QUEUE")
  if [[ -z "$MAIN_QUEUE_URL" ]]; then
    die "Main queue not found: ${MAIN_QUEUE}"
  fi

  dlq_depth=$(get_queue_depth "$DLQ_URL")

  echo -e "\n${BOLD}============================================================${RESET}"
  echo -e "${BOLD}  Redrive: ${TARGET_DLQ} -> ${MAIN_QUEUE}${RESET}"
  echo -e "${BOLD}============================================================${RESET}"
  echo -e "  DLQ depth:    ${CYAN}${dlq_depth}${RESET}"
  echo -e "  Max messages: ${CYAN}${MAX_MESSAGES}${RESET}"
  echo ""

  if [[ "$dlq_depth" == "0" ]]; then
    echo -e "  ${GREEN}DLQ is empty. Nothing to redrive.${RESET}"
    echo ""
    exit 0
  fi

  # Confirmation prompt
  echo -e "  ${YELLOW}${BOLD}WARNING: This will move up to ${MAX_MESSAGES} messages from DLQ to main queue.${RESET}"
  read -rp "  Continue? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[yY]$ ]]; then
    echo -e "  Aborted."
    exit 0
  fi
  echo ""

  redriven=0
  failed=0
  batch=0

  while [[ $redriven -lt $MAX_MESSAGES ]]; do
    batch=$((batch + 1))
    remaining=$((MAX_MESSAGES - redriven))
    fetch_count=$((remaining < 10 ? remaining : 10))

    messages=$(aws sqs receive-message \
      --queue-url "$DLQ_URL" \
      --max-number-of-messages "$fetch_count" \
      --visibility-timeout 30 \
      --message-attribute-names "All" \
      --region "$AWS_REGION" \
      --output json 2>/dev/null || echo '{"Messages":[]}')

    msg_count=$(echo "$messages" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('Messages',[])))" 2>/dev/null || echo "0")

    if [[ "$msg_count" == "0" ]]; then
      break
    fi

    # Process each message: send to main queue, then delete from DLQ
    echo "$messages" | python3 -c "
import json, sys, subprocess

data = json.load(sys.stdin)
msgs = data.get('Messages', [])
region = '${AWS_REGION}'
main_url = '${MAIN_QUEUE_URL}'
dlq_url = '${DLQ_URL}'

redriven = 0
failed = 0

for msg in msgs:
    body = msg.get('Body', '')
    receipt = msg.get('ReceiptHandle', '')
    msg_id = msg.get('MessageId', 'unknown')

    # Build message attributes for SQS send
    msg_attrs = msg.get('MessageAttributes', {})
    attrs_arg = {}
    for k, v in msg_attrs.items():
        attrs_arg[k] = {
            'DataType': v.get('DataType', 'String'),
            'StringValue': v.get('StringValue', '')
        }

    # Send to main queue
    send_cmd = [
        'aws', 'sqs', 'send-message',
        '--queue-url', main_url,
        '--message-body', body,
        '--region', region,
        '--output', 'text',
        '--query', 'MessageId'
    ]
    if attrs_arg:
        send_cmd += ['--message-attributes', json.dumps(attrs_arg)]

    result = subprocess.run(send_cmd, capture_output=True, text=True)

    if result.returncode == 0:
        # Delete from DLQ
        del_cmd = [
            'aws', 'sqs', 'delete-message',
            '--queue-url', dlq_url,
            '--receipt-handle', receipt,
            '--region', region
        ]
        subprocess.run(del_cmd, capture_output=True, text=True)
        new_id = result.stdout.strip()
        print(f'  Redriven: {msg_id[:12]}... -> {new_id[:12]}...')
        redriven += 1
    else:
        print(f'  FAILED:   {msg_id[:12]}... ({result.stderr.strip()[:80]})')
        failed += 1

print(f'COUNTS:{redriven}:{failed}')
" 2>/dev/null | while IFS= read -r line; do
      if [[ "$line" == COUNTS:* ]]; then
        batch_ok=$(echo "$line" | cut -d: -f2)
        batch_fail=$(echo "$line" | cut -d: -f3)
        redriven=$((redriven + batch_ok))
        failed=$((failed + batch_fail))
      else
        echo "$line"
      fi
    done

    redriven=$((redriven + msg_count))

    # If we got fewer than requested, DLQ is likely empty
    if [[ "$msg_count" -lt "$fetch_count" ]]; then
      break
    fi
  done

  echo ""
  new_dlq_depth=$(get_queue_depth "$DLQ_URL")
  new_main_depth=$(get_queue_depth "$MAIN_QUEUE_URL")
  echo -e "  ${BOLD}After redrive:${RESET}"
  echo -e "    DLQ depth:  ${CYAN}${new_dlq_depth}${RESET}"
  echo -e "    Main depth: ${CYAN}${new_main_depth}${RESET}"
  echo ""
  exit 0
fi

# ===========================================================================
# ACTION: purge - Remove all messages from DLQ
# ===========================================================================
if [[ "$ACTION" == "purge" ]]; then
  dlq_depth=$(get_queue_depth "$DLQ_URL")

  echo -e "\n${BOLD}============================================================${RESET}"
  echo -e "${BOLD}  Purge: ${TARGET_DLQ}${RESET}"
  echo -e "${BOLD}============================================================${RESET}"
  echo -e "  DLQ depth: ${CYAN}${dlq_depth}${RESET}"
  echo ""

  if [[ "$dlq_depth" == "0" ]]; then
    echo -e "  ${GREEN}DLQ is already empty.${RESET}"
    echo ""
    exit 0
  fi

  echo -e "  ${RED}${BOLD}WARNING: This will permanently delete ALL ${dlq_depth} messages from ${TARGET_DLQ}.${RESET}"
  read -rp "  Type the DLQ name to confirm: " confirm
  if [[ "$confirm" != "$TARGET_DLQ" ]]; then
    echo -e "  ${YELLOW}Aborted. Name did not match.${RESET}"
    exit 1
  fi

  aws sqs purge-queue \
    --queue-url "$DLQ_URL" \
    --region "$AWS_REGION" 2>/dev/null

  echo -e "  ${GREEN}Purge initiated. Messages will be deleted within 60 seconds.${RESET}"
  echo ""
  exit 0
fi
