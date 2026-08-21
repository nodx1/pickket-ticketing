#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Release gate (production candidate)
# ---------------------------------------------------------------------------
# Required:
# - Full health checks (lint, tests, build, docs, docker compose syntax)
# - Core regression (auth/order/ticket critical path + portal smoke)
#
# Optional:
# - Security gate (set RELEASE_GATE_WITH_SECURITY=1)
# ---------------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_SECURITY="${RELEASE_GATE_WITH_SECURITY:-0}"
START_TS="$(date +%s)"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[ERROR] pnpm is required." >&2
  exit 1
fi

echo "[1/2] Running full health gate..."
(
  cd "$ROOT_DIR"
  pnpm health:full
)

echo "[2/2] Running core regression gate..."
(
  cd "$ROOT_DIR"
  pnpm test:core-regression
)

if [[ "$RUN_SECURITY" == "1" ]]; then
  echo "[extra] Running security gate..."
  (
    cd "$ROOT_DIR"
    pnpm security:gate
  )
else
  echo "[extra] Security gate skipped (set RELEASE_GATE_WITH_SECURITY=1 to enable)."
fi

END_TS="$(date +%s)"
DURATION="$((END_TS - START_TS))"

echo "[OK] Release gate passed in ${DURATION}s."
echo " - health report: docs/status/PROJECT_HEALTH_DASHBOARD.md"
