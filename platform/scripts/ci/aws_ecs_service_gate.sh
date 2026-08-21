#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-northeast-2}"
ECS_CLUSTER="${ECS_CLUSTER:?ECS_CLUSTER must be set}"
TARGET_SERVICE="${TARGET_SERVICE:-all}"

should_check() {
  local svc="$1"
  [[ "$TARGET_SERVICE" == "all" || "$TARGET_SERVICE" == "$svc" ]]
}

for bin in aws jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[ERROR] missing required command: $bin" >&2
    exit 1
  fi
done

for service in backend consumer admin celery-worker celery-beat; do
  if ! should_check "$service"; then
    continue
  fi

  ecs_service="${service}"
  echo "[INFO] Checking ECS service: ${ecs_service}"

  service_json="$(aws ecs describe-services \
    --region "$AWS_REGION" \
    --cluster "$ECS_CLUSTER" \
    --services "$ecs_service" \
    --output json)"

  status="$(echo "$service_json" | jq -r '.services[0].status // empty')"
  desired="$(echo "$service_json" | jq -r '.services[0].desiredCount // 0')"
  running="$(echo "$service_json" | jq -r '.services[0].runningCount // 0')"
  pending="$(echo "$service_json" | jq -r '.services[0].pendingCount // 0')"
  rollout="$(echo "$service_json" | jq -r '.services[0].deployments[]? | select(.status=="PRIMARY") | .rolloutState // "UNKNOWN"' | head -n1)"

  echo "[INFO] ${ecs_service} status=${status} desired=${desired} running=${running} pending=${pending} rollout=${rollout}"

  if [[ "$status" != "ACTIVE" ]]; then
    echo "[ERROR] ${ecs_service} is not ACTIVE" >&2
    exit 1
  fi
  if [[ "$desired" -lt 1 ]]; then
    echo "[ERROR] ${ecs_service} desiredCount is ${desired}" >&2
    exit 1
  fi
  if [[ "$running" != "$desired" ]]; then
    echo "[ERROR] ${ecs_service} runningCount (${running}) does not match desiredCount (${desired})" >&2
    exit 1
  fi
  if [[ "$pending" != "0" ]]; then
    echo "[ERROR] ${ecs_service} still has pending tasks (${pending})" >&2
    exit 1
  fi
  if [[ -n "$rollout" && "$rollout" != "COMPLETED" ]]; then
    echo "[ERROR] ${ecs_service} primary deployment rolloutState=${rollout}" >&2
    exit 1
  fi
done

echo "[SUCCESS] ECS service gate passed"
