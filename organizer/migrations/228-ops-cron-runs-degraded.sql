-- 228: ops_cron_runs 에 'degraded' 상태 추가(레벨2 재감사 P1).
--
-- payment-reconcile cron 이 예외로 죽지는 않았지만 미복구분(재confirm 실패·manual_review·
-- orphan 조회실패 등)이 남은 경우를 'succeeded' 로 위장하지 않고 'degraded' 로 전파한다.
-- 크래시('failed')와 부분성공('degraded')을 구분해 알림/대시보드가 정확히 반응하도록 한다.
-- 가산적: 기존 상태값 보존, CHECK 만 확장.

ALTER TABLE ops_cron_runs
  DROP CONSTRAINT IF EXISTS ck_ops_cron_runs_status;

ALTER TABLE ops_cron_runs
  ADD CONSTRAINT ck_ops_cron_runs_status
  CHECK (status IN ('running', 'succeeded', 'failed', 'degraded'));
