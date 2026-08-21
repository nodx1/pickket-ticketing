-- =============================================================================
-- 감사 P1-15 — orders.v2_order_id UNIQUE (중복 앵커 방지 + 멱등 재시도)
--
-- 배경: v2 canonical order 1건당 go 앵커(orders 행)는 정확히 1개여야 한다. 기존엔 비유니크
--   인덱스(idx_orders_v2_order_id)만 있어, createOrder 재시도/동시호출 시 같은 v2_order_id 로
--   복수 앵커·고아행이 생길 수 있었다(정합 붕괴 + 상태전파 대상 모호).
--
-- 조치: 비유니크 인덱스를 UNIQUE 로 교체(조회 인덱스 겸용). UNIQUE 인덱스에서 NULL 은 서로
--   distinct 하므로, v2 앵커 없는 레거시/직접 주문(v2_order_id IS NULL)은 다중 허용된다.
--   orders.ts 의 INSERT 는 `ON CONFLICT (v2_order_id) DO NOTHING` 으로 멱등 재진입한다.
--
-- 주의: 기존에 중복 v2_order_id 가 있으면 UNIQUE 생성이 실패한다. 런칭 전 신규 DB 는 무관하나,
--   기존 DB 적용 시 아래로 중복 확인:
--     SELECT v2_order_id, count(*) FROM orders WHERE v2_order_id IS NOT NULL
--       GROUP BY v2_order_id HAVING count(*) > 1;
-- =============================================================================

DROP INDEX IF EXISTS idx_orders_v2_order_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_v2_order_id
  ON orders (v2_order_id);
