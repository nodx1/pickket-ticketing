-- 196: 만료 주문에 도착한 결제확정의 보상 큐
--
-- 결제 승인(v2)과 로컬 주문 만료 사이의 정상적인 race를 금전 유실 없이 수렴시킨다.
-- 웹훅 트랜잭션은 로컬 주문을 completed로 되돌리지 않고 이 durable action만 기록하며,
-- payment-reconcile/보상 워커가 v2 환불 API를 멱등키로 처리한다.

CREATE TABLE IF NOT EXISTS payment_compensation_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  v2_order_id UUID NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_delivery_id UUID,
  requested_amount BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_reference TEXT,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_payment_compensation_order_action UNIQUE (order_id, action),
  CONSTRAINT ck_payment_compensation_action CHECK (action IN ('refund')),
  CONSTRAINT ck_payment_compensation_status CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  CONSTRAINT ck_payment_compensation_amount CHECK (requested_amount >= 0),
  CONSTRAINT ck_payment_compensation_attempts CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS ix_payment_compensation_due
  ON payment_compensation_actions(status, next_attempt_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS ix_payment_compensation_order
  ON payment_compensation_actions(order_id);
