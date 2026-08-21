-- 253: 레벨2 컷오버 W5-SUPPORT — go 지원(support) 계열 테이블 DROP.
--
-- ⚠️⚠️ **organizer 배포 후에만 적용한다.** ⚠️⚠️
-- 이 마이그레이션은 코드가 이미 v2 로 전환된 뒤를 전제한다. 배포 전에 적용하면
-- 알림 인박스·문의함·심사 이력·용량 배정·파이널콜·제휴 생성이 **즉시 런타임 오류**가 된다.
-- 적용 순서: (1) alembic `w5sup_0727` → (2) organizer 배포 → (3) 이 마이그.
--
-- ── 무엇이 어디로 갔나 ──────────────────────────────────────────────────────
--  · notifications        → v2 `organizer_notifications`      (alembic `orgmsg_0724` + 146 CHECK 확장은 `w5sup_0727`)
--  · event_reviews        → v2 `event_publication_reviews`    (alembic `w5sup_0727`)
--  · event_inquiries      → v2 `event_inquiries`              (alembic `w5sup_0727`)
--  · capacity_assignments → v2 `capacity_assignments`         (alembic `w5sup_0727`)
--  · final_call_rules     → v2 `final_call_rules`             (alembic `w5sup_0727`)
--  · affiliates / affiliate_conversions → v2 `affiliates` / `affiliate_conversions`
--      (v2 정본은 이미 있었고 go 행은 앵커/미러였다. read-flip 은 선행 트랙에서 완료,
--       이번에 남은 **앵커 write** 를 걷어냈다.)
--
-- 🔴 동명 다개념 주의 — v2 에서 재사용하지 **않은** 이유
--   · v2 `reviews`      = 관람객 후기. go `event_reviews`(게시 심사 원장)와 완전히 다른 개념.
--     합치면 "후기 1건 = 승인 1건"이 되어 **미심사 이벤트가 공개**된다 → 별도 테이블 신설.
--   · v2 `final_calls`  = 확정된 실행 인스턴스(할인가·오픈일시·status).
--     go `final_call_rules`(발동 규칙 설정)와 1:N 관계라 1:1 매핑 불가 → 별도 테이블 신설.
--
-- ── 코드 측 선행 조건 (이 마이그 적용 **전에** 배포되어야 함) ────────────────
--   · /api/notifications, /api/notifications/[id], /api/notifications/unread-count
--   · /api/events/[id]/reviews · /api/events/[id]/inquiries · /api/public/inquiries
--   · /api/events/[id]/capacity · /api/events/[id]/final-call
--   · /api/events/[id]/affiliates · /api/events/[id]/affiliates/[affiliateId]
--   · /api/events/[id] (pending_review 심사 이력 기록)
--   · /api/v2-webhook/events/[id]/review-result (심사 이력 + 주최자 알림)
--   · lib/notifications/create.ts · lib/notifications/seat-channels.ts
--
-- 검증(코드) — 주석 제외 0 건이어야 한다:
--   grep -rEn '(FROM|INTO|UPDATE|JOIN) +(notifications|event_reviews|event_inquiries|capacity_assignments|final_call_rules|affiliates)\b' \
--        organizer/src --include=*.ts | grep -v '\.test\.'
--
-- ── 폐기 예정 레거시 스크립트 (적용 후 동작 불가 — 별도 정리 필요, 런타임 경로 아님) ──
--   organizer/scripts/sync-event3-status.ts    (event_reviews INSERT — 일회성 수동 보정)
--   organizer/scripts/check-event-status.ts    (event_reviews SELECT — 진단용)
--   organizer/scripts/check-webhook-logs.ts    (event_reviews SELECT — 진단용)
--   organizer/scripts/backfill-support-tickets.ts (event_inquiries → support_tickets 일회성 백필)
-- prod 전면 초기화로 백필 대상 자체가 사라지므로 실행할 일이 없다.
--
-- ── 데이터 백필 ─────────────────────────────────────────────────────────────
-- **불요.** prod 는 컷오버와 함께 전면 초기화된다(대표 결정 2026-07-27). 최종형만 남긴다.
--
-- 안전: 전부 IF EXISTS — 재실행 안전.
-- ROLLBACK: 빅뱅 revert + 이전 이미지 재배포. 스키마만 되돌리려면 152/189/219/033/107/052/073/146
--           원문 DDL 을 재적용해야 한다(데이터는 복구되지 않는다).
-- =============================================================================

BEGIN;

-- affiliate_conversions 가 affiliates(id) 를 FK 참조하므로 자식 먼저 DROP.
-- (CASCADE 대신 명시 순서 — 예상 못 한 다른 자식이 있으면 오류로 드러나게 한다.)
DROP TABLE IF EXISTS affiliate_conversions;
DROP TABLE IF EXISTS affiliates;

DROP TABLE IF EXISTS capacity_assignments;
DROP TABLE IF EXISTS final_call_rules;
DROP TABLE IF EXISTS event_inquiries;
DROP TABLE IF EXISTS event_reviews;
DROP TABLE IF EXISTS notifications;

COMMIT;
