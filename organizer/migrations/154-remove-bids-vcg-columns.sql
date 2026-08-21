-- VCG 경매 레거시 컬럼 제거.
--
-- DOMAIN_MODEL_STANDARD (v3) 에서 VCG 경매는 금지어로 지정됐고,
-- 2026-04-12 기준 point_lottery 로 완전히 대체됨.
-- v2 에서 go bids 테이블 직접 참조하지 않음 확인 (v2 Claude 답변 2026-04-22).
--
-- 제거 대상:
--   max_willingness_to_pay  — VCG 입찰가 (팬이 최대 지불 의사 금액)
--   vcg_price               — VCG 2위 가격 (이론가)
--   final_price             — VCG 최종 지불가
--   effective_weight        — 팬 가중치 (v2 엔진이 자체 계산, go 는 결과만 수신)
--   fan_scores              — 5차원 팬 점수 (v2 엔진 내부 관심사)
--
-- 유지:
--   id, session_id, user_id, quantity, status, desired_tier_id,
--   won_seat_ids, expires_at, order_id,
--   waitlist_rank, waitlist_expires_at, promoted_at,
--   created_at, updated_at

-- 인덱스 먼저 정리 (컬럼 삭제 전)
DROP INDEX IF EXISTS idx_bids_effective_weight;

-- 컬럼 제거
ALTER TABLE bids DROP COLUMN IF EXISTS max_willingness_to_pay;
ALTER TABLE bids DROP COLUMN IF EXISTS vcg_price;
ALTER TABLE bids DROP COLUMN IF EXISTS final_price;
ALTER TABLE bids DROP COLUMN IF EXISTS effective_weight;
ALTER TABLE bids DROP COLUMN IF EXISTS fan_scores;

COMMENT ON TABLE bids IS
  '공정 추첨 응모 기록. v2 엔진(compute_lottery_weight)이 실제 가중치/당첨 계산 담당. go 는 결과 미러링 + 좌석 배정 트리거 + 대기자 승격만.';
