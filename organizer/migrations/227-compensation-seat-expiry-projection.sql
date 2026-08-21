-- 227: seat-expiry 환불 보상을 결제 보상 큐로 통합(레벨2 재감사 P0-2).
--
-- 배경: order-finalize 의 좌석검증 실패(결제완료 후 좌석 홀드 만료 race)는 지금까지
--   go completed→refunded 를 즉시 투영하고 refund_requests(pending) 만 남긴 채 COMMIT 했다.
--   외부 환불(Toss cancel/v2 refundOrder)을 부르는 워커가 없어 PG 는 캡처된 채 go 만 refunded,
--   v2 는 미확정 = 실돈 유실 + split-brain. 이제 이 경로를 payment_compensation_actions 기반
--   provider별 환불 outbox 로 통합한다.
--
-- 문제: 기존 만료(order expired) 보상은 환불 성공 후 orders 를 status='expired' 조건으로만
--   payment_status='refunded' 로 갱신했다. seat-expiry 는 go 주문이 completed 다. 워커가 어느
--   상태 투영을 해야 하는지 durable 하게 알려면 액션 행에 목표 투영 상태가 있어야 한다.
--
-- 가산적(196~225 불변): 새 컬럼 하나. NULL = 레거시(expired 경로) 동작 보존.
--   'refunded' = seat-expiry 경로 → 환불 성공 후에만 go completed→refunded(상태머신) 투영 + 티켓 취소.

ALTER TABLE payment_compensation_actions
  ADD COLUMN IF NOT EXISTS post_refund_order_status TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'payment_compensation_actions'::regclass
       AND conname = 'ck_payment_compensation_post_refund_status'
  ) THEN
    ALTER TABLE payment_compensation_actions
      ADD CONSTRAINT ck_payment_compensation_post_refund_status
      CHECK (post_refund_order_status IS NULL OR post_refund_order_status IN ('refunded'));
  END IF;
END $$;

COMMENT ON COLUMN payment_compensation_actions.post_refund_order_status IS
  'Go order status to project after a confirmed external refund. NULL = legacy expired-order path (payment_status only, WHERE status=expired). refunded = seat-expiry path (completed->refunded via state machine + attendee cancel cascade).';
