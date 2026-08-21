-- 224: 결제 확정(confirm) v2 write-through 재조정 outbox
--
-- 배경(레벨2 재감사 P1): 결제 확정 4경로(toss confirm route · webhook · order-finalize · reconcile)가
--   go 상태를 먼저 completed 로 바꾸고 v2 confirmOrderPayment 를 catch-and-log 로만 시도한다.
--   v2 confirm 실패 시 "go=completed · v2=payment_required" split-brain 이 발생하고, PG 승인은
--   이미 완료(실돈)라 롤백이 불가능하다 → eventual consistency(outbox) 가 정답.
--
-- 이 outbox 는 confirm 시도 결과를 **go COMMIT 과 동일 트랜잭션에서 기록**한다.
--   핵심 불변식: "orders.status=completed 인데 outbox 행이 없음"이 불가능해진다
--   (outbox 기록 실패 = go 트랜잭션 롤백 = 결제확정 자체가 안 일어남).
--
-- 워커(payment-confirm-worker)와 cron(payment-reconcile) 이 pending/failed 행을 클레임해
--   동일 멱등키(pay-confirm:{orderId})로 재confirm → confirmed 로 수렴. 이중 확정은 v2 멱등이 차단.
--
-- 가산적(IF NOT EXISTS). compensation(196/202) 의 lease/SKIP LOCKED 패턴을 참고했다.

CREATE TABLE IF NOT EXISTS payment_confirm_outbox (
  -- 주문당 정확히 1행. order_id 를 PK 로 삼아 "completed ↔ outbox" 1:1 을 강제한다.
  order_id       UUID PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  v2_order_id    UUID NOT NULL,
  amount         BIGINT NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending',
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 8,
  -- 워커 lease(동시 2회 실행 시 이중 클레임 방지). compensation 과 동일 패턴.
  lease_token    UUID,
  lease_expires_at TIMESTAMPTZ,
  next_retry_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error     TEXT,
  confirmed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_payment_confirm_outbox_status
    CHECK (status IN ('pending', 'confirmed', 'failed', 'manual_review')),
  CONSTRAINT ck_payment_confirm_outbox_amount   CHECK (amount >= 0),
  CONSTRAINT ck_payment_confirm_outbox_attempts CHECK (attempts >= 0)
);

-- 워커/cron 이 스캔하는 미확정 행만 좁게 인덱싱(부분 인덱스).
-- confirmed 행(대다수)은 인덱스에서 제외 → 스캔 비용 최소.
CREATE INDEX IF NOT EXISTS ix_payment_confirm_outbox_due
  ON payment_confirm_outbox (next_retry_at)
  WHERE status = 'pending';

-- failed(영구 실패 후보) 도 cron 이중안전망이 재시도하므로 인덱싱.
CREATE INDEX IF NOT EXISTS ix_payment_confirm_outbox_failed
  ON payment_confirm_outbox (next_retry_at)
  WHERE status = 'failed';

-- 레거시 백필(P1 재감사): 224 적용 이전에 이미 completed 된 v2 앵커 주문은 outbox 행이 없다.
--   pending-first 재배선에서는 confirm 이 워커/cron drain 에만 의존하므로, 224 이전 completed
--   주문이 outbox 없이 남으면 v2 확정이 **영구 누락**된다. 따라서 224 적용 시점에 그 주문들을
--   pending outbox 로 일회성 백필해 drain 대상에 포함시킨다.
--   (가산·멱등: ON CONFLICT DO NOTHING — 이미 행이 있으면 손대지 않는다. 재실행 안전.)
--   reconcile 도 구형 스캐너를 병행하지만(런타임 안전망), 마이그 시점 백필이 가장 확실하다.
INSERT INTO payment_confirm_outbox (order_id, v2_order_id, amount, status, attempts, next_retry_at)
SELECT o.id, o.v2_order_id::uuid, GREATEST(COALESCE(o.total_amount, 0)::bigint, 0), 'pending', 0, NOW()
  FROM orders o
 WHERE o.status = 'completed'
   AND o.v2_order_id IS NOT NULL
ON CONFLICT (order_id) DO NOTHING;
