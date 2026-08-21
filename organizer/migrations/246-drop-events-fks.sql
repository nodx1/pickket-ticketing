-- 246: go events 를 참조하는 FK 전량 제거 (레벨2 컷오버 W4-EVT — 이벤트 도메인 v2 이관 완료분 반영)
--
-- 왜 필요한가
--   이벤트 생성은 이미 **v2 가 SSOT** 다. `POST /api/events` 는 v2 `createEvent` 만 호출하고
--   go `events` 에는 **아무 행도 만들지 않는다**(마이그 240·W2-EVT 이후 go events 는 write 0).
--   W4-EVT 로 마지막 read(공개 상세·위젯·수신함/심사/리허설/응모현황 소유검증)까지 v2 로 옮겨,
--   `organizer/src` 의 go `events` SQL 은 **0 건**이 됐다(cron/reminders 는 별도 트랙).
--
--   그런데 go 앵커 테이블들(orders·attendees·products·event_questions…)은 여전히 `event_id` 를
--   기록하며 그 컬럼에 `events(id)` FK 가 걸려 있다. go events 가 영구히 비어 있는 상태에서
--   주문/참석자를 만들면 **FK 위반으로 주문 생성 자체가 실패**한다.
--   (245 가 accounts/users 에 대해 닫은 것과 완전히 같은 구멍이다.)
--
--   ⟹ 죽은 부모(events)에 대한 FK 를 끊는다. `event_id` **컬럼과 값은 그대로 유지**하므로
--      이벤트 스코프 질의는 전부 정상 동작한다. 존재/소유 검증은 v2 `organizer_ref` 가 한다.
--
-- ⚠️ 이 마이그레이션은 go events TRUNCATE/DROP 의 **선행 조건**이다. 순서를 바꾸면
--    TRUNCATE 가 FK 때문에 실패하거나 CASCADE 로 전 테이블이 함께 지워진다.
--
-- ⚠️ ON DELETE CASCADE 소실: 옛 FK 다수가 CASCADE 였다(이벤트 삭제 → 자식 행 정리).
--    go events 에 행이 생기지 않으므로 그 CASCADE 는 이미 발동할 일이 없다. 이벤트 삭제의
--    자식 정리 책임은 v2 및 각 도메인 라우트에 있다.
--
-- 🔴 데이터 이관·백필 없음 — 2026-07-27 대표 결정(prod 전량 초기화 후 재개최)에 따른다.
--
-- 재실행 안전: information_schema 기준 동적 DROP + IF EXISTS. 두 번째 실행은 no-op.

BEGIN;

-- ── events 를 참조하는 FK 전량 (2026-07-27 기준 46개 테이블) ──────────────────
--   affiliates agent_runs agent_tasks ai_content_cache ai_usage allocation_sessions
--   attendees bridge_pages capacity_assignments check_in_lists crm_activities
--   discount_info email_campaigns event_context_snapshots event_facilities
--   event_inquiries event_messages event_organizers event_participants event_questions
--   event_reviews event_schedules final_call_rules group_bookings inbound_emails
--   knowledge_documents notifications open_notices orders product_categories products
--   promo_codes public_chat_sessions queue_sessions refund_policies sale_phases
--   seat_funnel_events seat_maps seat_tiers seat_watches settlements support_tickets
--   ticket_designs waitlist_entries webhooks widget_configs
--
-- 이름을 하드코딩하지 않고 카탈로그에서 훑는다 — 일부 테이블은 이미 선행 웨이브에서 DROP 됐고
-- (event_schedules/event_organizers = 마이그 240 등) 제약 이름도 마이그레이션마다 제각각이라,
-- 명시 목록은 "빠뜨렸는데 초록불"이 되기 쉽다. 아래 검증 블록이 0 을 강제한다.
DO $$
DECLARE
  fk RECORD;
  dropped int := 0;
BEGIN
  FOR fk IN
    SELECT con.conname, con.conrelid::regclass AS child
    FROM pg_constraint con
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace pn ON pn.oid = parent.relnamespace
    WHERE con.contype = 'f'
      AND parent.relname = 'events'
      AND pn.nspname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', fk.child, fk.conname);
    dropped := dropped + 1;
  END LOOP;
  RAISE NOTICE '246: events 참조 FK % 개 제거', dropped;
END $$;

-- 검증: events 를 참조하는 FK 가 0 이어야 한다.
DO $$
DECLARE remaining int;
BEGIN
  SELECT count(*) INTO remaining
  FROM pg_constraint con
  JOIN pg_class parent ON parent.oid = con.confrelid
  JOIN pg_namespace pn ON pn.oid = parent.relnamespace
  WHERE con.contype = 'f' AND parent.relname = 'events' AND pn.nspname = 'public';

  IF remaining > 0 THEN
    RAISE EXCEPTION '246: events 참조 FK 가 % 개 남았다 — TRUNCATE/DROP 전에 해소해야 한다', remaining;
  END IF;
END $$;

COMMIT;
