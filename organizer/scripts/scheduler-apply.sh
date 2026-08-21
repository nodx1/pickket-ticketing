#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENVIRONMENT="${SCHEDULER_ENVIRONMENT:-staging}"
KUSTOMIZE_DIR="$ROOT_DIR/infra/cron/overlays/$ENVIRONMENT"
if [[ "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "production" ]]; then
  echo "SCHEDULER_ENVIRONMENT must be staging or production" >&2
  exit 2
fi
if [[ "$ENVIRONMENT" == "production" && "${ALLOW_PRODUCTION_SCHEDULER:-}" != "1" ]]; then
  echo "production scheduler apply requires ALLOW_PRODUCTION_SCHEDULER=1" >&2
  exit 2
fi

npx tsx "$ROOT_DIR/scripts/validate-scheduler.ts"
command -v kubectl >/dev/null || { echo "kubectl not found" >&2; exit 2; }
kubectl config current-context >/dev/null || { echo "kubectl context is not configured" >&2; exit 2; }
[[ -d "$KUSTOMIZE_DIR" ]] || { echo "scheduler overlay missing: $KUSTOMIZE_DIR" >&2; exit 2; }
if [[ "${SCHEDULER_DRY_RUN:-1}" == "1" ]]; then
  exec kubectl apply --dry-run=server -k "$KUSTOMIZE_DIR"
fi
exec kubectl apply -k "$KUSTOMIZE_DIR"
