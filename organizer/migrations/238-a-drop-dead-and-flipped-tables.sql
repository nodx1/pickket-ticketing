-- 238-a: 레벨2 컷오버 T2-REST 1단계 — **코드 SQL 참조 0** 인 go 테이블 폐기.
--
-- ── 대상 선정 근거 (착수 시점 리포 전수 grep 재확인, migrations/ 제외) ──
-- 아래 8개는 `organizer/src` · `platform/apps` 어디에서도 SQL 로 읽거나 쓰지 않는다.
-- 확인 명령:
--   grep -rEIn '(FROM|JOIN|INTO|UPDATE|TABLE|EXISTS)[[:space:]]+(public\.)?<t>\b' organizer/src platform/apps
--
--  (1) 완전 사장(dead) — 기능 자체가 구현된 적 없거나 폐기됨
--   · email_templates                 mig004. 발송 템플릿은 message_templates/알림톡 템플릿 코드로 대체됨.
--   · fraud_rules                     mig100. 룰 엔진 미구현(주문의 fraud_score 는 코드 상수 기반).
--   · product_categories              mig003. 상품 카테고리 UI/라우트 없음.
--   · queue_jobs                      mig093. 잡 큐는 cron 라우트 + Redis 로 대체(코드 참조 0).
--
--  (2) 이미 v2 로 flip 완료 — go 테이블은 읽지 않는 잔재
--   · business_verifications          → v2 정본. go 는 `src/lib/v2/business-verification-client.ts` 경유.
--   · business_verification_documents   (v2 alembic bizverif_0724 + app/models/business_verification.py)
--   · phone_verifications             → v2 인증 전담. `api/auth/phone/{send,verify}-otp` 는 v2 프록시(주석 명시).
--   · settlements                     → v2 정본. go 는 `src/lib/settlement/v2-fetcher.ts` + /admin/settlements API.
--
-- ── DROP 순서: FK 리프 → 루트 ──
-- business_verification_documents.verification_id → business_verifications(id) 이므로 자식 먼저.
-- 나머지는 서로 참조 관계가 없다.
--
-- ── CASCADE 의 부수효과 (의도된 것) ──
-- products.category_id → product_categories(id) FK 가 함께 사라진다(mig003).
-- **컬럼은 남고 FK 제약만 사라진다**. products 는 ORD 트랙 소관이며 어차피 폐기 대상이라 무해하다.
--
-- ── 재실행 안전성 ──
-- IF EXISTS + CASCADE. 이미 없는 환경(신규 DB)에서도 no-op.
--
-- ── 롤백 ──
-- 되돌리려면 원 마이그(004/100/003/093/215/115/072)의 CREATE TABLE 을 재실행한다.
-- 단 **데이터는 복구되지 않는다**. (2) 그룹은 v2 가 이미 정본이므로 go 쪽 행은 스테일 사본이다.

-- 1) v2 flip 완료분 — 자식 먼저
DROP TABLE IF EXISTS business_verification_documents CASCADE;
DROP TABLE IF EXISTS business_verifications CASCADE;
DROP TABLE IF EXISTS phone_verifications CASCADE;
DROP TABLE IF EXISTS settlements CASCADE;

-- 2) 완전 사장 테이블
DROP TABLE IF EXISTS email_templates CASCADE;
DROP TABLE IF EXISTS fraud_rules CASCADE;
DROP TABLE IF EXISTS queue_jobs CASCADE;
DROP TABLE IF EXISTS product_categories CASCADE;
