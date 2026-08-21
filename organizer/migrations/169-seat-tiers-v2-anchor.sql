-- =============================================================================
-- 빅뱅 flip — seat_tiers 앵커화 (seat-tiers surface write-through 전환 토대)
-- go seat_tiers 행을 thin 앵커(go id ↔ v2 canonical tier_id 매핑)로 강등.
--
-- 배경:
--   커머스 SoT 가 v2 로 이전됨에 따라 seat_tiers 행은 더 이상 가격/재고 정본이 아니다.
--   다만 워크플로/좌석맵 FK(seats.tier_id, seat_maps 등)가 seat_tiers.id 를 참조하므로
--   go seat_tiers 행 자체는 **유지**한다(삭제 금지).
--   대신 v2 canonical tier_id 를 v2_tier_id 에 보관하여 후속 write-through 호출의 앵커로 쓴다.
--
-- 이 마이그레이션이 하는 일:
--   1) seat_tiers.v2_tier_id 컬럼 추가 (v2 canonical UUID 보관).
--   2) 역참조/멱등 재호출용 인덱스 추가.
--
-- 안전: 모두 IF EXISTS / IF NOT EXISTS 라 재실행 안전. 실데이터 0건 골든타임 기준.
-- 주의: migrate.ts 러너는 migrations/ 를 readdirSync 비재귀로 수집 → 169- prefix면 자동 실행.
-- =============================================================================

BEGIN;

-- 1) v2 canonical tier_id 앵커 컬럼
ALTER TABLE seat_tiers ADD COLUMN IF NOT EXISTS v2_tier_id UUID;

-- go id ↔ v2 id 역참조 및 멱등 재호출용 인덱스
CREATE INDEX IF NOT EXISTS idx_seat_tiers_v2_tier_id ON seat_tiers (v2_tier_id);

COMMIT;

-- ROLLBACK 가이드: 빅뱅은 PR revert + 이전 이미지 재배포가 롤백.
-- 컬럼만 되돌리려면: ALTER TABLE seat_tiers DROP COLUMN v2_tier_id;
