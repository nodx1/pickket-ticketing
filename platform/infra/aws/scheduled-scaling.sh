#!/usr/bin/env bash
# Scheduled Scaling for ECS services — pre-warm before ticket open events
#
# Target Tracking autoscaling reacts in 2-5 minutes, which is too slow for
# ticket-open spike traffic (T=0). This script creates scheduled actions to
# pre-warm tasks 5 minutes before event open and scale down 30 minutes after.
#
# Load test baseline: 1 task (512 MCU) ≈ 135 req/s
# Example: 2,700 req/s target → PRE_SCALE_COUNT=20
#
# Usage:
#   ./scheduled-scaling.sh create  <EVENT_OPEN_TIME> [OPTIONS]
#   ./scheduled-scaling.sh delete  <EVENT_ID>        [OPTIONS]
#   ./scheduled-scaling.sh list                       [OPTIONS]
#
# Examples:
#   # Staging: 20 tasks for event at 2026-04-10 14:00 KST
#   ./scheduled-scaling.sh create "2026-04-10T14:00:00" \
#     --cluster pickket-stg --service pickket-stg-backend \
#     --count 20 --env staging --event-id evt_abc123
#
#   # Production: 20 tasks for the same event
#   ./scheduled-scaling.sh create "2026-04-10T14:00:00" \
#     --cluster pickket --service pickket-prod-backend \
#     --count 20 --env production --event-id evt_abc123
#
#   # Production: scale ticket-gateway to 25 tasks
#   ./scheduled-scaling.sh create "2026-04-10T14:00:00" \
#     --cluster pickket --service pickket-prod-ticket-gateway \
#     --count 25 --env production --event-id evt_abc123 \
#     --pre-minutes 10 --post-minutes 60
#
#   # List all scheduled actions
#   ./scheduled-scaling.sh list --env production
#
#   # Delete scheduled actions for an event
#   ./scheduled-scaling.sh delete evt_abc123 --env production
#
set -euo pipefail

REGION="ap-northeast-2"

# Defaults
CLUSTER="pickket"
SERVICE="pickket-prod-backend"
PRE_SCALE_COUNT=20
SCALE_DOWN_COUNT=2
ENVIRONMENT="production"
EVENT_ID=""
PRE_MINUTES=5
POST_MINUTES=30

usage() {
  cat <<'USAGE'
Usage:
  scheduled-scaling.sh create <EVENT_OPEN_TIME> [OPTIONS]
  scheduled-scaling.sh delete <EVENT_ID>        [OPTIONS]
  scheduled-scaling.sh list                     [OPTIONS]

Commands:
  create    Create pre-warm and scale-down scheduled actions
  delete    Remove scheduled actions for a given event ID
  list      List all scheduled scaling actions

Options:
  --cluster NAME        ECS cluster name          (default: pickket)
  --service NAME        ECS service name          (default: pickket-prod-backend)
  --count N             Pre-warm task count       (default: 20)
  --scale-down N        Scale-down task count     (default: 2)
  --env ENV             Environment tag           (default: production)
  --event-id ID         Event identifier          (required for create/delete)
  --pre-minutes N       Minutes before open       (default: 5)
  --post-minutes N      Minutes after open        (default: 30)
  --region REGION       AWS region                (default: ap-northeast-2)
  -h, --help            Show this help

EVENT_OPEN_TIME format: ISO 8601 local time, e.g. "2026-04-10T14:00:00" (KST assumed)
USAGE
  exit 0
}

# -- Parse arguments ----------------------------------------------------------

COMMAND="${1:-}"
[ -z "$COMMAND" ] && usage
shift

