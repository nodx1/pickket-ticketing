-- 179: orders.payment_reference UNIQUE (웹훅 중복 결제확정 방어 — 감사 P2)
--
-- 서로 다른 두 주문이 같은 PG payment_reference 를 주장하는(=하나의 실결제를 이중 귀속) 상황을
-- DB 레벨에서 차단한다. 웹훅 idempotency(P0-3)가 중복 "배송"을 막지만, 이 인덱스는 중복 "귀속"을
-- 추가로 막는 방어선이다(non-null 부분 유니크).
--
-- ⚠️ 배포 안전: 기존 데이터에 payment_reference 중복이 있으면 UNIQUE 생성이 실패해 배포(migrate &&
-- server)를 깨뜨릴 수 있으므로, 중복 존재 시 인덱스 생성을 건너뛰고 NOTICE 만 남긴다(수동 정리 후 재적용).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM orders
    WHERE payment_reference IS NOT NULL
    GROUP BY payment_reference
    HAVING COUNT(*) > 1
    LIMIT 1
  ) THEN
    RAISE NOTICE 'payment_reference 중복 존재 → UNIQUE 인덱스 생성 건너뜀(중복 정리 후 재적용 필요)';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_payment_reference
      ON orders(payment_reference) WHERE payment_reference IS NOT NULL;
    -- 기존 non-unique 인덱스(159)는 유니크로 대체되므로 제거.
    DROP INDEX IF EXISTS idx_orders_payment_reference;
  END IF;
END $$;
