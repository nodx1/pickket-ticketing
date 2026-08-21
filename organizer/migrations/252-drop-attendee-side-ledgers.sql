-- 252 · 레벨2 컷오버 W5-ATTENDEE — 참석자 **부속 원장** 6종 go DROP
--
-- 🔴 적용 순서 (엄수): **organizer 배포 후에만 적용한다.**
--    이 마이그레이션 전에 배포돼야 하는 코드가 있다(아래 "코드 선행조건"). 코드보다 먼저
--    적용하면 구 코드가 없는 테이블을 읽어 초대권 발급·현장 체크인·설문이 즉시 500 이 된다.
--    또한 v2 alembic `w5att_0727`(대상 테이블 신설)이 **먼저** 적용돼 있어야 한다.
--      1) v2 alembic upgrade (w5att_0727)
--      2) organizer 배포 (아래 코드 선행조건 포함)
--      3) 이 마이그레이션(252)
--
-- ── 이관 대상 (go → v2, 데이터 폐기 아님) ──
--   go event_questions      → v2 event_questions      (+ archived_at soft delete)
--   go event_invitations    → v2 event_invitations
--   go invitation_dispatch  → v2 invitation_dispatch  (+ send_epoch = 안정 멱등키 시드)
--   go seat_watches         → v2 seat_watches
--   go check_in_lists       → v2 check_in_lists
--   go check_in_logs        → v2 check_in_logs        (+ UNIQUE(ticket_id, attended_date))
--
-- 대표 결정(2026-07-27): "A·B·C 다 살려서 간다" — 기능을 폐기하지 않는다. 6종 전부 v2 에
-- 자리를 만들어 옮겼고, 여기서는 **go 쪽 사본만** 제거한다.
--
-- ── 데이터 백필 없음 (의도) ──
-- 2026-07-27 대표 결정으로 prod 데이터를 전부 초기화하고 재개최한다(mig247 과 동일 전제).
-- 그래서 go→v2 행 복사를 하지 않는다. **만약 이 전제가 바뀌면 이 마이그레이션을 적용하기
-- 전에** 6개 테이블을 v2 로 복사해야 한다(특히 `event_questions.id` 는 이미 발권된
-- `tickets.answers` 의 키이므로 **id 를 그대로 승계**해야 한다 — 내부 API 의 `question_id`).
--
-- ── 코드 선행조건 (이 파일 적용 전에 배포돼 있어야 하는 것) ──
--   · src/lib/server/invitations.ts            → v2 초대 원장/발송 큐 API
--   · src/lib/server/events.ts                 → v2 문항 조회(체크아웃 상세)
--   · api/events/[eventId]/questions/**        → v2 문항 CRUD/순서
--   · api/events/[eventId]/check-in/**         → v2 명단 단건 + 로그 기록/삭제/CSV
--   · api/events/[eventId]/check-in-lists/**   → v2 명단 CRUD
--   · api/events/[eventId]/attendees/[id]      → v2 문항(보관 포함) + 티켓 단위 로그
--   · api/events/[eventId]/invitations/**      → v2 목록/집계·회수·재발송
--   · api/public/events/[slug]/seats/watch     → v2 좌석 찜
--   · api/cron/seat-watch-trigger              → v2 찜 후보/선점/해제
--   · api/cron/dispatch-invitations            → v2 발송 큐 드레인
--   · app/(public)/tickets/[ticketNumber]      → v2 초대 단건(딥링크 nonce 포함)
--   (검증: 위 파일들에 대해 go 테이블 SQL grep 0)
--
-- ── DROP 하지 않는 것 (중요) ──
--   · `invitations`  — **팀 멤버 초대**(mig001). 이름만 비슷할 뿐 전혀 다른 테이블이다.
--     go `users`/`accounts` 를 부모로 갖고(초대 수락 시 go users 행을 같은 트랜잭션에서
--     생성) role 도 go 조직 롤(admin/organizer/staff/check_in)이다. 계정/인증 도메인이
--     go 에 남아 있는 한 이것만 v2 로 옮기면 크로스 DB 경계가 생긴다 → 계정 트랙 소관.
--   · `attendees`    — 발송 세그먼트용 write 전용 투영 캐시(메시징/주문 트랙 소유).
--
-- ── DROP 순서: FK 리프 → 루트 ──
-- invitation_dispatch.invitation_id → event_invitations(id)
-- check_in_logs.check_in_list_id    → check_in_lists(id)
-- 나머지는 서로 참조 관계가 없다. CASCADE 로 잔여 의존 제약까지 함께 정리한다.
--
-- ── 재실행 안전성 ──
-- IF EXISTS + CASCADE. 이미 없는 환경(신규 DB)에서도 no-op.

DROP TABLE IF EXISTS invitation_dispatch CASCADE;
DROP TABLE IF EXISTS event_invitations CASCADE;
DROP TABLE IF EXISTS check_in_logs CASCADE;
DROP TABLE IF EXISTS check_in_lists CASCADE;
DROP TABLE IF EXISTS event_questions CASCADE;
DROP TABLE IF EXISTS seat_watches CASCADE;
