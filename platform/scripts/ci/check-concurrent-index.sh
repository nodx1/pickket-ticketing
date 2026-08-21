#!/usr/bin/env bash
set -euo pipefail

# 신규 마이그레이션에서 CONCURRENTLY 없는 CREATE INDEX를 감지한다.
# 기존 마이그레이션(이미 프로덕션 적용)은 건너뛴다.
# 기준: main 브랜치 대비 현재 브랜치에서 추가된 마이그레이션 파일만 검사.
# CI에서는 PR diff, 로컬에서는 main..HEAD diff 사용.

MIGRATIONS_DIR="backend/alembic/versions"
BASE_BRANCH="${GITHUB_BASE_REF:-main}"
ERRORS=0

# main 브랜치가 로컬에 있는지 확인
if ! git rev-parse --verify "$BASE_BRANCH" >/dev/null 2>&1; then
  echo "SKIP: Base branch '$BASE_BRANCH' not found, skipping check"
  exit 0
fi

NEW_FILES=$(git diff --diff-filter=A --name-only "$BASE_BRANCH"...HEAD -- "${MIGRATIONS_DIR}/*.py" 2>/dev/null || true)

if [ -z "$NEW_FILES" ]; then
  echo "PASS: No new migration files to check"
  exit 0
fi

echo "Checking new migrations (vs $BASE_BRANCH) for non-concurrent index creation..."

for f in $NEW_FILES; do
  [ -f "$f" ] || continue
  [[ "$f" == *__pycache__* ]] && continue

  if grep -qP 'create_index|CREATE\s+INDEX|CREATE\s+UNIQUE\s+INDEX' "$f"; then
    if ! grep -qP 'CONCURRENTLY|concurrently' "$f"; then
      echo "ERROR: $f has CREATE INDEX without CONCURRENTLY"
      ERRORS=$((ERRORS + 1))
    fi
  fi
done

if [ "$ERRORS" -gt 0 ]; then
  echo "FAIL: $ERRORS migration(s) missing CONCURRENTLY"
  echo "Hint: use op.execute('CREATE INDEX CONCURRENTLY ...') instead of op.create_index()"
  exit 1
fi

echo "PASS: All new migrations use CONCURRENTLY for indexes (or have no indexes)"
