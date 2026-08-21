-- =============================================================================
-- 빅뱅 flip — events 앵커화 (Slice A: 이벤트 write-through 전환 토대)
-- go events 테이블을 thin 앵커(go id ↔ v2 canonical event_id 매핑)로 강등.
--
-- 배경:
--   커머스 SoT 가 v2 로 이전됨에 따라 go events 행은 더 이상 커머스 정본이 아니다.
--   다만 워크플로 테이블(event_organizers / notifications / event_reviews / agent_* ...)이
--   events.id 를 FK 로 참조하므로 go events 행 자체는 **유지**한다(삭제 금지).
--   대신 v2 canonical event_id 를 v2_event_id 에 보관하여 write-through 호출의 앵커로 쓴다.
--
-- 이 마이그레이션이 하는 일:
--   1) events.v2_event_id 컬럼 추가 (v2 canonical UUID 보관).
--   2) 개설 시 v2 가 SoT 인 커머스 컬럼들을 nullable 화 → go INSERT 가 최소 컬럼만 채워도 되게.
--      (title 처럼 워크플로/대시보드 라벨에 쓰이는 컬럼은 NOT NULL 유지)
--
-- 안전: 모두 IF EXISTS / DROP NOT NULL 이라 재실행 안전. 실데이터 0건 골든타임 기준.
-- =============================================================================

BEGIN;

-- 1) v2 canonical event_id 앵커 컬럼
ALTER TABLE events ADD COLUMN IF NOT EXISTS v2_event_id UUID;

-- external_ref(go id) ↔ v2 id 역참조 및 멱등 재호출용 인덱스
CREATE INDEX IF NOT EXISTS idx_events_v2_event_id ON events (v2_event_id);

-- 2) v2 가 SoT 인 커머스/일정 컬럼 nullable 화.
--    go 개설 INSERT 는 앵커(id, account_id, organizer_id, title, slug, status)만 확정하고
--    나머지 커머스 상세는 v2 가 보관 → go 컬럼은 표시 캐시/없어도 무방하게 강등.
--    title/slug/status 는 워크플로·대시보드·URL 에 필요하므로 NOT NULL 유지.
ALTER TABLE events ALTER COLUMN starts_at  DROP NOT NULL;
ALTER TABLE events ALTER COLUMN ends_at    DROP NOT NULL;
ALTER TABLE events ALTER COLUMN event_type DROP NOT NULL;
ALTER TABLE events ALTER COLUMN age_rating DROP NOT NULL;

COMMIT;

-- ROLLBACK 가이드: 빅뱅은 PR revert + 이전 이미지 재배포가 롤백.
-- 컬럼만 되돌리려면: ALTER TABLE events DROP COLUMN v2_event_id; 및 각 컬럼 SET NOT NULL.
