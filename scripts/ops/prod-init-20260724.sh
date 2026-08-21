#!/usr/bin/env bash
# prod v2 DB 초기화(빈 DB 새 출발) — S5 런북 §2. 일회성.
# 실행:  ADMIN_PASSWORD='...' bash scripts/ops/prod-init-20260724.sh
# 백업: /home/oem/pickket-prod-v2-backup-20260723.sql (유일 롤백수단)
set -euo pipefail

REPO=/home/oem/Development/active/pickket-v3
cd "$REPO"
set -a; source scripts/ops/backup.env; set +a
: "${PG_V2_URL:?PG_V2_URL 미설정(backup.env 확인)}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD 를 env로 전달: ADMIN_PASSWORD='...' bash $0}"
PROD="$PG_V2_URL"
PROD_ASYNC="postgresql+asyncpg://${PROD#postgresql://}"

echo "== 백업 파일 확인 =="
ls -la /home/oem/pickket-prod-v2-backup-20260723.sql

echo "== 현재 데이터(참고 — 폐기가능 판별 완료, 게이트 아님) =="
psql "$PROD" -tAc "SELECT 'events='||count(*) FROM events" 2>/dev/null || echo "  (events 테이블 없음/이미 초기화)"

echo ""
echo "== 1) DROP SCHEMA public CASCADE + CREATE =="
psql "$PROD" -v ON_ERROR_STOP=1 -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
echo "  ✅ 스키마 초기화"

echo ""
echo "== 2) alembic upgrade head → unify8_0723 =="
cd "$REPO/platform/backend"
DATABASE_URL_SYNC="$PROD" .venv/bin/alembic upgrade head
echo "  head 도달: $(psql "$PROD" -tAc 'SELECT version_num FROM alembic_version')"

echo ""
echo "== 3) 부트스트랩(super_admin + 기본 fee) =="
# prod backend 는 실제로 ENVIRONMENT=staging 으로 구동 중(CapRover 확인) → 그 설정과 일치.
ENVIRONMENT=staging DATABASE_URL="$PROD_ASYNC" \
  ADMIN_EMAIL="admin@pickket.kr" ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  .venv/bin/python scripts/seed_bootstrap.py

echo ""
echo "== 4) 검증 =="
psql "$PROD" -c "SELECT (SELECT version_num FROM alembic_version) AS head, (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM users WHERE is_admin) AS admins, (SELECT count(*) FROM fee_schedules) AS fees;"
echo ""
echo "== ✅ DB 초기화 완료 — 다음: 앱 배포(v2 backend → organizer → consumer) =="
