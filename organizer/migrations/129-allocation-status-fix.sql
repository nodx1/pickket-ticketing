-- allocation_sessions.status CHECK 제약에 'allocating' 추가
-- 기존: draft, open, closed, allocated, cancelled
-- 추가: allocating (할당 진행 중 상태)
ALTER TABLE allocation_sessions DROP CONSTRAINT IF EXISTS allocation_sessions_status_check;
ALTER TABLE allocation_sessions ADD CONSTRAINT allocation_sessions_status_check
  CHECK (status IN ('draft', 'open', 'closed', 'allocating', 'allocated', 'cancelled'));
