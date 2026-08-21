-- 090: agent_tasks 유니크 제약 + 알림 타입 확장
-- 같은 이벤트에 같은 태스크가 중복 등록되지 않도록

ALTER TABLE agent_tasks
  ADD CONSTRAINT agent_tasks_account_event_type_unique
  UNIQUE (account_id, event_id, task_type);

-- notifications.type 컬럼에 ai_review, ai_complete 값 허용
-- (type이 text이므로 별도 DDL 불필요, 참조용 코멘트)
COMMENT ON COLUMN notifications.type IS 'refund_request | sold_out | payment_failed | new_order | check_in_milestone | system | ai_review | ai_complete';
