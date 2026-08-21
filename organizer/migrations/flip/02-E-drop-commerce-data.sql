-- =============================================================================
-- DRAFT — 빅뱅 flip E단계 (자동실행 안 됨: migrations/flip/ 서브폴더)
-- B8 앵커 모델: 커머스 테이블 전량 DROP이 아니라 **데이터 컬럼 강등 + 2테이블만 DROP**.
-- ⚠️ flip-gate green(B1~B8 + 소비자 좌석구매 풀E2E + v2 #1/#5) 후에만 적용. DROP은 비가역 → 백업 필수.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1) 실제 DROP 테이블 (2개) — read가 v2로 전환 완료된 후에만
--    ⚠️ 게이트: order_items = v2 #1(단건주문 read) 완료 + B3 완성 후.
--               settlements = v2 #5(정산 read/write) 완료 + go settlements 라우트 위임 후.
-- ─────────────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS order_items CASCADE;   -- ← v2 #1 + B3 완성 전 주석유지
-- DROP TABLE IF EXISTS settlements CASCADE;    -- ← v2 #5 + settlements 위임 전 주석유지

-- ─────────────────────────────────────────────────────────────────────────
-- 2) 앵커 테이블 — DROP 안 함(워크플로 FK·v2 id 매핑·라우팅 보관소로 생존).
--    커머스 데이터 컬럼은 v2 SoT라 stale 캐시. 비차단이므로 즉시 DROP 불요.
--    (선택) 명백한 비-SoT 컬럼만 후속 정리. 현재는 stale 허용(읽기는 전부 v2 live).
--    events(title/dates/venue) · products(price/stock/sale_mode) · seat_tiers(capacity/base_price)
--    · seats(status) · orders(status/amounts) · promo_codes(rule) · affiliates
--    → 이 컬럼들은 v2가 SoT. go 코드는 더 이상 read 안 함(D/B-series 전환 완료).
-- ─────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────
-- 3) 모순 마이그 폐기: flip/01-workflow-rekey-v2-event-id.sql 은 full-drop 전제.
--    앵커 모델은 events.id FK 유지하므로 재키잉 불필요 → 01 적용 금지(폐기).
-- ─────────────────────────────────────────────────────────────────────────

COMMIT;

-- ROLLBACK 가이드: 빅뱅=단일 PR revert + 이전 이미지 재배포. 앵커 테이블 생존이라 go 데이터 손실 0.
-- DROP된 order_items/settlements는 v2 SoT라 go 손실 없음(v2가 정본 보유).
