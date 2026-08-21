-- 163: v2 BFF 통합 — organizer/team 매핑 컬럼 추가
-- v2 의 /internal/organizer/profiles/import + /internal/organizer/teams/import 호출 후
-- 응답으로 받은 v2 측 id 를 go DB 에 backfill.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS v2_organizer_profile_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_v2_organizer_profile_id
  ON accounts (v2_organizer_profile_id)
  WHERE v2_organizer_profile_id IS NOT NULL;

ALTER TABLE event_organizers
  ADD COLUMN IF NOT EXISTS v2_team_member_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_event_organizers_v2_team_member_id
  ON event_organizers (v2_team_member_id)
  WHERE v2_team_member_id IS NOT NULL;

-- 1:N owner 케이스 처리 위해 추가 컬럼:
-- 한 account 에 여러 user 가 owner role 인 경우, 첫 owner 만 organizer_profile.user_id 로,
-- 나머지는 team_members.v2_event_id=NULL 의 org-level 멤버십으로 들어감.
-- 그 추가 owner 들의 team_member_id 도 추적해야 향후 sync 가능.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS v2_team_member_id_owner UUID NULL;
