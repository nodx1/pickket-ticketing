-- Phase 1 cutover (PHASE1-order-api-contract §2): external_order_id 재정의.
--
-- 배경: migration 133 이 external_order_id 를 BIGINT 로 추가했으나(v2 order_id 를 BIGSERIAL
-- 로 가정), 실제 v2 orders.id 는 UUID. 타입 불일치로 v2→go 전파 매칭이 불가능했음(0/29).
-- contract §2: v2 주문 API 응답의 order_id(UUID)를 go 가 external_order_id 에 저장 → 이후
-- v2→go 전파(§4)·state-changed 가 이 UUID 로 매칭.
--
-- 안전성: 이 컬럼은 현재 비어 있음(0건 채워짐, 전파 미배선). 드롭 후 UUID 로 재생성.
-- ⚠️ 적용 시점: checkout→v2 cutover 코드(state-changed 라우트 order_id string화)와 함께 배포.
--    단독 적용 금지 — 코드가 아직 BIGINT 비교를 가정하면 전파 경로가 깨질 수 있음(현재 env-gated).

DROP INDEX IF EXISTS idx_orders_external_order_id;
ALTER TABLE orders DROP COLUMN IF EXISTS external_order_id;
ALTER TABLE orders ADD COLUMN external_order_id UUID;

-- 1:1 매칭 (v2 주문 1건 ↔ go 주문 1건). NULL 은 self-only 미전파분 허용.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_external_order_id
  ON orders(external_order_id) WHERE external_order_id IS NOT NULL;
