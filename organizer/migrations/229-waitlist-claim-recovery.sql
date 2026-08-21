-- 229: 대기자 claim 앵커 기록(claim-commit) 실패 복구 큐
--
-- 배경(레벨2 재감사 P1): 공개 claim 라우트(app/api/public/waitlist/[entryId]/claim)가
--   3-phase(claim-begin → createOrder → claim-commit)로 대기건을 주문으로 전환한다.
--   기존 코드는 claim-commit(converted_order_id 앵커 기록) 실패를 catch-and-log 로만 삼키고
--   201 성공을 반환했다. 그 결과:
--     - waitlist=converted 이면서 converted_order_id=NULL 로 잔류(앵커 유실).
--     - 재-claim 시 claim-begin 이 이미 converted 라 already_claimed=false → 409(재시도 불가).
--     - 주문(order)은 생성됐으나 entry 와의 연결이 끊겨 orphan(추적 불가).
--   즉 "주문은 존재하나 대기건은 그 사실을 모름" = go↔v2 split-brain.
--
-- 이 복구 큐는 claim-commit 이 최종 실패했을 때 (entry_id, order_id) 를 기록해
--   재조정 워커/cron 이 동일 멱등키로 claim-commit 을 재시도(converted_order_id 앵커 수렴)하게 한다.
--   불변식: "converted 인데 converted_order_id=NULL" 상태의 entry 는 반드시 이 큐에 행이 있어야 한다
--   (claim 라우트가 앵커 확인 실패 시 이 행 기록 후 502 반환 → 성공응답은 앵커 확인 후에만).
--
-- 안 하면 생기는 일: 대기자가 결제창까지 갔는데 주최자 대기열엔 여전히 offered/converted-미앵커로
--   보여 이중발권·주문 유실·"구매했는데 대기중 표기" CS 폭증.
--
-- 가산적(IF NOT EXISTS). 224 payment_confirm_outbox 의 lease/재시도 패턴을 참고했다.

CREATE TABLE IF NOT EXISTS waitlist_claim_recovery (
  -- entry 당 정확히 1행. entry_id 를 PK 로 삼아 "converted-미앵커 ↔ recovery" 1:1 을 강제한다.
  entry_id       UUID PRIMARY KEY,
  -- claim 라우트가 생성에 성공한 go 주문 id(앵커 대상). 이 값으로 claim-commit 을 재시도.
  order_id       UUID NOT NULL,
  -- 관측/집계용 경계 스냅샷(account/event). 크로스테넌트 조회 방지.
  account_id     UUID,
  event_id       UUID,
  status         TEXT NOT NULL DEFAULT 'pending',
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 8,
  -- 워커 lease(동시 2회 실행 시 이중 클레임 방지). 224 와 동일 패턴.
  lease_token    UUID,
  lease_expires_at TIMESTAMPTZ,
  next_retry_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error     TEXT,
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_waitlist_claim_recovery_status
    CHECK (status IN ('pending', 'resolved', 'failed', 'manual_review')),
  CONSTRAINT ck_waitlist_claim_recovery_attempts CHECK (attempts >= 0)
);

-- 재조정 워커/cron 이 스캔하는 미해결 행만 좁게 인덱싱(부분 인덱스).
CREATE INDEX IF NOT EXISTS ix_waitlist_claim_recovery_due
  ON waitlist_claim_recovery (next_retry_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS ix_waitlist_claim_recovery_failed
  ON waitlist_claim_recovery (next_retry_at)
  WHERE status = 'failed';
