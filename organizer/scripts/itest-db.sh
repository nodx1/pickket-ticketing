#!/usr/bin/env bash
# 통합테스트용 일회용 go PostgreSQL 준비/정리 (T8).
#
# 왜 필요한가 — 기존 테스트층의 사각지대:
#   · v2 pytest 는 SQLite(`conftest.py` TEST_DATABASE_URL="sqlite+aiosqlite://")
#   · organizer vitest 는 `vi.mock("@/lib/db/pool")` — SQL 이 아예 실행되지 않음
#   ⟹ NOT NULL·UNIQUE·FK·CHECK·트랜잭션 격리에 걸리는 결함은 **원리적으로 잡히지 않는다**.
#      실제로 T4 의 `next_retry_at NOT NULL` 위반(23502)이 prod 에서야 발견됐다.
#
# 이 스크립트는 **실 PostgreSQL** 에 일회용 DB 를 만들고 go 마이그레이션 전량을 적용한다.
# prod 는 건드리지 않는다(로컬 도커 PG 전용).
#
# 사용법:
#   bash scripts/itest-db.sh up      # DB 생성 + 마이그레이션
#   bash scripts/itest-db.sh down    # DB 삭제
#   bash scripts/itest-db.sh env     # export 문 출력 (eval "$(bash scripts/itest-db.sh env)")
#   npm run test:integration
set -euo pipefail

ITEST_DB="${ITEST_DB:-pickket_go_itest}"
ITEST_HOST="${ITEST_HOST:-127.0.0.1}"
ITEST_PORT="${ITEST_PORT:-5434}"          # 로컬 도커 pickket-go-postgres
ITEST_USER="${ITEST_USER:-pickket}"
ITEST_CONTAINER="${ITEST_CONTAINER:-pickket-go-postgres}"

# 비밀번호는 하드코딩하지 않는다 — 컨테이너 env 에서 읽거나 ITEST_PASSWORD 로 주입.
if [ -z "${ITEST_PASSWORD:-}" ]; then
  ITEST_PASSWORD="$(docker inspect "$ITEST_CONTAINER" \
    --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | grep '^POSTGRES_PASSWORD=' | cut -d= -f2- || true)"
fi
if [ -z "$ITEST_PASSWORD" ]; then
  echo "❌ ITEST_PASSWORD 를 얻지 못했습니다. 환경변수로 주입하거나 도커 컨테이너($ITEST_CONTAINER)를 확인하세요." >&2
  exit 1
fi
export PGPASSWORD="$ITEST_PASSWORD"

# 🔴 prod 오폭 차단 — 이 스크립트는 DROP DATABASE 를 돈다.
#    DB 이름 규약(`itest`)만으로는 부족하다. ITEST_HOST/PORT 가 무검증 오버라이드였기 때문에
#    `ITEST_HOST=192.168.0.9 ITEST_PORT=15433` 만 주면 prod 클러스터에서 그대로 실행됐다
#    (재검수 지적). 루프백 외 호스트는 거부한다.
case "$ITEST_HOST" in
  127.0.0.1|localhost|::1) ;;
  *) echo "❌ 안전장치: 통합테스트는 루프백 호스트에서만 실행합니다 (요청: $ITEST_HOST)" >&2; exit 1;;
esac

psql_admin() { psql -h "$ITEST_HOST" -p "$ITEST_PORT" -U "$ITEST_USER" -d postgres -v ON_ERROR_STOP=1 "$@"; }

case "${1:-up}" in
  up)
    # prod 오폭 방지 — 이름 규약을 강제한다.
    case "$ITEST_DB" in *itest*) ;; *) echo "❌ 안전장치: ITEST_DB 이름에 'itest' 가 있어야 합니다 ($ITEST_DB)" >&2; exit 1;; esac
    # 🔴 사용 중인 DB 를 끊지 않는다. `DROP DATABASE ... WITH (FORCE)` 는 열린 커넥션을
    #    **강제 종료**하므로, 다른 세션(사람·CI·에이전트)이 테스트 중이면 그 실행을 통째로
    #    깨뜨린다. 재검수 중 실제로 발생했다:
    #      error: database "pickket_go_itest" does not exist
    #        ❯ Module.resetTables src/test/itest-harness.ts
    #    같은 코드가 실행마다 다른 실패 수를 내는 비결정성의 원인이었다.
    ACTIVE=$(psql_admin -tAc "SELECT count(*) FROM pg_stat_activity WHERE datname = '$ITEST_DB';" | tr -d ' ')
    if [ "${ACTIVE:-0}" != "0" ]; then
      echo "❌ '$ITEST_DB' 에 활성 커넥션 ${ACTIVE}개 — 다른 실행이 사용 중일 수 있습니다." >&2
      echo "   동시에 돌리려면 각자 다른 이름을 쓰세요:  ITEST_DB=pickket_go_itest_\$USER bash scripts/itest-db.sh up" >&2
      exit 1
    fi
    echo "▶ 일회용 DB 재생성: $ITEST_DB @ $ITEST_HOST:$ITEST_PORT"
    psql_admin -tAc "DROP DATABASE IF EXISTS $ITEST_DB WITH (FORCE);" >/dev/null
    psql_admin -tAc "CREATE DATABASE $ITEST_DB;" >/dev/null
    echo "▶ go 마이그레이션 적용 (migrations/*.sql 전량)"
    PG_HOST="$ITEST_HOST" PG_PORT="$ITEST_PORT" PG_USER="$ITEST_USER" \
      PG_PASSWORD="$ITEST_PASSWORD" PG_DATABASE="$ITEST_DB" \
      npx tsx scripts/migrate.ts 2>&1 | tail -5
    echo "✅ 준비 완료. eval \"\$(bash scripts/itest-db.sh env)\" 후 npm run test:integration"
    ;;
  down)
    case "$ITEST_DB" in *itest*) ;; *) echo "❌ 안전장치: ITEST_DB 이름에 'itest' 가 있어야 합니다" >&2; exit 1;; esac
    psql_admin -tAc "DROP DATABASE IF EXISTS $ITEST_DB WITH (FORCE);" >/dev/null
    echo "🧹 삭제 완료: $ITEST_DB"
    ;;
  env)
    # ⚠️ eval 용이라 stdout 으로 내보낼 수밖에 없다. 터미널 로그·CI 아티팩트에 남지 않도록
    #    `eval "$(bash scripts/itest-db.sh env)"` 형태로만 쓰고, 출력을 파일로 남기지 말 것.
    echo "export PG_HOST=$ITEST_HOST PG_PORT=$ITEST_PORT PG_USER=$ITEST_USER PG_DATABASE=$ITEST_DB"
    echo "export PG_PASSWORD='$ITEST_PASSWORD'"
    echo "export PICKKET_ITEST=1"
    ;;
  *)
    echo "사용법: $0 {up|down|env}" >&2; exit 1;;
esac