case "$COMMAND" in
  create)
    EVENT_OPEN_TIME="${1:-}"
    [ -z "$EVENT_OPEN_TIME" ] && { echo "ERROR: EVENT_OPEN_TIME required"; usage; }
    shift
    ;;
  delete)
    EVENT_ID="${1:-}"
    [ -z "$EVENT_ID" ] && { echo "ERROR: EVENT_ID required"; usage; }
    shift
    ;;
  list) ;;
  -h|--help) usage ;;
  *) echo "ERROR: Unknown command '${COMMAND}'"; usage ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --cluster)       CLUSTER="$2"; shift 2 ;;
    --service)       SERVICE="$2"; shift 2 ;;
    --count)         PRE_SCALE_COUNT="$2"; shift 2 ;;
    --scale-down)    SCALE_DOWN_COUNT="$2"; shift 2 ;;
    --env)           ENVIRONMENT="$2"; shift 2 ;;
    --event-id)      EVENT_ID="$2"; shift 2 ;;
    --pre-minutes)   PRE_MINUTES="$2"; shift 2 ;;
    --post-minutes)  POST_MINUTES="$2"; shift 2 ;;
    --region)        REGION="$2"; shift 2 ;;
    -h|--help)       usage ;;
    *) echo "ERROR: Unknown option '$1'"; usage ;;
  esac
done

RESOURCE_ID="service/${CLUSTER}/${SERVICE}"

# -- Helpers ------------------------------------------------------------------

kst_to_utc() {
  # Convert KST (UTC+9) datetime string to UTC ISO 8601 for AWS
  local kst_time="$1"
  local offset_seconds="$2"  # seconds to add (can be negative)

  # Use date to parse KST and convert to UTC
  # Input: "2026-04-10T14:00:00", treated as KST (UTC+9)
  local epoch
  epoch=$(TZ="Asia/Seoul" date -d "${kst_time}" +%s 2>/dev/null) || {
    echo "ERROR: Cannot parse date '${kst_time}'. Use format: 2026-04-10T14:00:00"
    exit 1
  }

  local adjusted=$(( epoch + offset_seconds ))
  date -u -d "@${adjusted}" +"%Y-%m-%dT%H:%M:%SZ"
}

confirm_scalable_target() {
  echo "  Checking scalable target for ${RESOURCE_ID}..."
  local result
  result=$(aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs \
    --resource-ids "$RESOURCE_ID" \
    --region "$REGION" \
    --query 'ScalableTargets[0].ResourceId' --output text 2>/dev/null || echo "")

  if [ -z "$result" ] || [ "$result" = "None" ]; then
    echo "ERROR: No scalable target found for ${RESOURCE_ID}"
    echo "  Run autoscaling-v2.sh first to register the scalable target."
    exit 1
  fi
}

# -- Commands -----------------------------------------------------------------

