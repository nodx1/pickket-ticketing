-- 공정 추첨 "대기자 자동 승격" 확장.
--
-- 기존 lottery → fcfs_residual 2단 시퀀스를
-- lottery → waitlist_promotion → fcfs_residual(조건부) 3단으로 확장.
--
-- 핵심 설계:
--   1. lottery 실행 시 응모자 > 좌석이면 미당첨자에게 waitlist_rank 부여 (랜덤 순번).
--   2. 당첨자 결제 미완료/취소 시 대기 1순위에게 좌석 자동 할당 + 24h 결제창.
--   3. 대기 리스트 소진 후에도 좌석이 남으면 fcfs_residual 오픈 (비인기 이벤트 케이스).
--
-- "수요 > 공급" 에만 공정 메커니즘이 작동하고 "수요 ≤ 공급" 일 땐 선착순으로 풀림.

-- 1. bids 에 대기 순번 + 대기 만료 시각 추가
ALTER TABLE bids
  ADD COLUMN IF NOT EXISTS waitlist_rank INT NULL;

ALTER TABLE bids
  ADD COLUMN IF NOT EXISTS waitlist_expires_at TIMESTAMPTZ NULL;

ALTER TABLE bids
  ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ NULL;

-- 대기자 자동 승격 시 seat_id 할당 전에 "할당 대기 중" 표시하기 위한 상태.
-- 기존 CHECK constraint 에 'waitlisted' 추가.
ALTER TABLE bids DROP CONSTRAINT IF EXISTS bids_status_check;
ALTER TABLE bids ADD CONSTRAINT bids_status_check
  CHECK (status IN ('pending', 'won', 'lost', 'cancelled', 'waitlisted'));

-- 대기 1순위 빠른 조회용 인덱스 (phase 당 가장 낮은 rank 찾기)
CREATE INDEX IF NOT EXISTS idx_bids_waitlist_rank
  ON bids (session_id, waitlist_rank)
  WHERE status = 'waitlisted' AND waitlist_rank IS NOT NULL;

-- 2. sale_phases.mode 에 'waitlist_promotion' 추가
ALTER TABLE sale_phases DROP CONSTRAINT IF EXISTS sale_phases_mode_check;
ALTER TABLE sale_phases ADD CONSTRAINT sale_phases_mode_check
  CHECK (mode IN (
    'membership_presale',
    'lottery',
    'waitlist_promotion',
    'queue_sale',
    'fcfs_residual'
  ));

-- 3. phase_order 범위 확장 (1~4 → 1~5)
ALTER TABLE sale_phases DROP CONSTRAINT IF EXISTS sale_phases_order_positive;
ALTER TABLE sale_phases ADD CONSTRAINT sale_phases_order_positive
  CHECK (phase_order >= 1 AND phase_order <= 5);

COMMENT ON COLUMN bids.waitlist_rank IS
  '추첨 미당첨자에게 부여되는 대기 순번 (1=첫 승격 대상). NULL 이면 대기 리스트 밖(완전 탈락).';
COMMENT ON COLUMN bids.waitlist_expires_at IS
  '승격된 대기자의 결제 마감 시각 (기본 24h). 만료 시 다음 대기자로 자동 이월.';
COMMENT ON COLUMN bids.promoted_at IS
  '대기자에서 당첨으로 승격된 시각. status=won + waitlist_rank IS NOT NULL + promoted_at IS NOT NULL 조합으로 식별.';
