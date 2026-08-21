-- =============================================================================
-- 빅뱅 flip — promo_codes 앵커화 (할인코드 surface write-through 전환 토대)
-- go promo_codes 행을 thin 앵커(go id ↔ v2 canonical discount code_id 매핑)로 강등.
--
-- 배경:
--   할인 적용 SoT 가 v2 로 이전됨에 따라 promo_codes 행은 더 이상 할인율/한도 정본이 아니다.
--   go promo_codes = v2 discount_codes 로 upsert(commerce-client.upsertDiscountCodes)되며,
--   v2 canonical code_id 를 v2_code_id 에 보관하여 주문 시 v2 할인 적용(OrderCreate.discount.code_id)의
--   앵커로 쓴다. go 의 promo_type/discount_value 는 폼/표시용 미러로 보존(가격 계산은 v2 SoT).
--
-- 매핑(코드 레벨):
--   go promo_type 'fixed'      → v2 discount_type 'fixed'      (amount = discount_value)
--   go promo_type 'percentage' → v2 discount_type 'percentage' (rate   = discount_value)
--
-- 주의:
--   promo_codes.discount_type 컬럼(migration 112)은 이와 무관한 분류(code/member/card/...)이며,
--   v2 discount_type(percentage|fixed)와 다른 의미축이다. 혼동 금지. 본 앵커는 v2_code_id 만 추가.
--
-- 이 마이그레이션이 하는 일:
--   1) promo_codes.v2_code_id 컬럼 추가 (v2 canonical discount code UUID 보관).
--   2) 역참조/멱등 재호출용 인덱스 추가.
--
-- 안전: 모두 IF NOT EXISTS 라 재실행 안전. 실데이터 0건 골든타임 기준.
-- 주의: migrate.ts 러너는 migrations/ 를 readdirSync 비재귀로 수집 → 175- prefix면 자동 실행.
-- =============================================================================

BEGIN;

-- 1) v2 canonical discount code_id 앵커 컬럼
ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS v2_code_id UUID;

-- go id ↔ v2 id 역참조 및 멱등 재호출용 인덱스
CREATE INDEX IF NOT EXISTS idx_promo_codes_v2_code_id ON promo_codes (v2_code_id);

COMMENT ON COLUMN promo_codes.v2_code_id IS 'v2 canonical discount code UUID (write-through 앵커). 주문 시 v2 할인 적용 키.';

COMMIT;

-- ROLLBACK 가이드: 빅뱅은 PR revert + 이전 이미지 재배포가 롤백.
-- 컬럼만 되돌리려면: ALTER TABLE promo_codes DROP COLUMN v2_code_id;
