#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Migration drift gate (단계6-B) — 모델(SSOT) ↔ DB 스키마 정합 상시 검증
# ---------------------------------------------------------------------------
# "stale DB" 재발 방지. 다음을 보장한다:
#   1) 전체 마이그 체인이 빈 DB에 처음부터 적용된다 (upgrade head)
#   2) 적용 후 모델과 DB 사이에 drift 가 없다 (alembic check = 빈-diff)
#   3) head 마이그가 가역적이다 (downgrade -1 → upgrade head)
#
# 보류 레거시(dutch_*/user_consents_dedup_backup/remainder_dutch)는 env.py
# include_object 에서 의도적으로 제외됨 — cross-request 후 legacy_drop 마이그로 처리.
#
# 사용:
#   scripts/ci/check-migration-drift.sh            # 현재 DATABASE_URL_SYNC 사용
#   DRIFT_FRESH_DB=1 scripts/ci/check-migration-drift.sh   # 빈 DB 재구축부터(로컬/CI)
#
# 요구: backend/.venv, DATABASE_URL_SYNC (backend/.env 또는 환경변수)
# ---------------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR/backend"

ALEMBIC=".venv/bin/alembic"
if [ ! -x "$ALEMBIC" ]; then
  echo "SKIP: $ALEMBIC not found (backend venv 없음)"
  exit 0
fi

echo "[1/4] upgrade head (전체 마이그 체인 적용)..."
$ALEMBIC upgrade head

echo "[2/4] alembic check (모델 ↔ DB 빈-diff)..."
if ! $ALEMBIC check; then
  echo ""
  echo "[FAIL] 모델과 DB 스키마가 어긋났습니다 (drift 발견)."
  echo "       모델 변경 후 마이그를 만들지 않았거나, 마이그가 모델과 불일치합니다."
  echo "       → alembic revision --autogenerate 로 확인하고 reconcile 하세요."
  echo "       (보류 레거시는 env.py LEGACY_PENDING_DROP_* 에서 제외 처리됨)"
  exit 1
fi

echo "[3/4] head 가역성 (downgrade -1 → upgrade head)..."
$ALEMBIC downgrade -1
$ALEMBIC upgrade head
# 가역 후에도 drift 없어야 함 (idempotent)
$ALEMBIC check >/dev/null

echo "[4/4] native ENUM 라벨 정합 (모델 라벨이 DB enum에 존재하는지)..."
# alembic check(구조 diff)는 ADD VALUE 누락을 못 잡으므로 별도 검증.
.venv/bin/python "$ROOT_DIR/scripts/ci/check-enum-labels.py"

echo "[OK] Migration drift gate passed — 모델↔DB 정합, head 가역, enum 라벨 정합 확인."
