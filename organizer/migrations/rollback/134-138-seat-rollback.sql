-- Phase 1 rollback: 134-138 좌석 시스템 마이그레이션 되돌리기
-- 사용: psql ... -f migrations/rollback/134-138-seat-rollback.sql
-- 주의: 이미 데이터가 있는 경우 손실 발생 가능

BEGIN;

-- 138: audit 트리거 제거
DROP TRIGGER IF EXISTS trg_log_seat_change ON seats;
DROP FUNCTION IF EXISTS log_seat_change();

-- 137: products 컬럼 제거
ALTER TABLE products
  DROP COLUMN IF EXISTS resale_allowed,
  DROP COLUMN IF EXISTS resale_max_price,
  DROP COLUMN IF EXISTS allow_group_tickets,
  DROP COLUMN IF EXISTS max_group_size;

-- 136: status 'sold' 백필 되돌리기 (sold → reserved)
UPDATE seats SET status = 'reserved', updated_at = NOW() WHERE status = 'sold';

-- 135: seats v2 컬럼 제거
DROP INDEX IF EXISTS idx_seats_tier_id;
DROP INDEX IF EXISTS idx_seats_status_tier;
DROP INDEX IF EXISTS idx_seats_quality_score;
DROP INDEX IF EXISTS idx_seats_hold_id;

ALTER TABLE seats
  DROP COLUMN IF EXISTS tier_id,
  DROP COLUMN IF EXISTS x,
  DROP COLUMN IF EXISTS y,
  DROP COLUMN IF EXISTS quality_score,
  DROP COLUMN IF EXISTS label,
  DROP COLUMN IF EXISTS is_obstructed,
  DROP COLUMN IF EXISTS hold_id,
  DROP COLUMN IF EXISTS hold_token;

-- 134: seat_tiers 테이블 삭제
DROP TABLE IF EXISTS seat_tiers CASCADE;

-- schema_migrations에서 적용 기록 제거
DELETE FROM schema_migrations WHERE filename IN (
  '134-seat-tiers.sql',
  '135-seats-v2-fields.sql',
  '136-seats-status-sold.sql',
  '137-products-resale-fields.sql',
  '138-seat-audit-trigger.sql'
);

COMMIT;
