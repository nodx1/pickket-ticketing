-- H-01: 발송 전 'sending' 선기록으로 크래시 창(외부 발송 성공 → DB 기록 전 프로세스 종료 → 재실행 시
-- 재발송) 을 봉쇄한다. 선기록된 'sending' 은 재실행의 done-set 에 포함되어 이중 발송을 막고,
-- 확정 결과는 reconcile-deliveries(DLR 대사)가 sent/failed 로 정정한다. 'unknown' 은 타임아웃 등 불확실.
ALTER TABLE message_deliveries DROP CONSTRAINT IF EXISTS message_deliveries_status_check;
ALTER TABLE message_deliveries ADD CONSTRAINT message_deliveries_status_check
  CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'failed', 'skipped', 'unknown'));
