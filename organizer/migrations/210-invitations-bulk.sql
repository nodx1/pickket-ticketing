-- F2 초대권 대량 배포 (PICKKETGO-B2B-EVENT-UPGRADE §4 Phase2 · §12 F2).
-- 가산적(IF NOT EXISTS). 기존 발권/임포트/단건 발권 경로 무영향.
--
-- ⚠️ 테이블명 주의: 기존 `invitations`(001-accounts-users-sessions.sql)는 팀 멤버 초대
--    (email/role/token)용으로 이미 존재한다. B2B 초대권(수신자·티켓 원장)은 스키마가 전혀 달라
--    이름을 `event_invitations` 로 분리한다. `CREATE TABLE IF NOT EXISTS invitations` 로 두면
--    기존 팀-초대 테이블이 존재하므로 no-op 이 되고, 뒤이은 event_id 인덱스에서
--    `column "event_id" does not exist` 로 체인이 깨진다(실 PG go-live 차단 버그).
--
-- 3개 신규 구조 + 1개 컬럼:
--   1) event_invitations    — 수신자·티켓·상태 추적 원장(issued|sent|failed|viewed|checked_in).
--   2) invitation_dispatch  — 비동기 발송 큐(호스트 cron 이 배치 claim → sendAlimtalkBatch).
--   3) events.comp_capacity_cap — comp(초대권) 발권 상한(현 v2 tier 100만 하드코딩 대체 게이트).
--
-- 멱등·중복제거 근거:
--   - event_invitations UNIQUE(event_id, phone_normalized): 같은 이벤트에 같은 전화번호 초대권 1건만.
--     CSV 내부 중복(같은 배치 2회)·재업로드(이미 발권된 phone) 둘 다 ON CONFLICT 로 스킵.
--   - invitation_dispatch: claim-lease(SKIP LOCKED)로 cron 동시 2회 실행에도 이중발송 없음.

-- ── 1) 추적 원장 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  event_id UUID NOT NULL,
  -- 발권 결과 앵커(발권 성공 후 채워짐). attendee 1:1.
  attendee_id UUID,
  ticket_number TEXT,
  -- 수신자.
  recipient_name TEXT NOT NULL,
  phone_normalized TEXT NOT NULL,          -- 숫자만(중복제거 키).
  phone_display TEXT NOT NULL,             -- 입력 원문(발송·표시용).
  admission_day DATE,                      -- F1 daypass 지정일(있으면). allpass/single 은 NULL.
  -- 딥링크 bearer revocation nonce(P0-2). 회수 시 증가 → 구 링크 무효.
  token_version INT NOT NULL DEFAULT 0,
  -- 상태머신: issued → (sent|failed) → viewed → checked_in. 회수 시 revoked.
  status TEXT NOT NULL DEFAULT 'issued',
  failure_reason TEXT,
  sent_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,
  checked_in_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_invitations_status CHECK (
    status IN ('issued', 'sent', 'failed', 'viewed', 'checked_in', 'revoked')
  )
);

-- 중복제거 유일 제약(이벤트·전화 단위). CSV dedup·재업로드 스킵의 DB 집행지점.
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_invitations_event_phone
  ON event_invitations (event_id, phone_normalized);

-- account 경계 목록/집계.
CREATE INDEX IF NOT EXISTS ix_event_invitations_account_event
  ON event_invitations (account_id, event_id, status);

-- 티켓 열람/체크인 훅이 ticket_number 로 역조회.
CREATE INDEX IF NOT EXISTS ix_event_invitations_ticket_number
  ON event_invitations (ticket_number)
  WHERE ticket_number IS NOT NULL;

-- ── 2) 비동기 발송 큐 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invitation_dispatch (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  event_id UUID NOT NULL,
  invitation_id UUID NOT NULL REFERENCES event_invitations(id) ON DELETE CASCADE,
  -- 발송 시 실릴 값(claim 시점에 원장에서 스냅샷). 재시도에도 동일 본문 보장.
  phone TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued → sending → sent | failed
  attempt_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  request_id TEXT,                          -- NCP SENS requestId(배치 단위, 관측용).
  -- claim-lease(SKIP LOCKED) — 동시 cron 이중발송 차단.
  claim_token UUID,
  claim_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_invitation_dispatch_status CHECK (
    status IN ('queued', 'sending', 'sent', 'failed')
  ),
  CONSTRAINT ck_invitation_dispatch_attempt CHECK (attempt_count >= 0)
);

-- 발송 대상 클레임 인덱스(queued + stale sending).
CREATE INDEX IF NOT EXISTS ix_invitation_dispatch_claim
  ON invitation_dispatch (status, created_at);

-- 한 초대당 큐 항목 1개(재발송은 기존 행 재큐잉). 발송큐 이중적재 방지.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invitation_dispatch_invitation
  ON invitation_dispatch (invitation_id);

-- ── 3) comp 발권 용량 캡 ──────────────────────────────────────
-- 현 ensureFreeProduct 는 v2 tier capacity 를 1,000,000 하드코딩한다(rsvp-product.ts).
-- 이벤트별 상한을 두어 대량 초대 발권이 무제한으로 발권되는 것을 막는다.
-- NULL = 무제한(기존 동작 유지, 하위호환).
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS comp_capacity_cap INT;
