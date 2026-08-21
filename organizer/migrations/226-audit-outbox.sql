-- 226: go 고유 감사(audit) 트랜잭션 아웃박스
--
-- 배경(레벨2 코덱스 재감사 P1):
--   감사 정본은 v2(AuditLog)로 이관됐고 대부분의 go 감사쓰기는 async HTTP(lib/audit.ts)로
--   프록시된다. 그러나 아래 4곳은 상태변경과 **동일 트랜잭션에서** audit_logs 에 직접 INSERT
--   하고 있었다(트랜잭션 결합이 규제상 필수 — 상태변경과 감사기록이 원자적이어야 함):
--     ① lib/seats/audit.ts       (seat hold/release/sold/force_release)
--     ② lib/webhooks/replay.ts   (DLQ replay 감사)
--     ③ admin/payment-compensations/[actionId]/route.ts (환불 보상 조작 감사)
--     ④ admin/message-deliveries/[deliveryId]/route.ts  (발송 복구 조작 감사)
--   이들은 async v2 HTTP 로 옮기면 "상태는 커밋됐는데 감사는 유실"이 가능해진다
--   (외부호출 후 crash / 동시성). → **트랜잭션 아웃박스**가 정답:
--     같은 txn 에서 audit_outbox 로 INSERT(상태변경과 원자적 커밋) → 워커/cron 이 v2
--     /internal/audit-logs 로 드레인. 상태변경이 커밋되면 아웃박스 행도 반드시 존재하고,
--     롤백되면 아웃박스 행도 사라진다 → 감사 유실 불가(규제 무결성).
--
--   seats/audit 의 기존 "실패삼킴(catch→warn)"도 이 아웃박스로 정정된다: 아웃박스 INSERT 는
--   호출자 txn 의 일부라 실패하면 상위 트랜잭션이 롤백(감사 유실 대신 작업 실패) — 조용한 유실 없음.
--
-- 멱등/동시성:
--   - 드레인은 lease_token + FOR UPDATE SKIP LOCKED 로 이중 클레임을 차단(동시 2회 실행 안전).
--   - v2 audit write 는 append-only(중복행 무해) 라 "외부호출 후 crash → 재드레인"이 안전하다.
--     내부적으로 dedup_key(UNIQUE)를 두어 정상경로 중복 POST 도 방지한다.
--
-- 가산적(IF NOT EXISTS). payment_confirm_outbox(224)·compensation lease 패턴을 참고.

CREATE TABLE IF NOT EXISTS audit_outbox (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- v2 /internal/audit-logs 계약(AuditLogIn)과 1:1 매핑되는 페이로드 필드.
  action         TEXT NOT NULL,
  table_name     TEXT NOT NULL,
  account_id     UUID,
  user_id        UUID,
  record_id      TEXT,
  changes        JSONB,
  ip_address     TEXT,
  -- 정상경로 중복 방지(재시도로 인한 append 중복은 무해하나, 애플리케이션 double-enqueue 차단).
  -- 호출부가 안정 키를 넘기면 UNIQUE 로 흡수, 없으면 NULL(중복허용 — 관측데이터라 무해).
  dedup_key      TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 10,
  lease_token    UUID,
  lease_expires_at TIMESTAMPTZ,
  next_retry_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error     TEXT,
  delivered_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_audit_outbox_status
    CHECK (status IN ('pending', 'delivered', 'failed', 'dead')),
  CONSTRAINT ck_audit_outbox_attempts CHECK (attempts >= 0)
);

-- dedup_key 가 있는 행만 UNIQUE(부분 유니크 인덱스) — NULL 은 중복허용.
CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_outbox_dedup
  ON audit_outbox (dedup_key)
  WHERE dedup_key IS NOT NULL;

-- 드레인 스캐너가 보는 미전송 행만 좁게 인덱싱(부분 인덱스). delivered(대다수)는 제외.
CREATE INDEX IF NOT EXISTS ix_audit_outbox_due
  ON audit_outbox (next_retry_at)
  WHERE status IN ('pending', 'failed');
