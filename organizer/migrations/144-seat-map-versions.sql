-- 트랙 2.11 — 좌석맵 버저닝 (저장 시 스냅샷, 복원 가능)
--
-- 빌더에서 "저장" 시마다 좌석 배치 + 랜드마크 + 등급 상태를 JSONB 스냅샷.
-- 최근 30개만 유지 (스크립트에서 오래된 것 정리).
-- audit_logs 와 별도 — audit 는 단일 상태 변경, 여기는 전체 스냅샷.

CREATE TABLE IF NOT EXISTS seat_map_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  seat_map_id     UUID NOT NULL REFERENCES seat_maps(id) ON DELETE CASCADE,
  version         INT NOT NULL,
  snapshot        JSONB NOT NULL,
  note            TEXT NULL,
  created_by      UUID NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_seat_map_versions_map_version UNIQUE (seat_map_id, version)
);

CREATE INDEX IF NOT EXISTS idx_seat_map_versions_map_created
  ON seat_map_versions(seat_map_id, created_at DESC);

COMMENT ON TABLE seat_map_versions IS
  '좌석맵 버전 스냅샷 (최근 30개 유지). 빌더에서 "복원" 가능.';
COMMENT ON COLUMN seat_map_versions.snapshot IS
  '{ seats: [...], landmarks: [...], tiers: [...], background: {...} }';
