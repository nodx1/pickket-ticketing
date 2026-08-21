#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="${ROOT_DIR}/backend"

cd "${BACKEND_DIR}"

export PYTHONPATH="${BACKEND_DIR}:${PYTHONPATH:-}"
export SECRET_KEY="${SECRET_KEY:-ci-security-regression-secret-key-0123456789abcdef}"

.venv/bin/pytest \
  app/tests/test_v2_security.py \
  app/tests/test_password_reset.py \
  app/tests/test_health_ops.py \
  app/tests/test_totp_safetix.py \
  app/tests/test_refund_transfer_guard.py \
  app/tests/test_transfers.py \
  --tb=short --cov-fail-under=0 -q
