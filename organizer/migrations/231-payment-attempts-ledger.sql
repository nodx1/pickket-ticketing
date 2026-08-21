-- 231: Toss 결제시도별 durable ledger + payment_reference CAS 근거(레벨2 재감사 P1).
--
-- 배경: toss confirm 라우트가 payment_reference 를 무조건 덮어썼다(UPDATE rowCount 미확인 →
--   외부 PG confirm 실행). orphan scanner 는 orders 의 단일 payment_reference 만 조회한다. 그 결과
--   동시 재시도(같은 orderId, 다른 paymentKey)에서:
--     - 첫 결제키가 둘째 요청에 덮어써짐 → 첫 키로 캡처된 실결제가 추적 불가(orphan scanner 못 찾음)
--     - 어느 한쪽이 completed 되면 orphan scanner 조건(status='pending')에서 제외 → 미회수
--
-- 수정 두 축:
--   (A) orders.payment_reference 는 CAS(payment_reference IS NULL OR = 요청키)로만 쓴다.
--       rowCount=0(=다른 키 선점)이면 외부 PG confirm 을 절대 실행하지 않는다(라우트 코드).
--   (B) 결제시도별 ledger 로 **모든 paymentKey 시도**를 durable 기록해, orphan scanner 가
--       주문당 단일 reference 가 아니라 시도별로 추적·회수할 수 있게 한다.
--
-- 이 마이그는 (B) 의 저장소를 만든다. (order_id, payment_key) UNIQUE 로 같은 키 재시도는 멱등,
--   같은 주문에 다른 키가 오면 새 행이 쌓인다(경합 흔적 보존). captured 여부는 orphan scanner 가
--   provider 조회로 채운다.

CREATE TABLE IF NOT EXISTS payment_attempts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL DEFAULT 'toss',
  payment_key   TEXT NOT NULL,
  amount        BIGINT NOT NULL DEFAULT 0,
  -- 시도 결과 상태(orphan scanner 가 provider 조회로 갱신):
  --   pending    = confirm 착수(외부 승인 결과 미확인)
  --   won        = 이 시도가 orders.payment_reference CAS 를 선점(정본 결제)
  --   captured   = provider 조회 결과 DONE(캡처됨) — orphan 회수 대상 판정에 사용
  --   settled    = 회수/환불 완료(보상큐로 넘어감)
  --   not_captured = provider 조회 결과 미캡처(승인 실패/미완)
  status        TEXT NOT NULL DEFAULT 'pending',
  provider_status TEXT,
  last_looked_up_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_payment_attempts_order_key UNIQUE (order_id, payment_key),
  CONSTRAINT ck_payment_attempts_status
    CHECK (status IN ('pending', 'won', 'captured', 'settled', 'not_captured')),
  CONSTRAINT ck_payment_attempts_amount CHECK (amount >= 0)
);

-- orphan scanner 는 아직 정산 안 된(=회수 미완) 시도만 좁게 스캔한다.
CREATE INDEX IF NOT EXISTS ix_payment_attempts_unsettled
  ON payment_attempts (updated_at)
  WHERE status IN ('pending', 'captured');

CREATE INDEX IF NOT EXISTS ix_payment_attempts_order
  ON payment_attempts (order_id);

COMMENT ON TABLE payment_attempts IS
  'Per-attempt Toss payment ledger. Records every paymentKey tried for an order so the orphan scanner tracks each attempt (not just the single orders.payment_reference), preventing lost captures under concurrent retries.';
