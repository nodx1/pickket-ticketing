-- 레벨2 컷오버(스코프A 완전제거) — go 고유 폐기군 DROP.
--   실데이터 0(테스트 대회 1개) 전제 — 파괴적 DROP 이나 손실 무손실. 가산적 규약 예외이나
--   IF EXISTS/CASCADE 로 방어 → 재실행 안전(idempotent).
--   판정 정본: docs/plans/LEVEL2-GO-UNIQUE-DISPOSITION.md (미대응 go 부가기능 폐기).
-- 채번: 224(payment-confirm-outbox)까지 점유 → 225 사용.
--
-- ⚠️ 커머스·좌석·메시징·정산 무영향: 아래는 전부 go 고유 부가기능(마케팅 안내·CS 수렴층)이며
--   개설·판매·체크인·정산 어느 필수경로도 의존하지 않는다.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Discount(안내형 할인 표시, mig128) — 마케팅 텍스트(커머스 아님).
--    코드: events/[eventId]/discounts route + 대시보드 UI + server/events.ts 조회 삭제 완료.
--    실제 할인(주문 적용)은 promo_codes(commerce, v2 write-through)로 별개 — 폐기 대상 아님.
--    필요 시 안내는 events.description 로 대체.
DROP TABLE IF EXISTS discount_info CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Support/CS 수렴층(mig217/218) — 데이터0·미운영·라이브 코드 참조 0.
--    support_tickets(217)·support_messages(218)은 CS 에이전트 문맥 조립용으로 설계됐으나
--    어떤 라우트/lib 도 배선된 적이 없다(event-chatbot 은 event_inquiries 로 인입, 승격 미구현).
--    ⚠️ mig222 에서 support_messages.agent_run_id 컬럼은 이미 DROP 됨(AI 폐기 시).
--    FK 안전순서: 자식(support_messages) → 부모(support_tickets).
--
--    ℹ️ 보존(폐기 대상 아님):
--      - event_inquiries(mig189) = 라이브 문의 원장. 공개 이벤트 페이지 InquiryForm·챗봇
--        에스컬레이션이 실사용(public/inquiries·events/[id]/inquiries 라우트). CS 수렴층이 아님.
--      - event_inquiries.category/urgency(mig219, 원 계획의 "inquiry_classifications"):
--        별도 테이블이 아니라 라이브 원장의 passive 분류 컬럼. mig222 가 "향후 수동 분류 재사용"
--        근거로 명시 보존 → 본 마이그레이션도 유지(라이브 테이블 컬럼 DROP 회피).
DROP TABLE IF EXISTS support_messages CASCADE;
DROP TABLE IF EXISTS support_tickets CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) CRM(crm_contacts·crm_activities, mig106) — ⚠️ 이번 라운드 DROP 보류(BLOCKED).
--    사유: 발송(messaging) 세그먼트 해석기 src/lib/notification/recipients.ts 가 crm_contacts 를
--      (a) crmTiers/crmTags 세그먼트, (b) **모든 발송에 항상 적용되는 블랙리스트 제외(tier='blacklist')**
--      로 하드 참조한다. 이 파일은 메시징 이관 세션 소유(병행 이관중)라 본 세션이 편집 금지.
--    crm_contacts 를 지금 DROP 하면 recipients.ts 의 EXISTS 서브쿼리가 런타임에서
--      "relation does not exist" → **전 발송 경로 중단(Critical)**.
--    ✅ 이번 라운드 실행분: CRM 관리 route(events/[id]/crm) + 대시보드 UI + 사이드바/브레드크럼/
--       feature-toggle('crm') 삭제 → 신규 crm_contacts 유입 경로 제거(테이블은 read-only 잔존).
--    후속(메시징 세션 핸드오프): recipients.ts 의 crmTiers/crmTags/blacklist 로직을 v2 수신자
--       해석으로 재배선한 뒤 아래 2줄을 별도 마이그레이션에서 DROP.
-- DROP TABLE IF EXISTS crm_activities CASCADE;
-- DROP TABLE IF EXISTS crm_contacts CASCADE;
