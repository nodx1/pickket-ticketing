-- tier 별 FCFS 자동 전환 추적.
--
-- point_lottery 로 시작한 tier 가 v2 의 payment_expiry 태스크에 의해
-- 대기자 소진 + 조건 충족 시 fixed_fcfs 로 자동 전환될 때 시각 기록.
-- v2 → go webhook (/api/v2-webhook/events/{id}/fcfs-converted) 수신 시 업데이트.
--
-- go 에서는 이 컬럼을 주최자 대시보드에 "선착순 전환됨" 뱃지 + 전환 시각 표시용으로 사용.

ALTER TABLE seat_tiers
  ADD COLUMN IF NOT EXISTS fcfs_converted_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_seat_tiers_fcfs_converted
  ON seat_tiers (event_id) WHERE fcfs_converted_at IS NOT NULL;

COMMENT ON COLUMN seat_tiers.fcfs_converted_at IS
  'point_lottery → fixed_fcfs 자동 전환 시각. v2 Celery payment_expiry 태스크가 대기자 소진 조건 충족 시 webhook 으로 알림.';
