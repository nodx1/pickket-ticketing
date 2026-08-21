-- 249: 콘텐츠·표시 계열 6테이블 DROP (레벨2 컷오버 W5-CONTENT)
--
-- ⚠️⚠️ **적용 시점 — organizer 배포 "후"에만 적용한다** ⚠️⚠️
--   이 마이그레이션은 파괴적(DROP TABLE)이다. 아래 라우트들이 v2 로 전환된 코드가
--   **실제로 배포된 뒤에만** 적용하라. 배포 전에 적용하면 현행 코드가 즉시 500 을 낸다.
--   (가산적 마이그레이션 규약의 예외 — DROP 은 코드 선행이 강제된다.)
--
-- 전환 확인 대상(이 커밋에서 전부 v2 로 이관됨, go SQL 0건):
--   · src/app/api/events/[eventId]/widget-config/route.ts
--   · src/app/api/public/events/[slug]/widget-config/route.ts
--   · src/app/api/events/[eventId]/ticket-design/route.ts
--   · src/app/(public)/tickets/[ticketNumber]/page.tsx        (티켓 디자인 read)
--   · src/app/api/events/[eventId]/bridge-page/route.ts
--   · src/app/api/events/[eventId]/open-notices/route.ts
--   · src/app/api/events/[eventId]/open-notices/[noticeId]/route.ts
--   · src/lib/server/events.ts                                (공개 공지 read)
--   · src/app/api/events/[eventId]/facilities/route.ts
--   · src/app/api/events/[eventId]/facilities/[facilityId]/route.ts
--   · src/app/api/events/[eventId]/participants/route.ts
--   · src/app/api/events/[eventId]/participants/[participantId]/route.ts
--
-- 이관처(v2, alembic `w5cnt_0727`) — 기능은 하나도 폐기하지 않았다:
--   widget_configs      → organizer_widget_configs
--   ticket_designs      → organizer_ticket_designs
--   bridge_pages        → organizer_bridge_pages
--   open_notices        → organizer_open_notices
--   event_facilities    → organizer_event_facilities
--   event_participants  → organizer_event_participants
--
-- 선행 조건: v2 마이그 `w5cnt_0727` 선적용 + organizer 배포 완료.
-- 데이터 이관 없음 — 2026-07-27 대표 결정으로 prod 를 전면 초기화한다(백필·폴백 불필요).
--
-- 재실행 안전: IF EXISTS. CASCADE 는 이 테이블들을 참조하는 잔여 뷰/FK 까지 정리한다
-- (245/246 에서 부모 FK 는 이미 끊겼고, 이들을 참조하는 자식 테이블은 실측 0건).

BEGIN;

DROP TABLE IF EXISTS widget_configs CASCADE;
DROP TABLE IF EXISTS ticket_designs CASCADE;
DROP TABLE IF EXISTS bridge_pages CASCADE;
DROP TABLE IF EXISTS open_notices CASCADE;
DROP TABLE IF EXISTS event_facilities CASCADE;
DROP TABLE IF EXISTS event_participants CASCADE;

COMMIT;
