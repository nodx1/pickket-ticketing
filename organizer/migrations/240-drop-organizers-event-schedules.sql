-- 240: 레벨2 컷오버 W2-EVT — go `organizers` / `event_organizers` / `event_schedules` DROP.
--
-- ── 무엇이 어디로 갔나 ──────────────────────────────────────────────────────
--  · organizers        → v2 `event_hosts`        (alembic `w2evt_0727`)
--  · event_organizers  → v2 `event_host_links`   (alembic `w2evt_0727`)
--  · event_schedules   → v2 `events.event_schedules` (JSONB. 컬럼은 1-S 에서 이미 존재)
--
-- v2 `organizer_profiles`/`organizer_team_members` 와 혼동 금지 — 그쪽은 v2 user 기반
-- 사업자 프로필/협업자이고, 여기 옮긴 것은 **v2 계정이 없는 주최자 표기 엔티티**다.
--
-- ── 코드 측 선행 조건 (이 마이그 적용 **전에** 배포되어야 함) ────────────────
--   · /api/organizers, /api/organizers/[id]            → v2 event-hosts API 프록시
--   · /api/events (목록·생성), /api/events/[id] (상세·수정·보관)
--   · /api/events/[id]/{settings,publish-check,duplicate,purge,restore,landing,
--     homepage-design,sale-channels,organizers,schedules,schedules/[id]}
--   · lib/server/events.ts `getEventSummary` · lib/v2/{event-view,event-schedules}.ts
--   · lib/v2/organizer-sync.ts `pushTeamMemberToV2` = no-op 화
--   · lib/organizer-slug.ts   → v2 목록 기반 slug 생성
--
-- ── 🔴 미해결 차단 요인 (W2-EVT 범위 밖 — 이 마이그 적용 전에 반드시 처리) ──────
-- 아래 2개 라우트가 아직 go `organizers`/`event_organizers`/`events.organizer_id` 를 SQL 로 읽는다.
-- 지금 이 마이그를 적용하면 **런타임에 즉시 깨진다**:
--   · organizer/src/app/api/events/[eventId]/og-image/route.ts   (주최자명 OG 이미지)
--   · organizer/src/app/api/public/events/route.ts               (공개 이벤트 목록 organizerName)
-- 대체 경로는 이미 있다 — `listEventHostLinks(accountId, eventId)` /
-- `batchEventHostLinks(accountId, eventIds)` (`lib/v2/commerce-client.ts`).
--
-- 폐기 예정 레거시 스크립트(적용 후 동작 불가 — 함께 정리):
--   organizer/scripts/{v2-import-organizers,v2-import-users,inspect-cleanup,backfill-v2-gap-fields}.ts
--   organizer/scripts/seed.ts (organizers INSERT)
--
-- 검증(코드):
--   grep -rEIn '(FROM|JOIN|INTO|UPDATE)[[:space:]]+(public\.)?(organizers|event_organizers|event_schedules)\b' \
--        organizer/src organizer/scripts
--   → migrations/ · 주석 · 백필 스크립트를 제외하고 0 건이어야 한다.
--
-- ── 🔴 데이터 백필 선행 (이 마이그의 진짜 전제) ─────────────────────────────
-- 스키마만 옮긴다고 데이터가 따라가지 않는다. 반드시 **먼저** 실행:
--     npx tsx organizer/scripts/backfill-w2evt-hosts.ts            # dry-run(기본)
--     npx tsx organizer/scripts/backfill-w2evt-hosts.ts --apply    # 실제 전송
-- 스크립트가 실패 건수 0 을 보고해야 한다. 실패가 남으면 **그 계정의 주최자 표기가 통째로 유실**된다
-- (특히 v2 `organizer_profiles.go_account_id` 매핑이 없는 go account).
--
-- 사전 조사(백필 전 필수) — host 역할이 하나도 없는 이벤트는 v2 PUT 이 400 을 낸다:
--   SELECT event_id FROM event_organizers
--    GROUP BY event_id HAVING count(*) FILTER (WHERE role = 'host') = 0;
--
-- ── 안전장치 ────────────────────────────────────────────────────────────────
-- 아래 DO 블록은 "행이 남아 있는데 백필 완료 선언이 없으면" 예외를 던져 트랜잭션을 되돌린다
-- (migrate.ts 는 파일 단위 BEGIN/COMMIT — 예외 시 ROLLBACK 되어 아무것도 지워지지 않는다).
-- 백필을 끝냈다면 같은 세션에서 선언하고 실행한다:
--     SET pickket.w2evt_backfill_done = '1';
-- 빈 테이블(신규/개발 DB)이면 선언 없이도 그대로 통과한다.
--
-- ⚠️ 비가역. 적용 전 pg_dump 백업 + 롤백 태그.

DO $$
DECLARE
  v_orgs bigint := 0;
  v_links bigint := 0;
  v_sched bigint := 0;
  v_declared text := coalesce(current_setting('pickket.w2evt_backfill_done', true), '');
BEGIN
  IF to_regclass('public.organizers') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM organizers' INTO v_orgs;
  END IF;
  IF to_regclass('public.event_organizers') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM event_organizers' INTO v_links;
  END IF;
  IF to_regclass('public.event_schedules') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM event_schedules' INTO v_sched;
  END IF;

  IF (v_orgs + v_links + v_sched) > 0 AND v_declared <> '1' THEN
    RAISE EXCEPTION
      'W2-EVT DROP 차단: 아직 데이터가 남아 있습니다 (organizers=%, event_organizers=%, event_schedules=%). '
      'organizer/scripts/backfill-w2evt-hosts.ts --apply 로 v2 이관을 끝낸 뒤 '
      '같은 세션에서 SET pickket.w2evt_backfill_done = ''1''; 을 선언하고 다시 실행하세요.',
      v_orgs, v_links, v_sched;
  END IF;
END $$;

-- FK 리프 → 루트 순서. event_organizers 는 organizers/events 를 참조한다.
DROP TABLE IF EXISTS event_organizers CASCADE;
DROP TABLE IF EXISTS event_schedules CASCADE;

-- organizers 를 참조하던 events.organizer_id(레거시 단일 주최자 컬럼)도 함께 정리한다.
-- CASCADE 로 FK 만 사라지고 컬럼이 남으면, 코드가 읽지 않는 죽은 UUID 가 영구히 남는다.
ALTER TABLE IF EXISTS events DROP COLUMN IF EXISTS organizer_id;

DROP TABLE IF EXISTS organizers CASCADE;
