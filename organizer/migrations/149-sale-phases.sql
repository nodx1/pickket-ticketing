-- 판매 단계(sale_phases) 도입 — docs/architecture/SALE_MODE_POLICY_v2 준수
--
-- 한 이벤트는 1~4개의 판매 단계를 순서대로 거친다:
--   membership_presale(팬클럽) → lottery(공정추첨) → queue_sale(대기열) → fcfs_residual(잔여선착순)
--
-- 미소화 좌석은 다음 단계로 자동 이월. FCFS_RESIDUAL 은 항상 마지막.
-- 기존 allocation_sessions 는 phase 의 자식으로 편입.

CREATE TABLE IF NOT EXISTS sale_phases (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id             UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  phase_order          INT NOT NULL,
  mode                 TEXT NOT NULL,
  opens_at             TIMESTAMPTZ NOT NULL,
  closes_at            TIMESTAMPTZ NULL,
  target_quantity      INT NULL,
  allocated_quantity   INT NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'scheduled',
  config               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sale_phases_mode_check
    CHECK (mode IN ('membership_presale','lottery','queue_sale','fcfs_residual')),
  CONSTRAINT sale_phases_status_check
    CHECK (status IN ('scheduled','open','closed','allocating','allocated','skipped')),
  CONSTRAINT sale_phases_order_positive
    CHECK (phase_order >= 1 AND phase_order <= 4),
  CONSTRAINT sale_phases_closes_after_opens
    CHECK (closes_at IS NULL OR closes_at > opens_at),
  UNIQUE (event_id, phase_order)
);

CREATE INDEX IF NOT EXISTS idx_sale_phases_event_status
  ON sale_phases (event_id, status);

CREATE INDEX IF NOT EXISTS idx_sale_phases_opens_at
  ON sale_phases (opens_at) WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_sale_phases_closes_at
  ON sale_phases (closes_at) WHERE status = 'open' AND closes_at IS NOT NULL;

-- 기존 allocation_sessions 에 sale_phase_id FK + 정규화된 tier_id 컬럼 추가
ALTER TABLE allocation_sessions
  ADD COLUMN IF NOT EXISTS sale_phase_id UUID NULL REFERENCES sale_phases(id) ON DELETE SET NULL;

ALTER TABLE allocation_sessions
  ADD COLUMN IF NOT EXISTS tier_id UUID NULL REFERENCES seat_tiers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_allocation_sessions_phase
  ON allocation_sessions (sale_phase_id);

-- bids 에 희망 구역(tier) 저장 — 추첨 후 좌석 배정 시 사용
ALTER TABLE bids
  ADD COLUMN IF NOT EXISTS desired_tier_id UUID NULL REFERENCES seat_tiers(id) ON DELETE SET NULL;

-- 기존 이벤트 전부에 기본 fcfs_residual 단일 phase 생성 (마이그레이션 안전장치)
-- 이미 phase 가 있으면 SKIP
INSERT INTO sale_phases (
  account_id, event_id, phase_order, mode,
  opens_at, closes_at, target_quantity, status
)
SELECT
  e.account_id,
  e.id,
  1,
  'fcfs_residual',
  COALESCE(e.starts_at - INTERVAL '14 days', NOW()),
  e.starts_at,
  NULL,
  CASE WHEN e.status = 'live' THEN 'open' ELSE 'scheduled' END
FROM events e
WHERE NOT EXISTS (
  SELECT 1 FROM sale_phases sp WHERE sp.event_id = e.id
);

COMMENT ON TABLE sale_phases IS
  '판매 단계 시퀀스. docs/architecture/SALE_MODE_POLICY_v2 준수. 미소화 시 다음 phase 로 이월.';
COMMENT ON COLUMN sale_phases.target_quantity IS
  'NULL 이면 이전 phase 의 미소화 분 전부를 이월 받음 (fcfs_residual 의 기본 동작).';
COMMENT ON COLUMN sale_phases.allocated_quantity IS
  '해당 phase 에서 실제 배정/판매된 수. closePhase 시 확정되어 다음 phase target 계산에 사용.';
