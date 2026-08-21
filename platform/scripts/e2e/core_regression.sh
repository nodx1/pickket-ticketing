#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Core end-to-end regression gate (lightweight, local/CI friendly)
# ---------------------------------------------------------------------------
# Covers:
# - Auth / order / ticket critical API path
# - Admin page smoke rendering
# - Consumer build integrity
# ---------------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "[1/3] Backend critical flow tests..."
(
  cd "$ROOT_DIR/backend"
  .venv/bin/python -m pytest \
    app/tests/test_auth.py \
    app/tests/test_orders_api.py \
    app/tests/test_tickets_api.py \
    --tb=short -q
)

echo "[2/3] Admin smoke tests..."
(
  cd "$ROOT_DIR"
  pnpm --filter @pickket/admin test
)

echo "[3/3] Consumer build..."
(
  cd "$ROOT_DIR"
  pnpm --filter @pickket/consumer build
)

echo "[OK] Core regression gate passed."
