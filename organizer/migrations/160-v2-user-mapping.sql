-- 160: v2 BFF 통합 — go users 와 v2 users 매핑 컬럼 추가
-- v2 의 /api/v1/internal/users/import 호출 후 응답으로 받은 v2_user_id 저장.
-- 작업 4 (token verify) 이후 v2 토큰의 user_id 와 매칭하는 데도 사용.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS v2_user_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_users_v2_user_id
  ON users (v2_user_id)
  WHERE v2_user_id IS NOT NULL;

-- organizer 정보도 v2 에 함께 import 되므로 organizers 에도 추적 컬럼.
-- (한 user 가 여러 organizer 보유 가능하므로 별개 컬럼)
ALTER TABLE organizers
  ADD COLUMN IF NOT EXISTS v2_user_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_organizers_v2_user_id
  ON organizers (v2_user_id)
  WHERE v2_user_id IS NOT NULL;
