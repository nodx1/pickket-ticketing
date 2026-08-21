-- Phase 1-3: seats.status에 'sold' 값 정식 허용
-- 기존: available | held | reserved | blocked
-- 추가: sold (결제 완료 후 확정)

COMMENT ON COLUMN seats.status IS
  '상태값: available|held|reserved|sold|blocked. sold = 결제 완료 후 확정 (refund 시 available).';

-- 기존 reserved 좌석 중 결제 완료된 주문에 묶인 것은 sold로 백필
UPDATE seats s
SET status = 'sold', updated_at = NOW()
WHERE s.status = 'reserved'
  AND s.reserved_order_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = s.reserved_order_id
      AND o.status = 'completed'
  );
