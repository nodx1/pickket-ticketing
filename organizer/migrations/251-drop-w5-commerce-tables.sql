-- 251: 상거래 부가기능 6표 DROP (레벨2 컷오버 wave5 **W5-COMMERCE**)
--
-- 🔴 **organizer 배포 후에만 적용한다.**
--    이 마이그레이션은 아직 코드가 읽고 있는 표를 지운다. 배포 전에 먼저 적용하면
--    프로모코드·단체예약·번들·가격규칙·환불정책 화면이 즉시 500 으로 죽는다.
--    순서: (1) v2 alembic `w5com_0727` 적용 → (2) organizer 배포 → (3) 이 마이그레이션.
--
-- 배경
--   go DB 완전 제거 컷오버. 아래 6표의 정본이 전부 v2 로 옮겨졌고, organizer/src 의
--   실 SQL 은 0 건이다(테스트/주석 제외 grep 실측).
--
-- | go 테이블 | v2 대응 | 비고 |
-- |---|---|---|
-- | promo_codes          | discount_codes (기존)        | go 는 thin 앵커였다. 화면 id = v2 discount_code_id |
-- | group_bookings       | group_bookings (신설)        | 상태 전이를 v2 가 FOR UPDATE 로 원자 집행 |
-- | product_bundle_items | seat_tiers.bundle_items JSONB| **이원화 해소** — W2-PS 이후 v2 에도 쓰이고 있었다 |
-- | pricing_rules        | tier_pricing_rules (신설)    | 티어 스코프 |
-- | price_history        | tier_price_history (신설)    | go 는 writer 0 이었다 — v2 는 티어 가격 변경 시 실제 기록 |
-- | refund_policies      | event_refund_policies (신설) | go 는 writer 0 이었다 — v2 에 write 경로 신설 |
--
-- 데이터 보존
--   prod 는 전면 초기화 예정이므로 **백필하지 않는다**(최종형). 이 DROP 은 되돌릴 수 없다.
--
-- 재실행 안전: DROP TABLE IF EXISTS + CASCADE(자식 FK 동반 정리).

BEGIN;

-- price_history 가 pricing_rules 를 참조하므로 자식부터. CASCADE 로 순서 무관하게 안전.
DROP TABLE IF EXISTS price_history CASCADE;
DROP TABLE IF EXISTS pricing_rules CASCADE;
DROP TABLE IF EXISTS product_bundle_items CASCADE;
DROP TABLE IF EXISTS group_bookings CASCADE;
DROP TABLE IF EXISTS refund_policies CASCADE;
DROP TABLE IF EXISTS promo_codes CASCADE;

COMMIT;
