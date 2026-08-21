#!/usr/bin/env bash
# 참석자 sweep ↔ repair 경합 — **실 PostgreSQL 두 세션**으로 재현한다.
#
# 🔴 왜 필요한가 (2026-07-31 감사)
# 단위테스트는 pool 을 목킹하고 SQL 을 **문자열로만** 검사한다. 그래서 SQL 에
# `AND FALSE` 를 넣어 완전히 무력화해도 문자열 조각만 남으면 **전부 그린**이다.
# 실제로 감사가 그 뮤테이션 7종을 살려 보였다. 목킹으로는 SQL 계약을 증명할 수 없다.
#
# 그리고 이 경합은 **동시성**이라 한 세션으로는 재현조차 안 된다:
#   sweep : 만료 주문의 참석자를 cancelled 로
#   repair: 같은 주문을 completed 로 되돌리고 참석자를 confirmed 로
# 둘이 겹치면 "주문 completed · 참석자 cancelled" 가 남고, 대사는 completed 를 안 보므로
# **복구 경로가 없는 영구 불일치**가 된다(원사고 재현).
#
# ⚠️ **이 스크립트의 한계를 먼저 밝힌다.** 적대감사는 종전 조인 구현
# (`UPDATE attendees ... FROM orders`)이 EPQ 특성으로 뚫린다고 지적했으나,
# 이 시나리오에서는 **조인 버전도 PASS** 했다(최소 재현 실험에서도 동일).
# 즉 이 테스트는 두 구현을 **구분하지 못한다** — "조인이 깨진다" 는 미확인이다.
#
# 그래도 남겨 둔다: 지금 구현(주문행 FOR UPDATE 선점)이 **경합 상황에서 실제로
# 안전한지**는 증명하기 때문이다. 구분하지 못한다는 사실 자체를 적어 두지 않으면,
# 다음 사람이 이 PASS 를 "조인 대비 우월함이 증명됐다" 로 잘못 읽는다.
#
# 사용법:
#   bash organizer/scripts/verify/sweep-repair-race-pg.sh
# 전부 ROLLBACK 한다. prod 로는 실행하지 않는다(로컬 컨테이너 고정).

set -euo pipefail

PW="$(docker exec pickket-go-postgres env | grep POSTGRES_PASSWORD | cut -d= -f2)"
export PGPASSWORD="$PW"
PSQL="psql -h 127.0.0.1 -p 5434 -U pickket -d pickket_go_e2e -X -q -A -t"

# prod 오염 방지 — 로컬 컨테이너가 아니면 실행하지 않는다.
docker ps --format '{{.Names}}' | grep -qx pickket-go-postgres || {
  echo "🔴 로컬 go DB 컨테이너가 없다. prod 로는 실행하지 않는다."; exit 1; }

FIFO=$(mktemp -u); mkfifo "$FIFO"
OUT=$(mktemp)

cleanup() { rm -f "$FIFO" "$OUT"; }
trap cleanup EXIT

echo "=== 픽스처 생성 ==="
IDS=$($PSQL <<'SQL'
INSERT INTO orders (id, account_id, event_id, order_number, status, total_amount,
                    buyer_name, buyer_email, buyer_phone, v2_order_id, expires_at,
                    created_at, updated_at)
-- 🔴 기준선 DB(pickket_go_e2e)는 **데이터 0건**이다. 기존 행에서 account_id·event_id 를
--    빌려오면 NOT NULL 위반으로 죽는다. 픽스처는 자립해야 한다.
--    (accounts·events 로의 FK 가 없어 임의 UUID 로 성립한다 — attendees→orders 만 FK.)
SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
       'ORD-RACE-TEST', 'expired', 15000, '경합테스트', 'race@test.local', '01000000000',
       gen_random_uuid(), NOW() - INTERVAL '1 hour', NOW(), NOW()
RETURNING id;
SQL
)
ORDER_ID=$(echo "$IDS" | head -1)
$PSQL -c "INSERT INTO attendees (id, account_id, event_id, order_id, ticket_number, name,
                                 email, phone, status, created_at, updated_at)
          SELECT gen_random_uuid(), o.account_id, o.event_id, o.id, 'TKT-RACETEST',
                 '경합참석자', 'race@test.local', '01000000000', 'cancelled', NOW(), NOW()
            FROM orders o WHERE o.id = '$ORDER_ID';" >/dev/null
echo "  주문 $ORDER_ID (expired · 참석자 cancelled)"

echo
echo "=== 세션 A: repair — 주문을 잠그고 completed 로, 참석자 복원 ==="
(
  $PSQL <<SQL
BEGIN;
-- repairOrderToPaid 와 같은 순서: 주문행을 먼저 잠근다
SELECT status FROM orders WHERE id = '$ORDER_ID' FOR UPDATE;
UPDATE orders SET status='completed', expires_at=NULL, updated_at=NOW()
 WHERE id='$ORDER_ID' AND status IN ('pending','expired');
UPDATE attendees SET status='confirmed', updated_at=NOW()
 WHERE order_id='$ORDER_ID' AND status IN ('cancelled','pending');
SELECT pg_sleep(2);   -- 이 사이에 세션 B 가 들어온다
COMMIT;
SQL
) &
A_PID=$!

sleep 0.5

echo "=== 세션 B: sweep — 지금 구현대로 주문행을 FOR UPDATE 로 잠그고 참석자 취소 시도 ==="
(
  $PSQL <<SQL
BEGIN;
-- expire-orders 의 sweep 과 동일: 주문행을 먼저 잠근다(=A 가 커밋할 때까지 대기)
CREATE TEMP TABLE _locked AS
SELECT id FROM orders
 WHERE status='expired' AND updated_at >= NOW() - INTERVAL '7 days'
 ORDER BY id FOR UPDATE;
UPDATE attendees SET status='cancelled', updated_at=NOW()
 WHERE order_id IN (SELECT id FROM _locked)
   AND status NOT IN ('cancelled','checked_in');
COMMIT;
SQL
) > "$OUT" 2>&1 &
B_PID=$!

wait $A_PID $B_PID || true

echo
echo "=== 판정 ==="
RESULT=$($PSQL -c "SELECT o.status || ' / ' || a.status
                     FROM orders o JOIN attendees a ON a.order_id = o.id
                    WHERE o.id = '$ORDER_ID';")
echo "  주문 / 참석자 = $RESULT"

$PSQL -c "DELETE FROM attendees WHERE order_id='$ORDER_ID';" >/dev/null
$PSQL -c "DELETE FROM orders WHERE id='$ORDER_ID';" >/dev/null
echo "  (픽스처 삭제 완료)"

echo
if [ "$RESULT" = "completed / confirmed" ]; then
  echo "✅ PASS — sweep 이 주문행 잠금에서 대기했고, 커밋 후 'expired' 가 아니라 재검사에 걸려"
  echo "         참석자를 다시 죽이지 않았다."
  exit 0
else
  echo "🔴 FAIL — 기대 'completed / confirmed', 실제 '$RESULT'"
  echo "         sweep 이 복원된 참석자를 재취소했다. 대사가 completed 를 안 보므로"
  echo "         이 상태는 **복구 경로가 없다**."
  exit 1
fi