cmd_create() {
  if [ -z "$EVENT_ID" ]; then
    echo "ERROR: --event-id is required for create command"
    exit 1
  fi

  echo "=== Scheduled Scaling: Create ==="
  echo "  Environment : ${ENVIRONMENT}"
  echo "  Cluster     : ${CLUSTER}"
  echo "  Service     : ${SERVICE}"
  echo "  Event ID    : ${EVENT_ID}"
  echo "  Event open  : ${EVENT_OPEN_TIME} KST"
  echo "  Pre-warm    : ${PRE_MINUTES}min before → ${PRE_SCALE_COUNT} tasks"
  echo "  Scale-down  : ${POST_MINUTES}min after  → ${SCALE_DOWN_COUNT} tasks"
  echo ""

  confirm_scalable_target

  # Calculate UTC times
  local pre_utc
  pre_utc=$(kst_to_utc "$EVENT_OPEN_TIME" "-$(( PRE_MINUTES * 60 ))")
  local post_utc
  post_utc=$(kst_to_utc "$EVENT_OPEN_TIME" "$(( POST_MINUTES * 60 ))")

  echo "  Pre-warm UTC  : ${pre_utc}"
  echo "  Scale-down UTC: ${post_utc}"
  echo ""

  # Sanitize event ID for action names (only alphanumeric, dash, underscore)
  local safe_id
  safe_id=$(echo "$EVENT_ID" | tr -cd 'a-zA-Z0-9_-')
  local service_short
  service_short=$(echo "$SERVICE" | sed "s/${CLUSTER}-//; s/prod-//; s/stg-//")

  local prewarm_name="prewarm-${safe_id}-${service_short}"
  local scaledown_name="scaledown-${safe_id}-${service_short}"

  # Create pre-warm action
  echo "  Creating pre-warm action: ${prewarm_name}"
  aws application-autoscaling put-scheduled-action \
    --service-namespace ecs \
    --resource-id "$RESOURCE_ID" \
    --scalable-dimension "ecs:service:DesiredCount" \
    --scheduled-action-name "$prewarm_name" \
    --schedule "at(${pre_utc%Z})" \
    --scalable-target-action "MinCapacity=${PRE_SCALE_COUNT},MaxCapacity=${PRE_SCALE_COUNT}" \
    --region "$REGION"

  # Create scale-down action (restore min to SCALE_DOWN_COUNT, let Target Tracking manage)
  echo "  Creating scale-down action: ${scaledown_name}"

  # Look up original max from the scalable target
  local original_max
  original_max=$(aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs \
    --resource-ids "$RESOURCE_ID" \
    --region "$REGION" \
    --query 'ScalableTargets[0].MaxCapacity' --output text 2>/dev/null || echo "20")

  aws application-autoscaling put-scheduled-action \
    --service-namespace ecs \
    --resource-id "$RESOURCE_ID" \
    --scalable-dimension "ecs:service:DesiredCount" \
    --scheduled-action-name "$scaledown_name" \
    --schedule "at(${post_utc%Z})" \
    --scalable-target-action "MinCapacity=${SCALE_DOWN_COUNT},MaxCapacity=${original_max}" \
    --region "$REGION"

  echo ""
  echo "  Done. Actions created:"
  echo "    ${prewarm_name}  → ${pre_utc}"
  echo "    ${scaledown_name} → ${post_utc}"
  echo ""
  echo "  To delete after event:"
  echo "    $0 delete ${EVENT_ID} --cluster ${CLUSTER} --service ${SERVICE} --env ${ENVIRONMENT}"
}

cmd_delete() {
  echo "=== Scheduled Scaling: Delete ==="
  echo "  Event ID: ${EVENT_ID}"
  echo ""

  # Find all scheduled actions matching this event ID
  local actions
  actions=$(aws application-autoscaling describe-scheduled-actions \
    --service-namespace ecs \
    --region "$REGION" \
    --query "ScheduledActions[?contains(ScheduledActionName, '${EVENT_ID}')].{Name:ScheduledActionName,Resource:ResourceId}" \
    --output json 2>/dev/null || echo "[]")

  local count
  count=$(echo "$actions" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

  if [ "$count" -eq 0 ]; then
    echo "  No scheduled actions found for event '${EVENT_ID}'"
    return
  fi

  echo "  Found ${count} action(s) to delete:"

  echo "$actions" | python3 -c "
import sys, json
for a in json.load(sys.stdin):
    print(f\"    {a['Name']} → {a['Resource']}\")
"

  echo ""

  echo "$actions" | python3 -c "
import sys, json
for a in json.load(sys.stdin):
    print(f\"{a['Name']}|{a['Resource']}\")
" | while IFS='|' read -r name resource; do
    echo "  Deleting: ${name}"
    aws application-autoscaling delete-scheduled-action \
      --service-namespace ecs \
      --resource-id "$resource" \
      --scalable-dimension "ecs:service:DesiredCount" \
      --scheduled-action-name "$name" \
      --region "$REGION"
  done

  echo ""
  echo "  Done. All scheduled actions for '${EVENT_ID}' removed."
}

cmd_list() {
  echo "=== Scheduled Scaling: List ==="
  echo "  Environment: ${ENVIRONMENT}"
  echo ""

  aws application-autoscaling describe-scheduled-actions \
    --service-namespace ecs \
    --region "$REGION" \
    --query 'ScheduledActions[*].{Name:ScheduledActionName,Schedule:Schedule,Resource:ResourceId,Min:ScalableTargetAction.MinCapacity,Max:ScalableTargetAction.MaxCapacity}' \
    --output table
}

# -- Dispatch -----------------------------------------------------------------

case "$COMMAND" in
  create) cmd_create ;;
  delete) cmd_delete ;;
  list)   cmd_list ;;
esac
