#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-northeast-2}"
ECS_CLUSTER="${ECS_CLUSTER:?ECS_CLUSTER must be set}"
ECS_SERVICE="${ECS_SERVICE:-pickket-backend}"
ECS_CONTAINER_NAME="${ECS_CONTAINER_NAME:-backend}"
AWS_RUN_COMMAND="${AWS_RUN_COMMAND:?AWS_RUN_COMMAND must be set}"

for bin in aws jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[ERROR] missing required command: $bin" >&2
    exit 1
  fi
done

echo "[INFO] Resolving ECS service metadata: ${ECS_SERVICE}"
service_json="$(aws ecs describe-services \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER" \
  --services "$ECS_SERVICE" \
  --output json)"

task_def="$(echo "$service_json" | jq -r '.services[0].taskDefinition // empty')"
network_config="$(echo "$service_json" | jq -c '.services[0].networkConfiguration // empty')"

if [[ -z "$task_def" || -z "$network_config" ]]; then
  echo "[ERROR] failed to resolve task definition or network config for ${ECS_SERVICE}" >&2
  exit 1
fi

# 새 이미지로 마이그레이션할 때 task-def 오버라이드 지원
if [[ -n "${OVERRIDE_TASKDEF:-}" ]]; then
  echo "[INFO] Using override task definition: ${OVERRIDE_TASKDEF}"
  task_def="$OVERRIDE_TASKDEF"
fi

overrides="$(jq -nc \
  --arg name "$ECS_CONTAINER_NAME" \
  --arg cmd "$AWS_RUN_COMMAND" \
  '{containerOverrides:[{name:$name,command:["sh","-lc",$cmd]}]}')"

echo "[INFO] Running one-off command on ${ECS_SERVICE}: ${AWS_RUN_COMMAND}"
run_output="$(aws ecs run-task \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER" \
  --task-definition "$task_def" \
  --launch-type FARGATE \
  --network-configuration "$network_config" \
  --overrides "$overrides" \
  --started-by "github-actions-${GITHUB_RUN_ID:-manual}" \
  --output json)"

failure_reason="$(echo "$run_output" | jq -r '.failures[0].reason // empty')"
if [[ -n "$failure_reason" ]]; then
  echo "[ERROR] ECS run-task failed: ${failure_reason}" >&2
  echo "$run_output" | jq .
  exit 1
fi

task_arn="$(echo "$run_output" | jq -r '.tasks[0].taskArn // empty')"
if [[ -z "$task_arn" ]]; then
  echo "[ERROR] ECS run-task did not return a taskArn" >&2
  echo "$run_output" | jq .
  exit 1
fi

echo "[INFO] Waiting for task to stop: ${task_arn}"
aws ecs wait tasks-stopped \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER" \
  --tasks "$task_arn"

task_json="$(aws ecs describe-tasks \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER" \
  --tasks "$task_arn" \
  --output json)"

exit_code="$(echo "$task_json" | jq -r \
  --arg name "$ECS_CONTAINER_NAME" \
  '.tasks[0].containers[] | select(.name == $name) | .exitCode // empty')"
reason="$(echo "$task_json" | jq -r \
  --arg name "$ECS_CONTAINER_NAME" \
  '.tasks[0].containers[] | select(.name == $name) | .reason // empty')"

if [[ -z "$exit_code" ]]; then
  echo "[ERROR] failed to resolve exit code for container ${ECS_CONTAINER_NAME}" >&2
  echo "$task_json" | jq .
  exit 1
fi

if [[ "$exit_code" != "0" ]]; then
  echo "[ERROR] one-off task failed with exit code ${exit_code}" >&2
  if [[ -n "$reason" ]]; then
    echo "[ERROR] container reason: ${reason}" >&2
  fi
  echo "$task_json" | jq .
  exit 1
fi

echo "[SUCCESS] one-off task completed successfully"
