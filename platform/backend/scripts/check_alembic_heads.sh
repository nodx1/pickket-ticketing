#!/usr/bin/env bash
set -e
HEADS=$(alembic heads 2>&1 | grep -c '(head)' || echo 0)
if [ "$HEADS" -ne 1 ]; then
  echo "ERROR: alembic has $HEADS heads (expected 1). Run 'alembic merge heads'."
  exit 1
fi
echo "OK: single alembic head"
