#!/usr/bin/env bash
set -euo pipefail

# One-command staging recovery: diagnose the edge, optionally upload current
# working tree to the staging CapRover app, then run HTTP smoke checks.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
npx tsx "$ROOT_DIR/scripts/staging-diagnose.ts" | tee "${STAGING_DIAG_OUTPUT:-/tmp/pickket-staging-diagnose.json}"
if [[ "${STAGING_DEPLOY:-0}" == "1" ]]; then
  "$ROOT_DIR/scripts/caprover-staging-deploy.sh"
fi
if [[ "${STAGING_SMOKE:-0}" == "1" ]]; then
  npx tsx "$ROOT_DIR/scripts/staging-smoke.ts"
fi
