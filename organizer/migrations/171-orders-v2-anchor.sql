-- =============================================================================
-- 빅뱅 flip — orders/attendees 앵커화 (W3.2 주문 write-through 전환 토대)
-- go orders 행을 thin 앵커(go id ↔ v2 canonical order_id)로 강등.
-- go attendees 는 워크플로(answers/체크인로그)라 go-local 유지하되 v2 ticket_id 로 키잉.
--
-- 배경:
--   주문 원자성(orders+order_items+tickets+discount+sold_count+seats hold→sold)의 SoT 가
--   v2 로 이전됨(POST /api/v1/internal/orders 단일 트랜잭션). go createOrder 는 더 이상
--   6테이블을 직접 쓰지 않고 v2 write-through 후 응답으로:
--     - go orders 행 1개를 thin 앵커로 기록(id ↔ v2_order_id, external_order_id=go order id 멱등앵커).
--     - go attendees 를 v2 응답 ticket_id 로 키잉해 answers/체크인 워크플로 보존.
--
-- 이 마이그레이션이 하는 일:
--   1) orders.v2_order_id 컬럼 추가 (v2 canonical order UUID 보관 = write-through 앵커).
--   2) attendees.v2_ticket_id 컬럼 추가 (v2 ticket_id 로 attendee 키잉 → 체크인 write-through 대상).
--   3) v2 가 SoT 인 주문 결제/금액 컬럼들의 NOT NULL/CHECK 완화 → go 앵커 INSERT 가 최소 컬럼만 채워도 되게.
--      (order_number/buyer_name 등 워크플로·대시보드 라벨 컬럼은 NOT NULL 유지)
--
-- 안전: 모두 IF NOT EXISTS / DROP NOT NULL 이라 재실행 안전. 실데이터 0건 골든타임 기준.
-- =============================================================================

BEGIN;

-- 1) v2 canonical order_id 앵커 컬럼 (멱등 재호출 / 환불·취소 write-through 의 키)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS v2_order_id UUID;
CREATE INDEX IF NOT EXISTS idx_orders_v2_order_id ON orders (v2_order_id);

-- 2) v2 ticket_id 로 attendee 키잉 (체크인 write-through 대상 식별 + 라인 매핑)
ALTER TABLE attendees ADD COLUMN IF NOT EXISTS v2_ticket_id UUID;
CREATE INDEX IF NOT EXISTS idx_attendees_v2_ticket_id ON attendees (v2_ticket_id);

-- 3) v2 가 SoT 인 주문 결제 컬럼 완화.
--    go 앵커 INSERT 는 식별·표시에 필요한 컬럼만 확정하고, 결제수단/상태 같은 커머스 상세는
--    v2 가 보관(go status 는 v2 투영 read 로 표시). payment_method/payment_status 의 CHECK 가
--    v2 결제수단(portone 등) 과 어긋날 수 있어 CHECK 제거 → 자유 텍스트 캐시로 강등.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE orders ALTER COLUMN payment_method DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN payment_status DROP NOT NULL;

COMMIT;

-- ROLLBACK 가이드: 빅뱅은 PR revert + 이전 이미지 재배포가 롤백.
-- 컬럼만 되돌리려면:
--   ALTER TABLE orders DROP COLUMN v2_order_id;
--   ALTER TABLE attendees DROP COLUMN v2_ticket_id;
--   (payment_method/payment_status CHECK·NOT NULL 은 원 정의로 재생성)
