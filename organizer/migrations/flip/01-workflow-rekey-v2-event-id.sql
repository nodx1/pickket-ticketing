-- =============================================================================
-- DRAFT — 빅뱅 flip 전용 (자동실행 안 됨: migrations/flip/ 서브폴더라 runner 비수집)
-- 워크플로 테이블의 event_id FK(go events.id) → v2 canonical event_id 재키잉.
-- 블루프린트 §2-C. 커머스 테이블 DROP(§2-E) 전에 실행.
-- 전제: 기존 go 이벤트가 v2로 1회 이관되어 _event_v2_map 이 채워져 있어야 함(P2, go+v2).
-- 실데이터 0건 골든타임이라 단순 — 운영 데이터 쌓이기 전 실행 필수.
-- =============================================================================

BEGIN;

-- 0) 매핑 테이블 (데이터 이관 단계에서 채움: go_event_id → v2 canonical event_id)
CREATE TABLE IF NOT EXISTS _event_v2_map (
  go_event_id UUID PRIMARY KEY,
  v2_event_id UUID NOT NULL
);
-- (여기서 INSERT INTO _event_v2_map SELECT ... 은 이관 스크립트가 수행)

-- 1) 워크플로 테이블 재키잉: FK 제약 DROP → event_id 값을 v2 id로 치환.
--    seat_funnel_events 는 v2 소유로 이관(경계결정)이라 제외.
--    커머스 테이블(orders/products/attendees/...)은 §2-E 에서 통째 DROP 되므로 제외.
--    AI/지식 테이블(agent_runs·agent_tasks·ai_content_cache·ai_usage·event_context_snapshots·
--    knowledge_documents·public_chat_sessions)은 레벨2 영역B 에서 폐기(222-drop-ai-tables.sql 로 DROP)
--    되므로 재키잉 대상에서 제외한다(존재하지 않을 테이블 참조 회피).
DO $$
DECLARE
  t TEXT;
  fk TEXT;
  wf_tables TEXT[] := ARRAY[
    'crm_activities','email_campaigns','event_messages','inbound_emails',
    'bridge_pages','ticket_designs','widget_configs',
    'notifications','check_in_lists','event_questions','event_reviews'
  ];
BEGIN
  FOREACH t IN ARRAY wf_tables LOOP
    -- 테이블/컬럼 존재 확인(방어)
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = t AND column_name = 'event_id'
    ) THEN
      -- 1a) events(id) 참조 FK 제약 동적 DROP
      FOR fk IN
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
        WHERE tc.table_name = t
          AND tc.constraint_type = 'FOREIGN KEY'
          AND ccu.table_name = 'events'
      LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, fk);
      END LOOP;

      -- 1b) event_id 값을 v2 canonical id 로 치환(매핑된 것만)
      EXECUTE format(
        'UPDATE %I tgt SET event_id = m.v2_event_id
           FROM _event_v2_map m
          WHERE tgt.event_id = m.go_event_id', t);
    END IF;
  END LOOP;
END $$;

-- 2) 결과: 워크플로 테이블 event_id = v2 canonical UUID (go events FK 0).
--    이후 §2-E 에서 events 및 커머스 테이블 DROP 가능.
--    (_event_v2_map 은 external_ref 역참조용으로 잠시 보존 후 정리)

COMMIT;

-- ROLLBACK 가이드: 빅뱅은 PR revert + 이전 이미지 재배포가 롤백. 실데이터 0건이라 데이터 롤백 불요.
