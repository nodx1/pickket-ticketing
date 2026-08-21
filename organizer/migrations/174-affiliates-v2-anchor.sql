-- =============================================================================
-- 빅뱅 flip — affiliates 앵커화 (affiliate surface write-through 전환 토대)
-- go affiliates 행을 thin 앵커(go id ↔ v2 canonical affiliate_id 매핑)로 강등.
--
-- 배경:
--   제휴(affiliate) 정의의 SoT 가 v2 로 이전됨에 따라 affiliates 행은 더 이상
--   commission_rate/code 정본이 아니다. go affiliates = v2 affiliate 로 upsert
--   (commerce-client.upsertAffiliates)되며, v2 canonical affiliate_id 를
--   v2_affiliate_id 에 보관하여 후속 write-through/주문 시 affiliate_ref 의 앵커로 쓴다.
--   다만 워크플로(affiliate_conversions.affiliate_id FK, go-local 집계)가 affiliates.id 를
--   참조하므로 go affiliates 행 자체는 **유지**한다.
--
-- 이 마이그레이션이 하는 일:
--   1) affiliates.v2_affiliate_id 컬럼 추가 (v2 canonical affiliate UUID 보관).
--   2) 역참조/멱등 재호출용 인덱스 추가.
--
-- 안전: 모두 IF NOT EXISTS 라 재실행 안전. 실데이터 0건 골든타임 기준.
-- 주의: migrate.ts 러너는 migrations/ 를 readdirSync 비재귀로 수집 → 174- prefix면 자동 실행.
-- =============================================================================

BEGIN;

-- 1) v2 canonical affiliate_id 앵커 컬럼
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS v2_affiliate_id UUID;

-- go id ↔ v2 id 역참조 및 멱등 재호출용 인덱스
CREATE INDEX IF NOT EXISTS idx_affiliates_v2_affiliate_id ON affiliates (v2_affiliate_id);

COMMIT;

-- ROLLBACK 가이드: 빅뱅은 PR revert + 이전 이미지 재배포가 롤백.
-- 컬럼만 되돌리려면: ALTER TABLE affiliates DROP COLUMN v2_affiliate_id;
